"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Globe, MessageSquare, Plus, Smartphone, AlertCircle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const CHANNELS = [
  { id: "whatsapp", name: "WhatsApp", description: "Primary support and broadcast channel.", icon: Smartphone, status: "connected", color: "text-emerald-600", managePath: "/settings/whatsapp-profile", connectPath: "/onboarding" },
  { id: "website", name: "Website Chat", description: "Embed a lightweight website entry point.", icon: Globe, status: "not_connected", color: "text-sky-600", managePath: "/widget", connectPath: "/widget" },
  { id: "manual", name: "Manual Inbox", description: "Create contacts and follow up by hand.", icon: MessageSquare, status: "connected", color: "text-violet-600", managePath: "/inbox", connectPath: "/inbox" },
];

export default function ChannelsSettingsPage() {
  const router = useRouter();
  const channels = CHANNELS;

  const handleChannelAction = (channel: (typeof CHANNELS)[number]) => {
    router.push(channel.status === "connected" ? channel.managePath : channel.connectPath);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-10">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-black tracking-tight text-foreground">Channels</h1>
          <p className="text-sm font-medium text-muted-foreground">Connect the entry points that feed conversations into your workspace.</p>
        </div>
        <Badge className="w-fit rounded-full px-3 py-1 font-bold text-[10px] uppercase tracking-widest bg-sky-500/10 text-sky-600 border-none">Inspired by wApi</Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: "Connected", value: channels.filter((channel) => channel.status === "connected").length, icon: CheckCircle2, tone: "text-emerald-600" },
          { label: "Pending", value: channels.filter((channel) => channel.status === "not_connected" || channel.status === "pending").length, icon: AlertCircle, tone: "text-amber-600" },
          { label: "Available", value: channels.length, icon: MessageSquare, tone: "text-sky-600" },
        ].map((item) => (
          <Card key={item.label} className="border-none ring-1 ring-border/50 bg-background/60 shadow-sm backdrop-blur-xl">
            <CardContent className="p-6 flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{item.label}</p>
                <h3 className="text-2xl font-black">{item.value}</h3>
              </div>
              <div className={`h-12 w-12 rounded-2xl bg-accent/40 flex items-center justify-center ${item.tone}`}>
                <item.icon className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {channels.map((channel) => (
          <Card key={channel.name} className="border-none ring-1 ring-border/50 bg-background/60 shadow-sm hover:shadow-xl transition-all rounded-[2rem] overflow-hidden">
            <CardContent className="p-8 space-y-6">
              <div className={`h-14 w-14 rounded-2xl bg-accent/40 flex items-center justify-center ${channel.color}`}>
                <channel.icon className="h-7 w-7" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-xl font-black tracking-tight">{channel.name}</h3>
                  <Badge className={`rounded-full px-3 py-1 font-black text-[10px] uppercase tracking-widest border-none ${channel.status === "connected" ? "bg-emerald-500/10 text-emerald-600" : channel.status === "not_connected" || channel.status === "pending" ? "bg-amber-500/10 text-amber-600" : "bg-slate-500/10 text-slate-600"}`}>
                    {channel.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <p className="text-sm font-medium text-muted-foreground leading-relaxed">{channel.description}</p>
              </div>
              <Button
                disabled={channel.status === "coming_soon"}
                onClick={() => handleChannelAction(channel)}
                className="h-11 rounded-2xl bg-primary text-primary-foreground font-black shadow-lg shadow-primary/20">
                {channel.status === "connected" ? "Manage Channel" : channel.status === "coming_soon" ? "Coming Soon" : channel.status === "pending" ? "Review Setup" : "Connect Channel"}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-none ring-1 ring-border/50 bg-slate-950 text-white shadow-2xl rounded-[2rem] overflow-hidden">
        <CardContent className="p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <h3 className="text-xl font-black">Channel expansion</h3>
            <p className="text-sm text-white/60 font-medium leading-relaxed">Use this screen as the anchor for future connectors without changing the dashboard shell.</p>
          </div>
          <Button variant="secondary" onClick={() => router.push('/integrations')} className="h-11 rounded-2xl font-black text-[10px] uppercase tracking-widest">
            <Plus className="h-4 w-4 mr-2" /> Add Connector
          </Button>
        </CardContent>
      </Card>

    </div>
  );
}
