import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatMoneyFromMinorUnits(
  amount: number | null | undefined,
  currency = 'INR',
  locale?: string
) {
  const resolvedAmount = Number(amount ?? 0) / 100
  const resolvedLocale = locale || (currency === 'INR' ? 'en-IN' : 'en-US')

  try {
    return new Intl.NumberFormat(resolvedLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(resolvedAmount)
  } catch {
    return `${currency} ${resolvedAmount.toLocaleString(resolvedLocale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
}

export function normalizeWalletBalanceForDisplay(balance: number | null | undefined) {
  const numericBalance = Number(balance ?? 0)

  // Billing snapshots expose wallet balances in rupees, but some session and
  // realtime payloads can still carry persisted paise/cents. Large integer
  // balances are normalized before display so header and billing agree.
  if (Number.isInteger(numericBalance) && Math.abs(numericBalance) >= 10000) {
    return numericBalance / 100
  }

  return numericBalance
}

export function formatWalletMoney(
  balance: number | null | undefined,
  currency = 'INR',
  locale?: string
) {
  const resolvedAmount = normalizeWalletBalanceForDisplay(balance)
  const resolvedLocale = locale || (currency === 'INR' ? 'en-IN' : 'en-US')

  return `${currency} ${resolvedAmount.toLocaleString(resolvedLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(false);
      return;
    }
    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }
    const existingScript = document.querySelector('script[data-razorpay-checkout]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(true));
      existingScript.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = 'true';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}
