import crypto from 'crypto';

export type SupportedWebhookProvider = 'gupshup' | 'meta';

export type WebhookSecrets = {
    gupshup: string;
    meta: string;
};

export function normalizeWebhookProvider(value?: string): SupportedWebhookProvider | null {
    const provider = String(value || 'gupshup').trim().toLowerCase();
    if (provider === 'gupshup' || provider === 'whatsapp') return 'gupshup';
    if (provider === 'meta' || provider === 'facebook') return 'meta';
    return null;
}

export function verifyProviderSignature(input: {
    provider: SupportedWebhookProvider;
    rawBody: string | Buffer;
    headers: Record<string, string | string[] | undefined>;
    secrets: WebhookSecrets;
}): boolean {
    const headerName = input.provider === 'gupshup' ? 'x-gupshup-signature' : 'x-hub-signature-256';
    const rawHeader = input.headers[headerName];
    const signature = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const secret = input.secrets[input.provider];
    if (!signature || !secret) return false;

    const suppliedHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (!/^[a-fA-F0-9]{64}$/.test(suppliedHex)) return false;

    const expected = crypto.createHmac('sha256', secret).update(input.rawBody).digest();
    const supplied = Buffer.from(suppliedHex, 'hex');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function isNativeGupshupWebhook(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const candidate = payload as Record<string, unknown>;
    if (candidate.object !== 'whatsapp_business_account') return false;
    if (typeof candidate.gs_app_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.gs_app_id)) return false;
    if (!Array.isArray(candidate.entry) || candidate.entry.length === 0) return false;

    return candidate.entry.some((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const changes = (entry as Record<string, unknown>).changes;
        return Array.isArray(changes) && changes.some((change) => {
            if (!change || typeof change !== 'object') return false;
            const field = (change as Record<string, unknown>).field;
            const value = (change as Record<string, unknown>).value;
            return typeof field === 'string' && field.length > 0 && !!value && typeof value === 'object';
        });
    });
}
