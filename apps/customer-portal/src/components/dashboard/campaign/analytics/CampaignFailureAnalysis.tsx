"use client";

import { AlertCircle, ChevronRight, Info } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { motion } from "framer-motion";

interface FailureReason {
  reason: string;
  count: number;
  color: string;
}

interface CampaignFailureAnalysisProps {
  campaign: any;
}

export function CampaignFailureAnalysis({ campaign }: CampaignFailureAnalysisProps) {
  const failureReasons: FailureReason[] = Array.isArray(campaign.failureBreakdown)
    ? campaign.failureBreakdown
    : [];

  if (campaign.failedCount === 0 && campaign.status === 'COMPLETED') {
    return (
      <div className="bg-background rounded-[40px] p-8 border border-border/50 shadow-premium-sm">
        <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="h-16 w-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4">
                <motion.div
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                >
                    <AlertCircle className="h-8 w-8 text-emerald-500" />
                </motion.div>
            </div>
            <h3 className="text-lg font-black tracking-tight">Zero Failures Detected</h3>
            <p className="text-xs text-muted-foreground max-w-[200px] mt-2 font-medium">
                Your campaign reached 100% of the targetable audience without any technical rejects.
            </p>
        </div>
      </div>
    );
  }

  if (!failureReasons.length) {
    return (
      <div className="bg-background rounded-[40px] p-8 border border-border/50 shadow-premium-sm">
        <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">Failure Analysis</h2>
        <p className="mt-6 text-sm text-muted-foreground">Reason-level failure data is not available for this campaign.</p>
      </div>
    );
  }

  return (
    <div className="bg-background rounded-[40px] p-8 border border-border/50 shadow-premium-sm overflow-hidden relative">
      <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none">
          <AlertCircle className="h-32 w-32 text-rose-500" />
      </div>

      <div className="flex items-center justify-between mb-8">
        <div className="space-y-1">
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">Failure Analysis</h2>
            <p className="text-[10px] font-bold text-rose-500 flex items-center gap-1">
                {campaign.failedCount} recipients missed <ChevronRight className="h-2 w-2" />
            </p>
        </div>
      </div>

      <div className="space-y-6">
        {failureReasons.map((item, index) => {
          const percentage = campaign.failedCount > 0 ? Math.round((item.count / campaign.failedCount) * 100) : 0;
          return (
            <motion.div 
                key={index} 
                className="space-y-2"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.1 }}
            >
              <div className="flex justify-between items-end px-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{item.reason}</span>
                <span className="text-xs font-black">{item.count} <span className="text-[10px] opacity-30">({percentage}%)</span></span>
              </div>
              <div className="h-2 w-full bg-muted/50 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ duration: 1, ease: "easeOut", delay: 0.5 + (index * 0.1) }}
                  className={`h-full ${item.color}`}
                />
              </div>
            </motion.div>
          );
        })}

        {campaign.failedCount > 0 && (
            <div className="pt-4 border-t border-border/50 flex items-start gap-3">
                <div className="p-2 bg-blue-500/10 rounded-xl">
                    <Info className="h-4 w-4 text-blue-500" />
                </div>
                <p className="text-[10px] font-medium text-muted-foreground leading-relaxed">
                    <span className="font-black text-foreground">Pro-Tip:</span> High failure rates in "Invalid Phone Number" usually suggest a stale database. Try running a contact verification scan.
                </p>
            </div>
        )}
      </div>
    </div>
  );
}
