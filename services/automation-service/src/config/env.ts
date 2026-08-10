import dotenv from 'dotenv';
import type { DotenvConfigOptions } from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true } as DotenvConfigOptions);

const envSchema = z.object({
  JWT_SECRET: z.string({
    required_error: 'JWT_SECRET is required',
  }).min(1, 'JWT_SECRET cannot be empty'),
  INTERNAL_SERVICE_SECRET: z.string({
    required_error: 'INTERNAL_SERVICE_SECRET is required',
  }).min(1, 'INTERNAL_SERVICE_SECRET cannot be empty'),
  INTEGRATION_ENCRYPTION_KEY: z.string({
    required_error: 'INTEGRATION_ENCRYPTION_KEY is required',
  }).min(1, 'INTEGRATION_ENCRYPTION_KEY cannot be empty'),
  CHAT_SERVICE_URL: z.string().url().optional(),
  CONTACT_SERVICE_URL: z.string().url().optional(),
  BSP_SERVICE_URL: z.string().url().optional(),
});

const envParseResult = envSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for automation-service:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET!;
const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET!;
const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY!;
const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:3008';
const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
const bspServiceUrl = process.env.BSP_SERVICE_URL || 'http://localhost:3004';

function isLocalServiceUrl(value: string) {
  return value.includes('localhost') || value.includes('127.0.0.1');
}

if (process.env.NODE_ENV === 'production') {
  if (jwtSecret === 'your-secret-key-change-in-production' || jwtSecret === 'your-jwt-secret') {
    throw new Error('FATAL: A secure, non-default JWT_SECRET environment variable is required in production.');
  }
  if (internalServiceSecret === 'dev-internal-service-secret-change-me') {
    throw new Error('FATAL: A secure, non-default INTERNAL_SERVICE_SECRET environment variable is required in production.');
  }
  if (integrationEncryptionKey === 'change-me-in-production') {
    throw new Error('FATAL: A secure, non-default INTEGRATION_ENCRYPTION_KEY environment variable is required in production.');
  }
  if (!process.env.CHAT_SERVICE_URL || isLocalServiceUrl(chatServiceUrl)) {
    throw new Error('FATAL: CHAT_SERVICE_URL must reference chat-service in production.');
  }
  if (!process.env.CONTACT_SERVICE_URL || isLocalServiceUrl(contactServiceUrl)) {
    throw new Error('FATAL: CONTACT_SERVICE_URL must reference contact-service in production.');
  }
  if (!process.env.BSP_SERVICE_URL || isLocalServiceUrl(bspServiceUrl)) {
    throw new Error('FATAL: BSP_SERVICE_URL must reference service-provider in production.');
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  mongodbUri:
    process.env.MONGO_URI ||
    process.env.MONGODB_URI_AUTOMATION ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/wapi_automation',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret,
  internalServiceSecret,
  chatServiceUrl: chatServiceUrl.replace(/\/+$/, ''),
  contactServiceUrl: contactServiceUrl.replace(/\/+$/, ''),
  bspServiceUrl: bspServiceUrl.replace(/\/+$/, ''),
  monolithInternalUrl: process.env.MONOLITH_INTERNAL_URL || process.env.API_GATEWAY_URL || 'http://localhost:5001',
  customerPortalUrl: process.env.CUSTOMER_PORTAL_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000',
  integrationEncryptionKey,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  metaAdsClientId: process.env.META_ADS_CLIENT_ID || '',
  metaAdsClientSecret: process.env.META_ADS_CLIENT_SECRET || '',
  metaAdsRedirectUri: process.env.META_ADS_REDIRECT_URI || '',
  metaAdsApiVersion: process.env.META_ADS_API_VERSION || 'v25.0',
  metaAdsScopes: (process.env.META_ADS_SCOPES || 'ads_management,ads_read,business_management,catalog_management,pages_show_list,pages_read_engagement,whatsapp_business_management')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean),
  petpoojaBaseUrl: process.env.PETPOOJA_BASE_URL || 'https://developerapi.petpooja.com/v2',
  petpoojaValidateOnConnect: process.env.PETPOOJA_VALIDATE_ON_CONNECT === 'true',
};

export type AppConfig = typeof config;

export default config;
