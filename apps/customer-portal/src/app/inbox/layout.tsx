import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shared Inbox | ConnectSphere",
  description: "Real-time WhatsApp shared inbox for your team.",
};

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
