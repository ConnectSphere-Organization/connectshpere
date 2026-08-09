export function validatePaymentPolicy(input: {
    nodeEnv?: string;
    razorpayEnabled?: string;
    keyId?: string;
    keySecret?: string;
    webhookSecret?: string;
    allowUnsignedDevWebhooks?: string;
}) {
    const isProduction = input.nodeEnv === 'production';
    const hasKeys = Boolean(input.keyId && input.keySecret);
    const enabled = input.razorpayEnabled === 'false' ? false : (input.razorpayEnabled === 'true' || hasKeys);
    const allowUnsignedDevWebhooks = input.allowUnsignedDevWebhooks === 'true';

    if (isProduction && allowUnsignedDevWebhooks) {
        throw new Error('FATAL: ALLOW_UNSIGNED_DEV_PAYMENT_WEBHOOKS cannot be enabled in production.');
    }

    if (enabled && (!input.keyId || !input.keySecret)) {
        throw new Error('FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when Razorpay is enabled.');
    }

    if (enabled && isProduction && !input.webhookSecret) {
        throw new Error('FATAL: RAZORPAY_WEBHOOK_SECRET is required when Razorpay is enabled in production.');
    }

    return {
        enabled,
        allowUnsignedDevWebhooks: allowUnsignedDevWebhooks && !isProduction,
    };
}