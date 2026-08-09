/**
 * Gupshup checks a callback by sending an empty POST before it starts sending
 * signed webhook events.  It is a reachability check, not an event, so it
 * must not enter the normal signature or event-processing pipeline.
 */
export function isEmptyWebhookProbe(body: unknown): boolean {
  if (Buffer.isBuffer(body)) return body.length === 0;
  return body === undefined || body === null || body === '';
}
