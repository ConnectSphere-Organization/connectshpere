import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveWebhookSignaturePolicy } from '../src/config/webhook-policy';
import { isNativeGupshupWebhook, normalizeWebhookProvider, verifyProviderSignature } from '../src/webhook-security';

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

test('accepts only the native Gupshup webhook envelope when unsigned', () => {
    assert.equal(isNativeGupshupWebhook({
        object: 'whatsapp_business_account',
        gs_app_id: '203a5e43-c560-44c8-be2e-4044e0b0b941',
        entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }],
    }), true);
    assert.equal(isNativeGupshupWebhook({ object: 'whatsapp_business_account', entry: [] }), false);
    assert.equal(isNativeGupshupWebhook({ event: 'message' }), false);
});
