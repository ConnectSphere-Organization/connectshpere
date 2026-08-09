/**
 * RECHARGE MODAL COMPONENT
 * 
 * Allows users to select or enter a recharge amount and initiates Razorpay checkout.
 */

"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CreditCard, DollarSign, Zap, Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { rechargeWallet, verifyPayment } from '@/lib/api/billing';
import { useQueryClient } from '@tanstack/react-query';
import { formatWalletMoney, loadRazorpayScript } from '@/lib/utils';

interface RechargeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currency?: string;
  paymentEnabled?: boolean;
}

const PRESET_AMOUNTS = [500, 1000, 2000, 5000];

export default function RechargeModal({ isOpen, onClose, currency = 'INR', paymentEnabled = true }: RechargeModalProps) {
  const [amount, setAmount] = useState<string>('500');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isOpen || !paymentEnabled || document.querySelector('script[data-razorpay-checkout]')) return;

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = 'true';
    document.body.appendChild(script);
  }, [isOpen, paymentEnabled]);

  const handleRecharge = async () => {
    if (!paymentEnabled) {
      toast.error('Online payments are temporarily unavailable. Please contact support.');
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 100) {
      toast.error('Minimum recharge amount is 100 INR');
      return;
    }

    setIsProcessing(true);
    try {
      await loadRazorpayScript();
      // 1. Create Order
      const orderData: any = await rechargeWallet({
        amountPaise: amountNum * 100
      });

      // 2. Open Razorpay Checkout
      const options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "wApi Platform",
        description: `Wallet Recharge - ${amountNum} ${currency}`,
        order_id: orderData.orderId,
        handler: async function (response: any) {
          try {
            // 3. Verify Payment
            const verifyData: any = await verifyPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            });

            if (verifyData.success) {
              setIsSuccess(true);
              toast.success('Wallet recharged successfully!');
              queryClient.invalidateQueries({ queryKey: ['billing'] });

              // Refresh global auth store so the header updates
              const { useAuthStore } = await import('@/store/auth-store');
              useAuthStore.getState().fetchSession(true);

              setTimeout(() => {
                onClose();
                setIsSuccess(false);
              }, 2000);
            }
          } catch (err: any) {
            toast.error(err.response?.data?.message || 'Payment verification failed');
          } finally {
            setIsProcessing(false);
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
            setIsProcessing(false);
          }
        }
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();

    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to initiate payment');
      setIsProcessing(false);
    }
  };

  if (isSuccess) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-md rounded-[32px] p-12 flex flex-col items-center text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500">
            <CheckCircle2 className="h-10 w-10" />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-black text-foreground">Payment Successful!</h2>
            <p className="text-muted-foreground font-medium">Your wallet has been credited. Credits are now ready for use.</p>
          </div>
          <Button onClick={onClose} className="w-full rounded-2xl h-12 font-black uppercase tracking-widest">
            Close
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md rounded-[32px] p-8 space-y-6 border-none shadow-2xl">
        <DialogHeader>
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-4">
            <CreditCard className="h-6 w-6" />
          </div>
          <DialogTitle className="text-2xl font-black text-foreground">Recharge Wallet</DialogTitle>
          <DialogDescription className="font-medium">
            {paymentEnabled
              ? 'Add credits to your workspace to keep your automations running smoothly.'
              : 'Online payments are temporarily unavailable. Please contact support.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {PRESET_AMOUNTS.map((amt) => (
              <Button
                key={amt}
                variant={amount === amt.toString() ? 'default' : 'outline'}
                className="rounded-xl h-14 font-bold text-lg"
                onClick={() => setAmount(amt.toString())}
              >
                {currency} {amt.toLocaleString()}
              </Button>
            ))}
          </div>

          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-muted-foreground">{currency}</span>
            <Input
              type="number"
              placeholder="Enter custom amount"
              className="pl-12 h-14 rounded-xl border-border/50 text-lg font-bold bg-muted/20"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="bg-muted/30 rounded-2xl p-4 flex items-start gap-3">
            <Zap className="h-5 w-5 text-primary mt-0.5" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Credits have no expiry date and can be used for all platform services, including WhatsApp Cloud API messages and AnswerBot resolutions.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            className="w-full rounded-2xl h-14 font-black text-xs uppercase tracking-widest shadow-lg shadow-primary/20"
            disabled={isProcessing || !paymentEnabled}
            onClick={handleRecharge}
          >
            {isProcessing ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>Pay with Razorpay <DollarSign className="ml-2 h-4 w-4" /></>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
