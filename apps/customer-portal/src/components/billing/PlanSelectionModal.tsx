/**
 * PLAN SELECTION MODAL
 * 
 * Allows users to upgrade/downgrade their subscription tier.
 */

"use client";

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Check, Zap, Shield, Rocket, ArrowRight, Loader2, Lock, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchBillingPlan, selectBillingPlan, verifyBillingPlanPayment } from '@/lib/api/billing';
import { toast } from 'sonner';
import { formatMoneyFromMinorUnits, loadRazorpayScript } from '@/lib/utils';

interface PlanSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlanSlug?: string;
  onPlanChanged: () => void;
}

export default function PlanSelectionModal({
  isOpen,
  onClose,
  currentPlanSlug,
  onPlanChanged
}: PlanSelectionModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState<string | null>(null);

  // Fetch available plans
  const { data: plans, isLoading } = useQuery({
    queryKey: ['available-plans'],
    queryFn: async () => {
      return await fetchBillingPlan();
    }
  });

  const availablePlans = Array.isArray(plans?.data) ? plans.data : [];
  const paymentEnabled = plans?.paymentEnabled === true;

  const handleSwitchPlan = async (plan: any) => {
    if (plan.slug === currentPlanSlug) return;
    if (Number(plan.monthlyBaseFeeCents || 0) > 0 && !paymentEnabled) {
      toast.error('Online payments are temporarily unavailable. Please contact support.');
      return;
    }

    setIsSubmitting(plan.slug);
    try {
      const response: any = await selectBillingPlan(plan.slug);

      if (response.requiresPayment) {
        await loadRazorpayScript();
        // Init Razorpay Checkout
        const options = {
          key: response.keyId,
          amount: response.amount,
          currency: response.currency,
          name: "wApi Platform",
          description: `Plan Upgrade: ${response.planName}`,
          order_id: response.orderId,
          handler: async (resp: any) => {
            try {
              toast.loading("Verifying activation...", { id: 'plan-verify' });
              await verifyBillingPlanPayment({
                razorpay_order_id: resp.razorpay_order_id,
                razorpay_payment_id: resp.razorpay_payment_id,
                razorpay_signature: resp.razorpay_signature
              });

              toast.success(`Welcome to ${plan.name}!`, { id: 'plan-verify' });
              onPlanChanged();
              onClose();
            } catch (err: any) {
              toast.error(err?.message || err.response?.data?.message || "Verification failed", { id: 'plan-verify' });
              setIsSubmitting(null);
            }
          },
          prefill: {
            name: "",
            email: ""
          },
          theme: {
            color: "#0f172a"
          },
          modal: {
            ondismiss: () => {
              setIsSubmitting(null);
            }
          }
        };

        const rzp = new (window as any).Razorpay(options);
        rzp.open();
      } else {
        // Free plan activated instantly
        toast.success(`Successfully switched to ${plan.name} plan!`);
        onPlanChanged();
        onClose();
        setIsSubmitting(null);
      }
    } catch (error: any) {
      toast.error(error?.message || error.response?.data?.message || "Failed to switch plan");
      setIsSubmitting(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[95vw] lg:max-w-[90vw] xl:max-w-[1200px] 2xl:max-w-[1400px] h-[92vh] p-0 overflow-hidden border-none shadow-2xl rounded-[40px] bg-background"
      >
        <div className="flex flex-col h-full overflow-hidden relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close plan selection"
            onClick={onClose}
            className="absolute right-5 top-5 z-50 h-9 w-9 rounded-full bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border/70 backdrop-blur hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>

          {/* Decorative background elements */}
          <div className="absolute top-0 left-0 w-full h-64 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />
          <div className="absolute top-20 right-20 w-96 h-96 bg-primary/5 blur-[120px] rounded-full pointer-events-none" />
          <div className="absolute bottom-20 left-20 w-96 h-96 bg-indigo-500/5 blur-[120px] rounded-full pointer-events-none" />

          <DialogHeader className="p-12 pb-8 text-center shrink-0 relative z-10">
            <div className="mx-auto w-16 h-16 rounded-3xl bg-primary/10 flex items-center justify-center text-primary mb-6 shadow-inner ring-1 ring-primary/20">
              <Rocket className="h-8 w-8 animate-bounce-subtle" />
            </div>
            <DialogTitle className="text-4xl font-black tracking-tighter uppercase italic">Elevate Your Strategy</DialogTitle>
            <DialogDescription className="text-lg font-medium mt-3 text-muted-foreground max-w-2xl mx-auto">
              Select a protocol optimized for your business scale. Instant activation, infinite possibilities.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 relative min-h-0 z-10">
            <ScrollArea className="h-full px-12">
              <div className="pb-12">
                {isLoading ? (
                  <div className="flex flex-col items-center justify-center py-32 gap-6">
                    <div className="relative">
                      <Loader2 className="h-12 w-12 animate-spin text-primary" />
                      <div className="absolute inset-0 blur-lg bg-primary/20 animate-pulse" />
                    </div>
                    <p className="text-xs font-black text-muted-foreground uppercase tracking-[0.3em]">Synching Plan Repository...</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                    {availablePlans.filter((p: any) => p.isActive !== false).map((plan: any) => {
                      const isCurrent = plan.slug === currentPlanSlug;
                      const isPro = plan.slug === 'pro' || plan.slug === 'growth';

                      return (
                        <div
                          key={plan.slug}
                          className={`relative p-8 rounded-[40px] border-2 transition-all duration-500 flex flex-col group h-full ${isCurrent
                            ? 'border-primary bg-primary/[0.02] shadow-2xl shadow-primary/5 ring-1 ring-primary/20'
                            : 'border-border/40 bg-card/50 hover:border-primary/30 hover:bg-card hover:shadow-2xl hover:-translate-y-1'
                            }`}
                        >
                          {isPro && !isCurrent && (
                            <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-primary to-indigo-600 text-white font-black uppercase text-[9px] tracking-widest rounded-full shadow-xl border-none">
                              Most Popular
                            </Badge>
                          )}

                          {isCurrent && (
                            <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-emerald-500 text-white font-black uppercase text-[9px] tracking-widest rounded-full shadow-xl border-none">
                              Active Protocol
                            </Badge>
                          )}

                          <div className="mb-8 space-y-4">
                            <div className="flex items-center justify-between">
                              <h3 className="text-xl font-black tracking-tight text-foreground uppercase italic">{plan.name}</h3>
                              <div className={`p-2 rounded-xl ${isCurrent ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
                                {plan.slug === 'free' ? <Shield className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                              </div>
                            </div>

                            <div className="flex flex-col">
                              <div className="flex items-baseline gap-1">
                                <span className="text-4xl font-black tracking-tighter">{formatMoneyFromMinorUnits(plan.monthlyBaseFeeCents || 0, plan.currency || 'INR')}</span>
                                <span className="text-xs text-muted-foreground font-bold tracking-tight uppercase">/ Month</span>
                              </div>
                              {plan.yearlyBaseFeeCents > 0 && (
                                <div className="mt-2 flex items-center gap-2">
                                  <div className="flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-lg border border-emerald-500/20">
                                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-tight">Save 20%</span>
                                  </div>
                                  <span className="text-[10px] font-bold text-muted-foreground">₹{(plan.yearlyBaseFeeCents / 1200).toFixed(0)} billed yearly</span>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="space-y-6 mb-10 flex-1">
                            <div className="space-y-3">
                              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 mb-4">Entitlements</p>
                              {[
                                { id: 'INBOX', label: 'Shared Omni-Inbox' },
                                { id: 'CRM', label: 'Sales CRM & Pipeline' },
                                { id: 'CAMPAIGNS', label: 'Bulk Marketing' },
                                { id: 'TEMPLATES', label: 'Dynamic Templates' },
                                { id: 'AUTOMATION', label: 'Advanced Automation' },
                                { id: 'ANALYTICS', label: 'Deep Data Insights' },
                                { id: 'TEAM', label: 'Team Collaboration' },
                              ].map((item) => {
                                const isIncluded = plan.features?.includes(item.id);
                                return (
                                  <div key={item.id} className={`flex items-center gap-3 transition-opacity duration-300 ${isIncluded ? 'opacity-100' : 'opacity-30'}`}>
                                    <div className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center ${isIncluded ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                                      {isIncluded ? <Check className="h-3.5 w-3.5 stroke-[3]" /> : <Lock className="h-3 w-3" />}
                                    </div>
                                    <span className="text-xs font-bold text-foreground/80">{item.label}</span>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Limits Summary */}
                            <div className="pt-6 border-t border-border/10 space-y-3">
                              <div className="flex items-center justify-between text-[11px] font-bold">
                                <span className="text-muted-foreground uppercase tracking-wider">Contacts</span>
                                <span className="text-foreground">{plan.limits?.maxContacts?.toLocaleString() || '1,000'}</span>
                              </div>
                              <div className="flex items-center justify-between text-[11px] font-bold">
                                <span className="text-muted-foreground uppercase tracking-wider">Messages</span>
                                <span className="text-foreground">{plan.limits?.maxMessagesPerMonth?.toLocaleString() || '5,000'}</span>
                              </div>
                            </div>
                          </div>

                          <Button
                            onClick={() => handleSwitchPlan(plan)}
                            disabled={isCurrent || isSubmitting === plan.slug || (Number(plan.monthlyBaseFeeCents || 0) > 0 && !paymentEnabled)}
                            className={`w-full h-14 rounded-2xl font-black uppercase tracking-[0.15em] text-[10px] transition-all duration-300 ${isCurrent
                              ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-80'
                              : 'bg-primary hover:bg-primary/90 text-white shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95'
                              }`}
                          >
                            {isSubmitting === plan.slug ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : isCurrent ? (
                              'Active Tier'
                            ) : Number(plan.monthlyBaseFeeCents || 0) > 0 && !paymentEnabled ? (
                              'Payments Unavailable'
                            ) : (
                              <>Deploy Strategy <ArrowRight className="ml-2 h-4 w-4" /></>
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Footer Info */}
          <div className="p-10 shrink-0 border-t border-border/10 bg-muted/20 relative z-10">
            <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-background flex items-center justify-center text-primary shadow-sm border border-border/50">
                  <Shield className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-foreground">Secure Billing Gateway</p>
                  <p className="text-[10px] text-muted-foreground font-medium">
                    {paymentEnabled
                      ? 'All transactions are encrypted and processed via Razorpay. Conversation costs are extra.'
                      : 'Online checkout is temporarily unavailable. Contact support to change to a paid plan.'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="rounded-full px-4 py-1 font-bold text-[10px] text-muted-foreground uppercase tracking-widest">Enterprise Support Included</Badge>
                <Badge variant="outline" className="rounded-full px-4 py-1 font-bold text-[10px] text-muted-foreground uppercase tracking-widest">SLA 99.9%</Badge>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
