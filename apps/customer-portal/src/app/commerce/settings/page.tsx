"use client";

import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  CreditCard, 
  Truck, 
  DollarSign, 
  Percent, 
  Globe, 
  Bell, 
  Bot, 
  Save, 
  ShieldCheck,
  Smartphone,
  Info,
  ChevronRight,
  Shield,
  Zap,
  Lock,
  Eye,
  EyeOff
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { getCommerceSettings, saveCommerceSettings } from '@/lib/api/commerce';
import FlashLoader from '@/components/ui/flash-loader';
import { cn } from '@/lib/utils';

export default function CommerceSettingsPage() {
  const queryClient = useQueryClient();
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const { data: settingsData, isLoading } = useQuery({
    queryKey: ['commerce-settings'],
    queryFn: async () => {
      const resp: any = await getCommerceSettings();
      return resp.data;
    }
  });

  const updateSettings = useMutation({
    mutationFn: (newSettings: any) => saveCommerceSettings(newSettings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commerce-settings'] });
      toast.success("Commerce configuration updated successfully.");
    },
    onError: () => toast.error("Failed to update settings.")
  });

  const [form, setForm] = useState<any>(null);

  useEffect(() => {
    if (settingsData) setForm(settingsData);
  }, [settingsData]);

  if (isLoading || !form) return <FlashLoader />;

  const toggleVisibility = (key: string) => {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = () => {
    updateSettings.mutate(form);
  };

  const updateField = (path: string, value: any) => {
    const parts = path.split('.');
    const newForm = { ...form };
    let current = newForm;
    for (let i = 0; i < parts.length - 1; i++) {
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    setForm(newForm);
  };

  return (
    <div className="h-[calc(100vh-theme(spacing.20))] overflow-y-auto custom-scrollbar no-scrollbar bg-card/10">
      <div className="p-8 max-w-[1200px] mx-auto pb-40 space-y-8">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
              Store Logistics
              <div className="flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-full px-3 py-1">
                 <ShieldCheck className="size-3.5 text-primary" />
                 <span className="text-[9px] font-black uppercase tracking-widest text-primary">Global Config</span>
              </div>
            </h1>
            <p className="text-muted-foreground text-sm font-medium opacity-60">
              Configure your global trading rules, tax compliance, and payment infrastructure.
            </p>
          </div>
          <Button 
            onClick={handleSave}
            disabled={updateSettings.isPending}
            className="rounded-2xl h-12 px-8 font-black shadow-xl shadow-primary/20 bg-primary text-primary-foreground text-[10px] uppercase tracking-[0.2em] gap-2 hover:scale-105 active:scale-95 transition-all"
          >
            {updateSettings.isPending ? <Zap className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save Architecture
          </Button>
        </div>

        <Tabs defaultValue="general" className="w-full">
           <TabsList className="bg-muted/30 p-1.5 rounded-2xl h-auto border border-border/40 gap-1">
             <TabsTrigger value="general" className="rounded-xl px-6 py-2.5 font-black text-[10px] uppercase tracking-widest data-[state=active]:bg-background data-[state=active]:shadow-sm">General</TabsTrigger>
             <TabsTrigger value="payments" className="rounded-xl px-6 py-2.5 font-black text-[10px] uppercase tracking-widest data-[state=active]:bg-background data-[state=active]:shadow-sm">Payments</TabsTrigger>
             <TabsTrigger value="shipping" className="rounded-xl px-6 py-2.5 font-black text-[10px] uppercase tracking-widest data-[state=active]:bg-background data-[state=active]:shadow-sm">Shipping</TabsTrigger>
             <TabsTrigger value="notifications" className="rounded-xl px-6 py-2.5 font-black text-[10px] uppercase tracking-widest data-[state=active]:bg-background data-[state=active]:shadow-sm">System</TabsTrigger>
           </TabsList>

           <div className="mt-8">
             <TabsContent value="general" className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                   <Card className="border-none ring-1 ring-border/40 bg-background/50 backdrop-blur-xl rounded-[32px] overflow-hidden group">
                      <CardHeader className="p-8 pb-4">
                         <div className="flex items-center gap-4 mb-2">
                            <div className="p-3 bg-primary/5 rounded-2xl text-primary group-hover:scale-110 transition-transform duration-500">
                               <Globe className="size-5" />
                            </div>
                            <CardTitle className="text-xl font-black tracking-tight">Core Trading</CardTitle>
                         </div>
                         <CardDescription className="text-xs font-semibold opacity-60">Standard rules for global commerce transactions.</CardDescription>
                      </CardHeader>
                      <CardContent className="p-8 space-y-6">
                         <div className="space-y-4">
                            <div className="space-y-2">
                               <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Base Currency</Label>
                               <Select value={form.currency} onValueChange={(v) => updateField('currency', v)}>
                                  <SelectTrigger className="h-12 rounded-2xl bg-card/30 border-border/40 font-bold px-4">
                                     <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="rounded-2xl">
                                     <SelectItem value="INR">INR - Indian Rupee (₹)</SelectItem>
                                     <SelectItem value="USD">USD - US Dollar ($)</SelectItem>
                                     <SelectItem value="EUR">EUR - Euro (€)</SelectItem>
                                     <SelectItem value="GBP">GBP - British Pound (£)</SelectItem>
                                  </SelectContent>
                               </Select>
                            </div>
                            <div className="space-y-2">
                               <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Sales Tax (GST/VAT %)</Label>
                               <div className="relative">
	                                  <Input 
	                                    type="number" 
	                                    value={form.taxPercentage} 
	                                    onChange={(e) => updateField('taxPercentage', parseFloat(e.target.value))}
	                                    aria-label="Sales tax percentage"
	                                    className="h-12 rounded-2xl bg-card/30 border-border/40 pr-12 font-black text-lg" 
	                                  />
                                  <Percent className="absolute right-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground opacity-40" />
                               </div>
                               <p className="text-[10px] text-muted-foreground px-1 opacity-60 px-2 mt-2 leading-relaxed italic">
                                 Applied globally during checkout. Set to 0 to disable tax calculation.
                               </p>
                            </div>
                         </div>
                      </CardContent>
                   </Card>

                   <Card className="border-none ring-1 ring-border/40 bg-background/50 backdrop-blur-xl rounded-[32px] overflow-hidden group">
                      <CardHeader className="p-8 pb-4">
                         <div className="flex items-center gap-4 mb-2">
                            <div className="p-3 bg-amber-500/5 rounded-2xl text-amber-500 group-hover:scale-110 transition-transform duration-500">
                               <Bot className="size-5" />
                            </div>
                            <CardTitle className="text-xl font-black tracking-tight">Automated Sales</CardTitle>
                         </div>
                         <CardDescription className="text-xs font-semibold opacity-60">Control how the Checkout Bot manages transactions.</CardDescription>
                      </CardHeader>
                      <CardContent className="p-8 space-y-6">
                         <div className="space-y-6">
                            <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                               <div className="space-y-0.5">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Global Commerce Module</Label>
                                  <p className="text-[10px] text-muted-foreground font-medium opacity-60">Master toggle for all commerce features.</p>
                               </div>
                               <Switch checked={form.enabled} onCheckedChange={(v) => updateField('enabled', v)} />
                            </div>
                            <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40 opacity-80">
                               <div className="space-y-0.5">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Auto-Confirm Orders</Label>
                                  <p className="text-[10px] text-muted-foreground font-medium opacity-60">Skip manual review for paid orders.</p>
                               </div>
                               <Switch checked={form.orderAutoConfirm} onCheckedChange={(v) => updateField('orderAutoConfirm', v)} />
                            </div>
                         </div>
                      </CardContent>
                   </Card>
                </div>
             </TabsContent>

             <TabsContent value="payments" className="space-y-6">
                <div className="grid grid-cols-1 gap-6">
                   <Card className="border-none ring-1 ring-border/40 bg-background/50 backdrop-blur-xl rounded-[32px] overflow-hidden">
                      <CardHeader className="p-8 flex flex-row items-center justify-between border-b border-border/40">
                         <div>
                            <CardTitle className="text-2xl font-black tracking-tight flex items-center gap-3">
                               <CreditCard className="size-6 text-primary" />
                               Financial Infrastructure
                            </CardTitle>
                            <CardDescription className="text-xs font-semibold opacity-60 uppercase tracking-widest mt-1">Configure your global payment reach.</CardDescription>
                         </div>
                         <Badge variant="outline" className="rounded-xl bg-primary/5 text-primary border-primary/20 px-4 py-1.5 font-bold text-[10px] uppercase tracking-widest">Secure TLS 1.3</Badge>
                      </CardHeader>
                      <CardContent className="p-0">
                         <div className="divide-y divide-border/40">
                            {/* COD */}
                            <div className="p-8 flex flex-col lg:flex-row gap-8 items-start group hover:bg-muted/10 transition-colors">
                               <div className="lg:w-1/3 space-y-2">
                                  <div className="flex items-center gap-3">
                                     <div className="p-2 bg-slate-500/5 rounded-xl text-slate-500"><Smartphone className="size-4" /></div>
                                     <h4 className="font-black text-sm uppercase tracking-wide">Cash on Delivery</h4>
                                  </div>
                                  <p className="text-xs text-muted-foreground font-medium leading-relaxed opacity-60">Ideal for high-trust markets. Orders are marked as unpaid until manually updated.</p>
                               </div>
                               <div className="lg:w-2/3 w-full space-y-6">
                                  <div className="flex items-center justify-between">
                                     <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Enabled for Checkout</Label>
                                     <Switch checked={form.paymentMethods?.cashOnDelivery?.enabled} onCheckedChange={(v) => updateField('paymentMethods.cashOnDelivery.enabled', v)} />
                                  </div>
                                  <Input 
                                    placeholder="Add custom instructions to send via WhatsApp..." 
                                    value={form.paymentMethods?.cashOnDelivery?.instructions || ''}
                                    onChange={(e) => updateField('paymentMethods.cashOnDelivery.instructions', e.target.value)}
                                    className="h-12 rounded-2xl bg-card/30 border-border/40 px-4 italic" 
                                  />
                               </div>
                            </div>

                            {/* Razorpay */}
                            <div className="p-8 flex flex-col lg:flex-row gap-8 items-start group hover:bg-muted/10 transition-colors">
                               <div className="lg:w-1/3 space-y-2">
                                  <div className="flex items-center gap-3">
                                     <div className="p-2 bg-blue-500/5 rounded-xl text-blue-500"><Zap className="size-4" /></div>
                                     <h4 className="font-black text-sm uppercase tracking-wide">Razorpay Hub</h4>
                                  </div>
                                  <p className="text-xs text-muted-foreground font-medium leading-relaxed opacity-60">Connect your Razorpay account to accept UPI, Cards, and Net Banking in India.</p>
                               </div>
                               <div className="lg:w-2/3 w-full space-y-6">
                                  <div className="flex items-center justify-between mb-2">
                                     <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Gateway status</Label>
                                     <Switch checked={form.paymentMethods?.razorpay?.enabled} onCheckedChange={(v) => updateField('paymentMethods.razorpay.enabled', v)} />
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                     <div className="space-y-2">
                                        <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground ml-1">Key ID</Label>
                                        <Input 
                                          value={form.paymentMethods?.razorpay?.keyId || ''} 
                                          onChange={(e) => updateField('paymentMethods.razorpay.keyId', e.target.value)}
                                          className="h-11 rounded-xl bg-card/30 border-border/40 font-mono text-xs" 
                                          placeholder="rzp_live_..."
                                        />
                                     </div>
                                     <div className="space-y-2">
                                        <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground ml-1">Key Secret</Label>
                                        <div className="relative">
                                           <Input 
                                             type={showKeys['rzp'] ? 'text' : 'password'}
                                             value={form.paymentMethods?.razorpay?.keySecret || ''} 
                                             onChange={(e) => updateField('paymentMethods.razorpay.keySecret', e.target.value)}
                                             className="h-11 rounded-xl bg-card/30 border-border/40 font-mono text-xs pr-10" 
                                             placeholder="••••••••••••••••"
                                           />
                                           <button onClick={() => toggleVisibility('rzp')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground opacity-40 hover:opacity-100 transition-opacity">
                                              {showKeys['rzp'] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                           </button>
                                        </div>
                                        <p className="text-[9px] text-muted-foreground">Saved secrets are hidden. Enter a value only to replace it.</p>
                                     </div>
                                  </div>
                               </div>
                            </div>

                            {/* Stripe */}
                            <div className="p-8 flex flex-col lg:flex-row gap-8 items-start group hover:bg-muted/10 transition-colors">
                               <div className="lg:w-1/3 space-y-2">
                                  <div className="flex items-center gap-3">
                                     <div className="p-2 bg-indigo-500/5 rounded-xl text-indigo-500"><Lock className="size-4" /></div>
                                     <h4 className="font-black text-sm uppercase tracking-wide">Stripe Global</h4>
                                  </div>
                                  <p className="text-xs text-muted-foreground font-medium leading-relaxed opacity-60">Infrastructure for international credit and debit cards.</p>
                               </div>
                               <div className="lg:w-2/3 w-full space-y-6">
                                  <div className="flex items-center justify-between mb-2">
                                     <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Gateway status</Label>
                                     <Switch checked={form.paymentMethods?.stripe?.enabled} onCheckedChange={(v) => updateField('paymentMethods.stripe.enabled', v)} />
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                     <div className="space-y-2">
                                        <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground ml-1">Public Key</Label>
                                        <Input 
                                          value={form.paymentMethods?.stripe?.publicKey || ''} 
                                          onChange={(e) => updateField('paymentMethods.stripe.publicKey', e.target.value)}
                                          className="h-11 rounded-xl bg-card/30 border-border/40 font-mono text-xs" 
                                          placeholder="pk_live_..."
                                        />
                                     </div>
                                     <div className="space-y-2">
                                        <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground ml-1">Secret Key</Label>
                                        <div className="relative">
                                           <Input 
                                             type={showKeys['stripe'] ? 'text' : 'password'}
                                             value={form.paymentMethods?.stripe?.secretKey || ''} 
                                             onChange={(e) => updateField('paymentMethods.stripe.secretKey', e.target.value)}
                                             className="h-11 rounded-xl bg-card/30 border-border/40 font-mono text-xs pr-10" 
                                             placeholder="••••••••••••••••"
                                           />
                                           <button onClick={() => toggleVisibility('stripe')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground opacity-40 hover:opacity-100 transition-opacity">
                                              {showKeys['stripe'] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                           </button>
                                        </div>
                                        <p className="text-[9px] text-muted-foreground">Saved secrets are hidden. Enter a value only to replace it.</p>
                                     </div>
                                  </div>
                               </div>
                            </div>
                         </div>
                      </CardContent>
                   </Card>
                </div>
             </TabsContent>

             <TabsContent value="shipping" className="space-y-6">
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                   <Card className="border-none ring-1 ring-border/40 bg-background/50 backdrop-blur-xl rounded-[32px] overflow-hidden group">
                      <CardHeader className="p-8 pb-4">
                         <div className="flex items-center gap-4 mb-2">
                            <div className="p-3 bg-primary/5 rounded-2xl text-primary group-hover:scale-110 transition-transform duration-500">
                               <Truck className="size-5" />
                            </div>
                            <CardTitle className="text-xl font-black tracking-tight">Postage Dynamics</CardTitle>
                         </div>
                         <CardDescription className="text-xs font-semibold opacity-60 uppercase tracking-widest mt-1">Configure your logistics rules.</CardDescription>
                      </CardHeader>
                      <CardContent className="p-8 space-y-6">
                         <div className="space-y-6">
                            <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                               <div className="space-y-0.5">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Master Shipping Toggle</Label>
                                  <p className="text-[10px] text-muted-foreground font-medium opacity-60">Apply shipping costs to all orders.</p>
                               </div>
                               <Switch checked={form.shipping?.enabled} onCheckedChange={(v) => updateField('shipping.enabled', v)} />
                            </div>

                            <div className={cn("space-y-4 transition-opacity", !form.shipping?.enabled && "opacity-50 pointer-events-none")}>
                                <div className="p-6 bg-card/30 rounded-[24px] border border-border/40 space-y-4">
                                   <div className="flex items-center justify-between">
                                      <Label className="text-[10px] font-black uppercase tracking-widest">Flat Rate Shipping</Label>
                                      <Switch 
                                        checked={form.shipping?.flatRate?.enabled} 
                                        onCheckedChange={(v) => updateField('shipping.flatRate.enabled', v)} 
                                      />
                                   </div>
                                   <AnimatePresence>
                                      {form.shipping?.flatRate?.enabled && (
                                        <motion.div 
                                          initial={{ height: 0, opacity: 0 }}
                                          animate={{ height: 'auto', opacity: 1 }}
                                          exit={{ height: 0, opacity: 0 }}
                                          className="pt-2 overflow-hidden"
                                        >
                                           <div className="relative">
                                              <Input 
                                                type="number" 
                                                value={form.shipping?.flatRate?.amount} 
                                                onChange={(e) => updateField('shipping.flatRate.amount', parseFloat(e.target.value))}
                                                className="h-12 rounded-2xl bg-card/30 border-border/40 font-black text-lg pl-12" 
                                              />
                                              <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground opacity-40" />
                                           </div>
                                        </motion.div>
                                      )}
                                   </AnimatePresence>
                                </div>

                                <div className="p-6 bg-card/30 rounded-[24px] border border-border/40 space-y-4">
                                   <div className="flex items-center justify-between">
                                      <Label className="text-[10px] font-black uppercase tracking-widest">Free Shipping Threshold</Label>
                                      <Switch 
                                        checked={form.shipping?.freeShippingAbove?.enabled} 
                                        onCheckedChange={(v) => updateField('shipping.freeShippingAbove.enabled', v)} 
                                      />
                                   </div>
                                   <AnimatePresence>
                                      {form.shipping?.freeShippingAbove?.enabled && (
                                        <motion.div 
                                          initial={{ height: 0, opacity: 0 }}
                                          animate={{ height: 'auto', opacity: 1 }}
                                          exit={{ height: 0, opacity: 0 }}
                                          className="pt-2 overflow-hidden"
                                        >
                                           <div className="relative">
                                              <Input 
                                                type="number" 
                                                value={form.shipping?.freeShippingAbove?.amount} 
                                                onChange={(e) => updateField('shipping.freeShippingAbove.amount', parseFloat(e.target.value))}
                                                className="h-12 rounded-2xl bg-card/30 border-border/40 font-black text-lg pl-12" 
                                                placeholder="Order value..."
                                              />
                                              <Zap className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-amber-500 opacity-40 underline" />
                                           </div>
                                           <p className="text-[9px] font-bold text-muted-foreground mt-3 uppercase tracking-widest opacity-60">Orders above this amount will have 0 shipping cost.</p>
                                        </motion.div>
                                      )}
                                   </AnimatePresence>
                                </div>
                            </div>
                         </div>
                      </CardContent>
                   </Card>

                   <div className="bg-primary/5 rounded-[40px] p-10 flex flex-col items-center justify-center text-center gap-6 border-2 border-dashed border-primary/20">
                      <div className="size-20 rounded-[32px] bg-primary/10 flex items-center justify-center text-primary shadow-2xl shadow-primary/10">
                         <Globe className="size-10" />
                      </div>
                      <div className="space-y-2">
                         <h4 className="text-xl font-black uppercase tracking-tight">Worldwide Routing</h4>
                         <p className="text-xs text-muted-foreground font-medium opacity-60 leading-relaxed max-w-xs">
                           Intelligent logistics matching and region-specific tax overrides are coming in the next release.
                         </p>
                      </div>
                      <Button variant="outline" disabled className="rounded-2xl border-primary/20 text-[10px] font-black uppercase tracking-widest px-8">Coming Soon</Button>
                   </div>
                </div>
             </TabsContent>

             <TabsContent value="notifications" className="space-y-6">
                <Card className="border-none ring-1 ring-border/40 bg-background/50 rounded-[32px] overflow-hidden">
                   <CardHeader className="p-8 pb-4">
                      <div className="flex items-center gap-4 mb-2">
                         <div className="p-3 bg-blue-500/5 rounded-2xl text-blue-500">
                            <Bell className="size-5" />
                         </div>
                         <CardTitle className="text-xl font-black tracking-tight">Communication Sync</CardTitle>
                      </div>
                   </CardHeader>
                   <CardContent className="p-8 space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                         <div className="space-y-6">
                            <h5 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Admin Notification Node</h5>
                            <div className="space-y-4">
                               <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Orders (WhatsApp)</Label>
                                  <Switch checked={form.notifications?.notifyAdminOnOrder} onCheckedChange={(v) => updateField('notifications.notifyAdminOnOrder', v)} />
                               </div>
                               <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Payments (WhatsApp)</Label>
                                  <Switch checked={form.notifications?.notifyAdminOnPayment} onCheckedChange={(v) => updateField('notifications.notifyAdminOnPayment', v)} />
                               </div>
                            </div>
                         </div>
                         <div className="space-y-6">
                            <h5 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Customer Success Loop</h5>
                            <div className="space-y-4">
                               <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Confirmation Messages</Label>
                                  <Switch checked={form.notifications?.notifyCustomerOnOrder} onCheckedChange={(v) => updateField('notifications.notifyCustomerOnOrder', v)} />
                               </div>
                               <div className="flex items-center justify-between p-4 bg-card/30 rounded-2xl border border-border/40">
                                  <Label className="text-[10px] font-black uppercase tracking-widest">Paid Status Updates</Label>
                                  <Switch checked={form.notifications?.notifyCustomerOnPayment} onCheckedChange={(v) => updateField('notifications.notifyCustomerOnPayment', v)} />
                               </div>
                            </div>
                         </div>
                      </div>
                   </CardContent>
                </Card>
             </TabsContent>
           </div>
        </Tabs>
      </div>
    </div>
  );
}
