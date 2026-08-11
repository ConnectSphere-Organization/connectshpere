import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Analytics | ConnectSphere",
  description: "Campaign, inbox, and account performance metrics.",
};

export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
