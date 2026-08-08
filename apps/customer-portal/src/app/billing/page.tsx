"use client";

import React from 'react';
import { CreditCard, Plus, Clock, ShieldCheck, Zap, ArrowUpRight, DollarSign, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createPaymentMethodVerification, fetchBillingInfo, getInvoiceDownloadUrl, updateBillingSettings, verifyPaymentMethod } from '@/lib/api/billing';
import { toast } from 'sonner';
import FlashLoader from '@/components/ui/flash-loader';
import { useAuthStore } from '@/store/auth-store';
import RechargeModal from '@/components/billing/RechargeModal';
import PlanSelectionModal from '@/components/billing/PlanSelectionModal';

const BILLING_PAGE_LOADED_AT = Date.now();

export default function BillingPage() {
    const router = useRouter();
    const { fetchSession, user, workspace } = useAuthStore();
    const { data: billing, isLoading, refetch } = useQuery({
        queryKey: ['billing'],
        queryFn: fetchBillingInfo
    });

    const [isRechargeOpen, setIsRechargeOpen] = React.useState(false);
    const [isPlanSelectionOpen, setIsPlanSelectionOpen] = React.useState(false);
    const [isAddingPaymentMethod, setIsAddingPaymentMethod] = React.useState(false);

    // The header reads the global wallet store while this page reads the
    // ledger-backed billing snapshot. Keep the single displayed balance in
    // sync whenever a fresh billing response arrives.
    React.useEffect(() => {
        if (!billing?.wallet) return;
        useAuthStore.setState((state) => ({
            wallet: {
                ...state.wallet,
                balance: billing.wallet.balance,
                currency: billing.wallet.currency || state.wallet.currency,
                thresholdAmount: billing.wallet.thresholdAmount ?? state.wallet.thresholdAmount,
                isServiceDown: billing.wallet.isServiceDown,
            },
        }));
    }, [billing?.wallet]);

    if (isLoading) return <FlashLoader />;

    const handlePlanChanged = async () => {
        await refetch();
        await fetchSession(true);
    };

    const wallet = billing?.wallet || { balance: 0, currency: 'INR', status: 'active' };
    const billingPlan = billing?.plan || { name: 'Free', limits: {}, usage: {}, slug: 'free' };
    const plan = billingPlan;
    const subscription = billing?.subscription || { autoPay: true, taxId: '' };
    const transactions = billing?.transactions || [];

    // Helper to calculate days remaining until next billing event
    const getDaysRemaining = () => {
        if (!subscription.billingPivotDate) return 30; // Default fallback
        const pivot = new Date(subscription.billingPivotDate);
        const diff = pivot.getTime() - BILLING_PAGE_LOADED_AT;
        return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    };

    const handleAddPaymentMethod = async () => {
        if (billing?.payment?.enabled !== true) {
            toast.error('Online payments are temporarily unavailable. Please contact support.');
            return;
        }

        setIsAddingPaymentMethod(true);
        try {
            // 1. Create Verification Order (₹1)
            const orderData: any = await createPaymentMethodVerification();

            // 2. Open Razorpay Checkout
            const options = {
                key: orderData.keyId,
                amount: orderData.amount,
                currency: orderData.currency,
                name: "wApi Platform",
                description: "Verify & Save Payment Method",
                order_id: orderData.orderId,
                handler: async function (response: any) {
                    try {
                        // 3. Verify & Save
                        await verifyPaymentMethod({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature
                        });

                        toast.success('Payment method added successfully!');
                        refetch();
                    } catch (err: any) {
                        toast.error('Failed to verify payment method');
                    } finally {
                        setIsAddingPaymentMethod(false);
                    }
                },
                prefill: {
                    name: "",
                    email: "",
                    contact: ""
                },
                theme: {
                    color: "#0f172a"
                },
                modal: {
                    ondismiss: function () {
                        setIsAddingPaymentMethod(false);
                    }
                }
            };

            const rzp = new (window as any).Razorpay(options);
            rzp.open();
        } catch (err) {
            toast.error('Failed to initiate payment method verification');
            setIsAddingPaymentMethod(false);
        }
    };

    const daysRemaining = getDaysRemaining();

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8 pb-20">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-4xl font-black tracking-tight text-foreground uppercase">Billing & Plans</h1>
                    <p className="text-muted-foreground mt-1 font-medium italic">Manage your workspace subscription, wallet, and invoices.</p>
                </div>
                <div className="flex gap-3">
                    <Button
                        variant="outline"
                        onClick={() => setIsPlanSelectionOpen(true)}
                        className="rounded-full px-6 font-bold border-border/50 bg-background hover:bg-muted"
                    >
                        Change Plan
                    </Button>
                    <Button
                        className="rounded-full px-6 bg-primary hover:bg-primary/90 shadow-lg shadow-primary/20 font-bold"
                        onClick={handleAddPaymentMethod}
                        disabled={isAddingPaymentMethod || billing?.payment?.enabled !== true}
                    >
                        {isAddingPaymentMethod ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="mr-2 h-4 w-4" />}
                        Add Payment Method
                    </Button>
                </div>
            </div>

            {/* Financial Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="border-none bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-[32px] overflow-hidden relative group">
                    <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-110 transition-transform">
                        <DollarSign className="w-24 h-24" />
                    </div>
                    <CardContent className="p-8 space-y-4">
                        <Badge className="bg-white/10 text-white border-white/20 px-3 py-0.5 rounded-full font-black text-[10px] tracking-widest uppercase">Wallet Balance</Badge>
                        <div className="space-y-1">
                            <p className="text-4xl font-black">{wallet.currency} {wallet.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                            <p className="text-xs text-slate-400 font-medium">Credits refresh automatically on recharge.</p>
                        </div>
                        <Button
                            className="w-full bg-white text-slate-900 hover:bg-slate-100 font-black rounded-2xl h-12 text-xs uppercase tracking-widest"
                            onClick={() => setIsRechargeOpen(true)}
                            disabled={billing?.payment?.enabled !== true}
                        >
                            Add Credits <ArrowUpRight className="ml-2 h-4 w-4" />
                        </Button>
                    </CardContent>
                </Card>

                <Card className="border-none bg-card ring-1 ring-border/50 shadow-sm rounded-[32px] p-8 flex flex-col justify-between">
                    <div className="space-y-2">
                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Current Plan</p>
                        <h3 className="text-2xl font-black text-foreground capitalize">{plan.name}</h3>
                        <div className="flex flex-col gap-2 items-start">
                            <Badge variant="outline" className={`border-none px-3 py-1 font-bold rounded-full ${subscription.autoPay ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                {subscription.autoPay ? 'Auto-renewing' : 'Manual Renewal'}
                            </Badge>
                            {subscription.billingPivotDate && (
                                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                                    Next Charge: {new Date(subscription.billingPivotDate).toLocaleDateString()}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground font-medium">
                        <Clock className="h-4 w-4" /> Usage reset in {daysRemaining} days
                    </div>
                </Card>

                <Card className="border-none bg-card ring-1 ring-border/50 shadow-sm rounded-[32px] p-8 space-y-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <ShieldCheck className="h-6 w-6" />
                        </div>
                        <div>
                            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Payment Status</p>
                            <p className="text-sm font-bold text-foreground">{wallet.status === 'past_due' ? 'Action Required' : 'Verified'}</p>
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        onClick={() => {
                            document.getElementById('billing-settings')?.scrollIntoView({ behavior: 'smooth' });
                        }}
                        className="w-full rounded-2xl border border-dashed border-border text-xs font-bold uppercase tracking-widest text-muted-foreground hover:bg-muted/50"
                    >
                        Manage Billing
                    </Button>
                </Card>
            </div>

            {/* Plan Details Concept */}
            <div className="bg-card border border-border/50 rounded-[48px] overflow-hidden shadow-sm">
                <div className="bg-muted/30 p-8 border-b border-border/10 flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-black text-foreground">Usage Summary</h2>
                        <p className="text-xs text-muted-foreground font-medium">Real-time platform resource utilization</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => document.getElementById('billing-transactions')?.scrollIntoView({ behavior: 'smooth' })} className="rounded-xl font-bold bg-background">View Detailed Logs</Button>
                </div>
                <div className="p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
                    {[
                        { label: 'Active Contacts', used: plan.usage?.contacts || 0, limit: plan.limits?.maxContacts || 1000, icon: Zap },
                        { label: 'Cloud Messages', used: plan.usage?.messages || 0, limit: plan.limits?.maxMessages || 10000, icon: Zap },
                        { label: 'Automations', used: plan.usage?.automations || 0, limit: plan.limits?.maxAutomations || 5, icon: Zap },
                        { label: 'Active Deals', used: plan.usage?.deals || 0, limit: plan.limits?.maxActiveDeals || 10, icon: Zap },
                    ].map((stat, i) => {
                        const percent = Math.min(100, (stat.used / (stat.limit || 1)) * 100);
                        const isNearLimit = percent >= 90;
                        const isOverLimit = stat.limit !== Infinity && stat.used >= stat.limit;

                        return (
                            <div key={i} className="space-y-3 p-4 rounded-2xl transition-colors hover:bg-muted/30">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <stat.icon className={`h-3 w-3 ${isOverLimit ? 'text-rose-500' : isNearLimit ? 'text-amber-500' : 'text-primary'}`} />
                                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{stat.label}</span>
                                    </div>
                                    {isOverLimit && <Badge className="bg-rose-500/10 text-rose-500 border-none text-[8px] px-1.5 h-4">Exceeded</Badge>}
                                </div>
                                <div className="flex items-end gap-1">
                                    <span className={`text-xl font-black ${isOverLimit ? 'text-rose-600' : ''}`}>{stat.used.toLocaleString()}</span>
                                    <span className="text-xs text-muted-foreground font-medium mb-1">/ {stat.limit === Infinity || stat.limit === -1 || stat.limit === 0 ? '∞' : stat.limit.toLocaleString()}</span>
                                </div>
                                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                    <div
                                        className={`h-full transition-all duration-1000 ${isOverLimit ? 'bg-rose-500' : isNearLimit ? 'bg-amber-500' : 'bg-primary'}`}
                                        style={{ width: `${percent}%` }}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Transactions Section */}
            <div id="billing-transactions" className="space-y-4">
                <div className="flex items-center justify-between px-4">
                    <h3 className="text-lg font-black tracking-tight uppercase">Recent Transactions</h3>
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest italic">Last 20 events</p>
                </div>
                {transactions.length === 0 ? (
                    <div className="bg-muted/20 border border-dashed border-border/50 rounded-[40px] p-20 flex flex-col items-center text-center space-y-4">
                        <div className="w-20 h-20 rounded-[28px] bg-background flex items-center justify-center text-muted-foreground/30 shadow-inner">
                            <CreditCard className="h-10 w-10" />
                        </div>
                        <h3 className="text-2xl font-bold tracking-tight text-foreground">No recent activity</h3>
                        <p className="text-muted-foreground max-w-sm mx-auto">
                            Your transaction history is currently empty. Recharges and spends will appear here.
                        </p>
                    </div>
                ) : (
                    <div className="bg-card border border-border/50 rounded-[32px] overflow-hidden">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-muted/30 border-b border-border/50">
                                    <th className="p-4 text-[10px] font-black uppercase tracking-widest">Type</th>
                                    <th className="p-4 text-[10px] font-black uppercase tracking-widest">Description / Invoice</th>
                                    <th className="p-4 text-[10px] font-black uppercase tracking-widest text-right">Amount</th>
                                    <th className="p-4 text-[10px] font-black uppercase tracking-widest text-right">Date</th>
                                </tr>
                            </thead>
                            <tbody>
                                {transactions.map((tx: any) => (
                                    <tr key={tx._id} className="border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors">
                                        <td className="p-4 whitespace-nowrap">
                                            <Badge className="rounded-lg text-[9px] font-black uppercase">{tx.type}</Badge>
                                        </td>
                                        <td className="p-4">
                                            <div className="flex flex-col gap-1">
                                                <span className="text-xs font-bold text-foreground">{tx.description || tx.referenceType}</span>
                                                {tx.invoiceNumber && (
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[9px] font-black text-primary uppercase tracking-tight">Invoice: {tx.invoiceNumber}</span>
                                                        <a
                                                            href={getInvoiceDownloadUrl(tx.invoiceNumber)}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-[9px] bg-primary/10 hover:bg-primary/20 text-primary px-2 py-0.5 rounded flex items-center font-bold transition-colors"
                                                            title="Download Invoice"
                                                        >
                                                            Download
                                                        </a>
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-4 text-xs font-bold text-right tabular-nums">
                                            {tx.type === 'SPEND' ? '-' : '+'}{wallet.currency} {tx.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </td>
                                        <td className="p-4 text-xs font-medium text-muted-foreground text-right border-l border-border/10">
                                            {new Date(tx.createdAt).toLocaleDateString()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Billing Settings / Manage Billing */}
            <div id="billing-settings" className="scroll-mt-10">
                <Card className="border-none bg-card ring-1 ring-border/50 shadow-xl rounded-[40px] overflow-hidden">
                    <div className="bg-muted/30 p-8 border-b border-border/10 flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-black text-foreground uppercase tracking-tight">Billing & Security Control</h2>
                            <p className="text-xs text-muted-foreground font-medium">Manage your subscription lifecycle and tax preferences.</p>
                        </div>
                        <Badge className="bg-emerald-500/10 text-emerald-600 border-none font-bold px-3 py-1">Secure Environment</Badge>
                    </div>
                    <CardContent className="p-8 space-y-10">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                            {/* Autopay Control */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-0.5">
                                        <h4 className="text-sm font-black uppercase tracking-wide text-foreground">Wallet Autopay</h4>
                                        <p className="text-[10px] text-muted-foreground mr-10 leading-relaxed">
                                            When enabled, we will automatically deduct plan fees from your wallet balance on the renewal date.
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{subscription.autoPay ? 'Enabled' : 'Disabled'}</span>
                                        <Button
                                            variant={subscription.autoPay ? 'default' : 'outline'}
                                            size="sm"
                                            className="rounded-xl h-8 text-[10px] font-black uppercase tracking-widest"
                                            onClick={async () => {
                                                try {
                                                    await updateBillingSettings({ autoPay: !subscription.autoPay });
                                                    toast.success(`Autopay ${!subscription.autoPay ? 'enabled' : 'disabled'}`);
                                                    refetch();
                                                } catch (err) {
                                                    toast.error("Failed to update Autopay setting");
                                                }
                                            }}
                                        >
                                            {subscription.autoPay ? 'Turn Off' : 'Turn On'}
                                        </Button>
                                    </div>
                                </div>
                                <div className="bg-amber-500/5 border border-amber-500/10 rounded-2xl p-4 flex gap-3 italic text-[10px] text-amber-700/80 font-medium">
                                    <Clock className="size-4 shrink-0" /> Note: If your wallet balance is insufficient at renewal, your account will be marked as 'Past Due'.
                                </div>
                            </div>

                            {/* Tax ID Control */}
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <h4 className="text-sm font-black uppercase tracking-wide text-foreground">Tax Identification (GSTIN/VAT)</h4>
                                    <p className="text-[10px] text-muted-foreground leading-relaxed">Required for generating valid tax-compliant invoices.</p>
                                </div>
                                <div className="flex gap-2">
                                    <Input
                                        placeholder="Enter GSTIN or VAT Number"
                                        className="rounded-xl h-11 bg-muted/20 border-border/50 font-bold"
                                        defaultValue={subscription.taxId}
                                        onBlur={async (e) => {
                                            if (e.target.value === (subscription.taxId || '')) return;
                                            try {
                                                await updateBillingSettings({ taxId: e.target.value });
                                                toast.success("Tax ID updated successfully");
                                                refetch();
                                            } catch (err) {
                                                toast.error("Failed to save Tax ID");
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="pt-6 border-t border-border/10 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <ShieldCheck className="size-4" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">End-to-end encrypted financial metadata</span>
                            </div>
                            <Button variant="ghost" onClick={() => { router.push('/settings/member-profile'); }} className="text-[10px] font-black uppercase text-rose-500 hover:bg-rose-50 hover:text-rose-600 rounded-xl px-4">
                                Deactivate Workspace
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <RechargeModal
                isOpen={isRechargeOpen}
                onClose={() => setIsRechargeOpen(false)}
                currency={wallet.currency}
                paymentEnabled={billing?.payment?.enabled === true}
            />

            <PlanSelectionModal
                isOpen={isPlanSelectionOpen}
                onClose={() => setIsPlanSelectionOpen(false)}
                currentPlanSlug={(plan as any).slug}
                onPlanChanged={handlePlanChanged}
            />
        </div>
    );
}
