export function buildGupshupWebhookUrl(value: string): string {
  if (!value.trim()) throw new Error("Webhook URL is required");

  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("Gupshup webhook URL must use HTTPS");

  if (!url.pathname.includes("/api/webhooks/")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/webhooks/whatsapp`;
  }
  // Gupshup must retain the canonical callback exactly. Remove the temporary
  // query-token workaround used before native Gupshup payload validation.
  url.searchParams.delete("verify_token");
  return url.toString();
}
