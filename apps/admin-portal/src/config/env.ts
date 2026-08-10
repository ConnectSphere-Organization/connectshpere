import 'server-only';
import { z } from 'zod';

const optionalUrl = z.string().url().or(z.literal('')).optional();

const serverEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_AUTH_ENABLED: z.string().optional(),
  ADMIN_PORTAL_URL: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  ADMIN_COOKIE_NAME: z.string().optional(),
  ADMIN_SESSION_TTL: z.string().optional(),
  ADMIN_COOKIE_SECURE: z.string().optional(),
  ADMIN_INTERNAL_POST_TIMEOUT_MS: z.string().optional(),
  MONGODB_URI: z.string().optional(),
  MONGODB_URI_BILLING: z.string().optional(),
  MONGODB_URI_CAMPAIGN: z.string().optional(),
  MONGODB_URI_AUTOMATION: z.string().optional(),
  MONGODB_URI_BSP: z.string().optional(),
  REDIS_URL: z.string().optional(),
  GATEWAY_URL: optionalUrl,
  API_GATEWAY_URL: optionalUrl,
  INTERNAL_SERVICE_SECRET: z.string().optional(),
  MONITORING_PROBE_TIMEOUT_MS: z.string().optional(),
  AUTH_SERVICE_URL: optionalUrl,
  CHAT_SERVICE_URL: optionalUrl,
  CONTACT_SERVICE_URL: optionalUrl,
  BILLING_SERVICE_URL: optionalUrl,
  CAMPAIGN_SERVICE_URL: optionalUrl,
  AUTOMATION_SERVICE_URL: optionalUrl,
  SERVICE_PROVIDER_URL: optionalUrl,
  BSP_SERVICE_URL: optionalUrl,
  WEBHOOK_INGESTOR_URL: optionalUrl,
  WEBSOCKET_URL: optionalUrl,
  CUSTOMER_PORTAL_URL: optionalUrl,
  IMPERSONATION_COOKIE_DOMAIN: z.string().optional(),
  GUPSHUP_PARTNER_BASE_URL: optionalUrl,
  GUPSHUP_API_BASE_URL: optionalUrl,
  GUPSHUP_PARTNER_EMAIL: z.string().optional(),
  GUPSHUP_PARTNER_PASSWORD: z.string().optional(),
  GUPSHUP_PARTNER_CLIENT_SECRET: z.string().optional(),
  GUPSHUP_PARTNER_TOKEN: z.string().optional(),
  WHATSAPP_WEBHOOK_URL: optionalUrl,
  BUSINESS_VERIFICATION_MANDATORY: z.string().optional(),
  BUSINESS_VERIFICATION_PROVIDER: z.string().optional(),
  AUTH_TOKEN_TTL: z.string().optional(),
});

const envParseResult = serverEnvSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for admin-portal:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
}

const firstEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value.replace(/\/+$/, '');
  }
  return undefined;
};

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 3100),
  publicAppName: process.env.NEXT_PUBLIC_APP_NAME || 'wApi Super Admin',
  publicAppUrl: process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100',
  googleAuthEnabled: process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED !== 'false',
  jwtSecret: process.env.JWT_SECRET || '',
  adminCookieName: process.env.ADMIN_COOKIE_NAME || 'admin_token',
  adminSessionTtlSeconds: toNumber(process.env.ADMIN_SESSION_TTL, 28800),
  adminCookieSecure: process.env.ADMIN_COOKIE_SECURE,
  adminInternalPostTimeoutMs: toNumber(process.env.ADMIN_INTERNAL_POST_TIMEOUT_MS, 90000),
  mongodb: {
    core: process.env.MONGODB_URI || '',
    billing: process.env.MONGODB_URI_BILLING || '',
    campaign: process.env.MONGODB_URI_CAMPAIGN || '',
    automation: process.env.MONGODB_URI_AUTOMATION || '',
    bsp: process.env.MONGODB_URI_BSP || '',
  },
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  gatewayUrl: firstEnv('GATEWAY_URL', 'API_GATEWAY_URL') || 'http://localhost:5001',
  internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || '',
  monitoringProbeTimeoutMs: toNumber(process.env.MONITORING_PROBE_TIMEOUT_MS, 30000),
  services: {
    auth: firstEnv('AUTH_SERVICE_URL'),
    chat: firstEnv('CHAT_SERVICE_URL'),
    contact: firstEnv('CONTACT_SERVICE_URL'),
    billing: firstEnv('BILLING_SERVICE_URL'),
    campaign: firstEnv('CAMPAIGN_SERVICE_URL'),
    automation: firstEnv('AUTOMATION_SERVICE_URL'),
    serviceProvider: firstEnv('SERVICE_PROVIDER_URL', 'BSP_SERVICE_URL'),
    webhookIngestor: firstEnv('WEBHOOK_INGESTOR_URL'),
    websocket: firstEnv('WEBSOCKET_URL'),
    customerPortal: firstEnv('CUSTOMER_PORTAL_URL') || 'http://localhost:3000',
  },
  impersonationCookieDomain: process.env.IMPERSONATION_COOKIE_DOMAIN || '',
  gupshup: {
    partnerBaseUrl: process.env.GUPSHUP_PARTNER_BASE_URL || 'https://partner.gupshup.io',
    apiBaseUrl: process.env.GUPSHUP_API_BASE_URL || 'https://api.gupshup.io',
    partnerEmail: process.env.GUPSHUP_PARTNER_EMAIL || '',
    // Gupshup Partner login accepts `email` + `secret`. Keep the password
    // variable as a backwards-compatible source only; it is sent as `secret`.
    partnerSecret: process.env.GUPSHUP_PARTNER_CLIENT_SECRET || process.env.GUPSHUP_PARTNER_PASSWORD || '',
    partnerToken: process.env.GUPSHUP_PARTNER_TOKEN || '',
    webhookUrl: process.env.WHATSAPP_WEBHOOK_URL || '',
  },
  businessVerificationMandatory: process.env.BUSINESS_VERIFICATION_MANDATORY === 'true',
  businessVerificationProvider: process.env.BUSINESS_VERIFICATION_PROVIDER || 'hybrid',
  authTokenTtl: process.env.AUTH_TOKEN_TTL || '7d',
};

export type AdminConfig = typeof config;

export default config;
