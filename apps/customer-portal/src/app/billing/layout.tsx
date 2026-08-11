import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Billing | ConnectSphere",
  description: "Wallet, invoices, plans, and payment methods.",
};

export default function BillingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
