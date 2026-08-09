import test from "node:test";
import assert from "node:assert/strict";
import { buildGupshupWebhookUrl } from "../src/server/gupshup-webhook-url.ts";

test("builds a secure Gupshup callback URL from a public origin", () => {
  assert.equal(
    buildGupshupWebhookUrl("https://example.com", "secret-token"),
    "https://example.com/api/webhooks/whatsapp?verify_token=secret-token",
  );
});

test("preserves the callback path and replaces stale verification tokens", () => {
  assert.equal(
    buildGupshupWebhookUrl("https://example.com/api/webhooks/gupshup?verify_token=old", "new"),
    "https://example.com/api/webhooks/gupshup?verify_token=new",
  );
});

test("rejects insecure or unauthenticated callbacks", () => {
  assert.throws(() => buildGupshupWebhookUrl("http://example.com", "secret"), /HTTPS/);
  assert.throws(() => buildGupshupWebhookUrl("https://example.com", ""), /WEBHOOK_VERIFY_TOKEN/);
});
