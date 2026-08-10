import test from "node:test";
import assert from "node:assert/strict";
import { buildGupshupWebhookUrl } from "../src/server/gupshup-webhook-url.ts";

test("builds the canonical Gupshup callback URL from a public origin", () => {
  assert.equal(
    buildGupshupWebhookUrl("https://example.com"),
    "https://example.com/api/webhooks/whatsapp",
  );
});

test("preserves the callback path and removes stale verification tokens", () => {
  assert.equal(
    buildGupshupWebhookUrl("https://example.com/api/webhooks/gupshup?verify_token=old"),
    "https://example.com/api/webhooks/gupshup",
  );
});

test("rejects insecure callbacks", () => {
  assert.throws(() => buildGupshupWebhookUrl("http://example.com"), /HTTPS/);
});
