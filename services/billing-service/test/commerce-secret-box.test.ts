import assert from 'node:assert/strict';
import test from 'node:test';

process.env.COMMERCE_SETTINGS_ENCRYPTION_KEY = 'test-only-commerce-encryption-key';

test('commerce credentials are encrypted at rest and decrypt for payment processing', async () => {
  const { encryptCommerceSecret, decryptCommerceSecret } = await import('../src/services/commerce-secret-box');
  const secret = 'rzp_test_secret_value';
  const encrypted = encryptCommerceSecret(secret);

  assert.ok(encrypted?.startsWith('enc:v1:'));
  assert.notEqual(encrypted, secret);
  assert.equal(decryptCommerceSecret(encrypted), secret);
});

test('legacy plaintext credentials remain readable during migration', async () => {
  const { decryptCommerceSecret } = await import('../src/services/commerce-secret-box');
  assert.equal(decryptCommerceSecret('legacy-plaintext-secret'), 'legacy-plaintext-secret');
});

test('settings redaction removes payment and provider secrets recursively', async () => {
  const { redactCommerceSettings } = await import('../src/controllers/commerceController');
  const safe = redactCommerceSettings({
    paymentMethods: {
      razorpay: { enabled: true, keyId: 'rzp_live_id', keySecret: 'do-not-return' },
      stripe: { publicKey: 'pk_live_key', secretKey: 'do-not-return' },
    },
    shipping: { providers: [{ name: 'Courier', apiKey: 'do-not-return' }] },
  });

  assert.equal(safe.paymentMethods.razorpay.keyId, 'rzp_live_id');
  assert.equal(safe.paymentMethods.razorpay.keySecret, undefined);
  assert.equal(safe.paymentMethods.stripe.publicKey, 'pk_live_key');
  assert.equal(safe.paymentMethods.stripe.secretKey, undefined);
  assert.equal(safe.shipping.providers[0].apiKey, undefined);
});
