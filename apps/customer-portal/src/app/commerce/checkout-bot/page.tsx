"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  ShoppingCart, 
  Plus, 
  Search, 
  DollarSign, 
  CheckCircle, 
  ArrowRight, 
  Zap,
  TrendingDown,
  Users,
  MessageCircle,
  Clock,
  Settings as SettingsIcon,
  ShieldCheck,
  Power,
  Package
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { getCheckoutBotStats, getCommerceSettings, saveCommerceSettings } from '@/lib/api/commerce';
import FlashLoader from '@/components/ui/flash-loader';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export default function CheckoutBotPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  
  // Stats Query
  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['checkout-bot-stats'],
    queryFn: async () => {
      const resp: any = await getCheckoutBotStats();
      return resp.data;
    }
  });

  // Settings Query (to control bot activation)
  const { data: settingsData, isLoading: settingsLoading } = useQuery({
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
      toast.success("Bot configuration updated.");
    },
    onError: () => toast.error("Failed to update bot settings.")
  });

  if (statsLoading || settingsLoading) return <FlashLoader />;

  const stats = (statsData && statsData.subtext) ? statsData : {
    ordersClosed: 0,
    totalRevenue: '₹0',
    abandonmentRate: '0%',
    activeSessions: 0,
    subtext: { orders: 'No data', revenue: 'Real-time', abandonment: 'Stable', sessions: 'Monitoring' }
  };

  const dashboardStats = [
    { label: 'Orders Closed', value: stats.ordersClosed, sub: stats.subtext.orders, icon: CheckCircle, color: "text-emerald-500", bg: "bg-emerald-500/5" },
    { label: 'Total Revenue', value: stats.totalRevenue, sub: stats.subtext.revenue, icon: DollarSign, color: "text-blue-500", bg: "bg-blue-500/5" },
    { label: 'Abandonment', value: stats.abandonmentRate, sub: stats.subtext.abandonment, icon: TrendingDown, color: "text-red-500", bg: "bg-red-500/5" },
    { label: 'Active sessions', value: stats.activeSessions, sub: stats.subtext.sessions, icon: Users, color: "text-purple-500", bg: "bg-purple-500/5" },
  ];

  const handleToggleBot = (checkoutBotEnabled: boolean) => {
    updateSettings.mutate({ ...settingsData, checkoutBotEnabled });
  };

  return (
    <div className="flex flex-col gap-10 pb-40">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
             <h1 className="text-4xl font-black tracking-tight text-foreground">Checkout Bot</h1>
             <Badge className={cn(
               "rounded-xl border-none font-black text-[9px] uppercase tracking-widest px-3 py-1",
               settingsData?.checkoutBotEnabled ? "bg-emerald-500 text-white" : "bg-slate-500 text-white"
             )}>
                {settingsData?.checkoutBotEnabled ? 'Active Engine' : 'Offline'}
             </Badge>
          </div>
          <p className="text-muted-foreground text-sm font-medium opacity-60 flex items-center gap-2">
            Automate the checkout process and close sales directly on WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/commerce/settings">
             <Button variant="outline" className="rounded-2xl h-12 px-6 font-black text-[10px] uppercase tracking-widest gap-2">
                <SettingsIcon className="size-4 opacity-40" /> Logistics Hub
             </Button>
          </Link>
          <Button onClick={() => { router.push('/commerce/settings'); }} className="rounded-2xl h-12 px-8 font-black shadow-xl shadow-primary/20 bg-primary text-primary-foreground text-[10px] uppercase tracking-[0.2em] gap-2">
            <Plus className="size-4" /> New Checkout Flow
          </Button>
        </div>
      </div>

      {/* Analytics Architecture */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {dashboardStats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="p-8 bg-card border border-border/40 rounded-[32px] group relative overflow-hidden shadow-sm hover:shadow-xl transition-all"
          >
             <div className="flex items-center justify-between mb-4">
                <div className={cn("p-2.5 rounded-xl", stat.bg, stat.color)}>
                   <stat.icon className="size-5" />
                </div>
                <Badge variant="outline" className="rounded-lg text-[8px] font-black uppercase tracking-widest border-border/40 opacity-40">Real-Time</Badge>
             </div>
             <div className="space-y-1">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60 leading-none">{stat.label}</p>
                <h3 className="text-3xl font-black tracking-tighter">{stat.value}</h3>
                <p className={cn("text-[9px] font-bold mt-1", stat.color)}>{stat.sub}</p>
             </div>
             <div className={cn("absolute -bottom-10 -right-10 w-24 h-24 blur-[40px] opacity-10 rounded-full", stat.bg)} />
          </motion.div>
        ))}
      </div>

      {/* Operation Center & preview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Core Configuration */}
        <Card className="lg:col-span-2 border-none ring-1 ring-border/40 bg-card/60 backdrop-blur-xl rounded-[40px] overflow-hidden shadow-2xl">
           <CardHeader className="p-10 pb-6 bg-gradient-to-br from-primary/5 via-transparent to-transparent flex flex-row items-center justify-between border-b border-border/40">
              <div className="space-y-1">
                 <CardTitle className="text-2xl font-black tracking-tight">Operation Center</CardTitle>
                 <CardDescription className="text-xs font-semibold opacity-60 uppercase tracking-widest">Master Control & Trigger logic</CardDescription>
              </div>
              <div className="flex items-center gap-4 bg-background/50 p-2 px-4 rounded-2xl border border-border/40">
                 <Label className="text-[10px] font-black uppercase tracking-widest cursor-pointer" htmlFor="bot-toggle">
                    {settingsData?.checkoutBotEnabled ? 'Engine Online' : 'Engine Offline'}
                 </Label>
                 <Switch 
                   id="bot-toggle" 
                   checked={Boolean(settingsData?.checkoutBotEnabled)}
                   onCheckedChange={handleToggleBot}
                   className="data-[state=checked]:bg-emerald-500"
                 />
              </div>
           </CardHeader>
           <CardContent className="p-10 space-y-10">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                 <div className="space-y-6">
                    <div className="space-y-2">
                       <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                          <Zap className="size-3 text-primary" /> Checkout Trigger Keyword
                       </Label>
                       <Input 
                         placeholder="SHOP, BUY, CATALOG..." 
                         className="h-12 rounded-2xl bg-muted/30 border-border/40 font-black text-lg tracking-widest"
                         defaultValue={settingsData?.checkoutBotTriggerKeyword || 'SHOP'}
                         onBlur={(event) => {
                           const checkoutBotTriggerKeyword = event.currentTarget.value.trim().toUpperCase();
                           if (checkoutBotTriggerKeyword && checkoutBotTriggerKeyword !== settingsData?.checkoutBotTriggerKeyword) {
                             updateSettings.mutate({ ...settingsData, checkoutBotTriggerKeyword });
                           }
                         }}
                       />
                       <p className="text-[9px] text-muted-foreground font-medium italic opacity-60 px-1">
                          The bot will activate when a customer sends this exact word.
                       </p>
                    </div>

                    <div className="space-y-4 pt-4">
                       <h4 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 border-b border-border/20 pb-2">Smart Overrides</h4>
                       <div className="flex items-center justify-between p-4 bg-muted/20 rounded-2xl border border-border/40">
                          <div className="space-y-0.5">
                             <Label className="text-[10px] font-black uppercase tracking-widest">Inventory Gating</Label>
                             <p className="text-[9px] text-muted-foreground">Hide products with 0 stock.</p>
                          </div>
                          <Badge variant="outline" className="text-[9px] uppercase tracking-widest">Always enabled</Badge>
                       </div>
                       <div className="flex items-center justify-between p-4 bg-muted/20 rounded-2xl border border-border/40">
                          <div className="space-y-0.5">
                             <Label className="text-[10px] font-black uppercase tracking-widest">Auto-Confirmation</Label>
                             <p className="text-[9px] text-muted-foreground">Mark orders confirmed on intent.</p>
                          </div>
                          <Badge variant="outline" className="text-[9px] uppercase tracking-widest">Manual confirmation</Badge>
                       </div>
                    </div>
                 </div>

                 <div className="bg-primary/5 rounded-[40px] p-8 flex flex-col gap-6 border border-dashed border-primary/20 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-5">
                       <ShieldCheck className="size-40 text-primary" />
                    </div>
                    <div className="space-y-2 relative z-10">
                       <Badge className="bg-primary/20 text-primary border-none rounded-full px-4 font-black text-[8px] uppercase tracking-widest mb-2">Security Protocol</Badge>
                       <h3 className="text-xl font-black tracking-tight leading-snug">Autonomous Sales Integration</h3>
                       <p className="text-xs text-muted-foreground leading-relaxed opacity-70">
                          Our bot uses a state-of-the-art conversational engine to guide users from catalog browsing to payment settlement without 1:1 agent intervention.
                       </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 pt-4 relative z-10">
                       <div className="p-4 bg-background rounded-2xl border border-border/40 space-y-1 shadow-sm">
                          <MessageCircle className="size-4 text-primary mb-1" />
                          <p className="text-[10px] font-black uppercase tracking-widest leading-none">WhatsApp</p>
                          <p className="text-[9px] text-muted-foreground">Live Messaging</p>
                       </div>
                       <div className="p-4 bg-background rounded-2xl border border-border/40 space-y-1 shadow-sm">
                          <Package className="size-4 text-emerald-500 mb-1" />
                          <p className="text-[10px] font-black uppercase tracking-widest leading-none">Catalog</p>
                          <p className="text-[9px] text-muted-foreground">Synced Units</p>
                       </div>
                    </div>
                 </div>
              </div>
           </CardContent>
        </Card>

        {/* Visual flow steps */}
        <div className="flex flex-col gap-6">
           <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground px-4">Sales Logic Chain</h3>
           <div className="space-y-4">
              {[
                { step: '01', label: 'Manifest Sync', desc: 'Present active product catalog', color: 'bg-blue-500' },
                { step: '02', label: 'Unit Selection', desc: 'Identify target economic unit', color: 'bg-emerald-500' },
                { step: '03', label: 'Logistics Path', desc: 'Verify delivery node address', color: 'bg-amber-500' },
                { step: '04', label: 'Settlement', desc: 'Generate secure payment link', color: 'bg-purple-500' },
              ].map((step, i) => (
                <div key={i} className="group relative flex items-start gap-5 p-6 bg-card border border-border/40 rounded-[28px] hover:shadow-lg transition-all">
                   <div className={cn("size-10 rounded-xl shrink-0 flex items-center justify-center text-white font-black text-xs shadow-lg", step.color)}>
                      {step.step}
                   </div>
                   <div className="space-y-0.5">
                      <p className="text-xs font-black uppercase tracking-widest">{step.label}</p>
                      <p className="text-[11px] text-muted-foreground opacity-60 font-medium leading-relaxed">{step.desc}</p>
                   </div>
                   {i < 3 && (
                     <div className="absolute left-10 top-[4.5rem] w-px h-8 bg-border/40" />
                   )}
                </div>
              ))}
           </div>
           
           <Button onClick={() => { router.push('/inbox'); }} className="mt-4 rounded-2xl h-14 bg-emerald-500 hover:bg-emerald-600 text-white font-black text-[12px] uppercase tracking-[0.2em] shadow-xl shadow-emerald-500/20 group">
              Open Live Inbox <ArrowRight className="size-4 ml-2 group-hover:translate-x-1 transition-transform" />
           </Button>
        </div>
      </div>
    </div>
  );
}
