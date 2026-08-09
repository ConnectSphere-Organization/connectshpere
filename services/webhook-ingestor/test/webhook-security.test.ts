import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveWebhookSignaturePolicy } from '../src/config/webhook-policy';
import { normalizeWebhookProvider, verifyProviderSignature, verifyWebhookCallbackToken } from '../src/webhook-security';

const body = Buffer.from('{"event":"message"}');
const secrets = { gupshup: 'gupshup-secret', meta: 'meta-secret' };

test('production requires signed webhooks and rejects unsigned override', () => {
    assert.equal(resolveWebhookSignaturePolicy({ nodeEnv: 'production' }).requireSignature, true);
    assert.throws(
        () => resolveWebhookSignaturePolicy({ nodeEnv: 'production', allowUnsignedDevWebhooks: 'true' }),
        /cannot be enabled in production/,
    );
});

test('accepts a valid provider signature over the exact raw body', () => {
    const signature = crypto.createHmac('sha256', secrets.gupshup).update(body).digest('hex');
    assert.equal(verifyProviderSignature({ provider: 'gupshup', rawBody: body, headers: { 'x-gupshup-signature': signature }, secrets }), true);
});

test('rejects missing and invalid signatures', () => {
    assert.equal(verifyProviderSignature({ provider: 'meta', rawBody: body, headers: {}, secrets }), false);
    assert.equal(verifyProviderSignature({ provider: 'meta', rawBody: body, headers: { 'x-hub-signature-256': 'invalid' }, secrets }), false);
});

test('rejects unsupported providers during normalization', () => {
    assert.equal(normalizeWebhookProvider('instagram'), null);
});

test('authenticates callback tokens without timing-unsafe string comparison', () => {
    assert.equal(verifyWebhookCallbackToken('callback-secret', 'callback-secret'), true);
    assert.equal(verifyWebhookCallbackToken('wrong', 'callback-secret'), false);
    assert.equal(verifyWebhookCallbackToken(undefined, 'callback-secret'), false);
});
