export function buildGupshupWebhookUrl(value: string, verifyToken: string): string {
  if (!value.trim()) throw new Error("Webhook URL is required");
  if (!verifyToken.trim()) throw new Error("WEBHOOK_VERIFY_TOKEN is required for secure Gupshup callbacks");

  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("Gupshup webhook URL must use HTTPS");

  if (!url.pathname.includes("/api/webhooks/")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/webhooks/whatsapp`;
  }
  url.searchParams.set("verify_token", verifyToken);
  return url.toString();
}
