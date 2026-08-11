import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Campaigns | ConnectSphere",
  description:
    "Plan, launch, and measure WhatsApp template campaigns.",
};

export default function CampaignLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
