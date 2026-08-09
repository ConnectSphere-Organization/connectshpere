import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyWebhookProbe } from '../src/webhook-probe';

test('identifies only empty callback reachability probes', () => {
  assert.equal(isEmptyWebhookProbe(undefined), true);
  assert.equal(isEmptyWebhookProbe(Buffer.alloc(0)), true);
  assert.equal(isEmptyWebhookProbe(Buffer.from('{}')), false);
  assert.equal(isEmptyWebhookProbe('{}'), false);
});
