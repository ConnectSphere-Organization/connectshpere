import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard | ConnectSphere",
  description:
    "WhatsApp Business overview — campaigns, inbox, analytics, and account health.",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
