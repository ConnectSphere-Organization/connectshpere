import dotenv from 'dotenv';
import type { DotenvConfigOptions } from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true } as DotenvConfigOptions);

const envSchema = z.object({
  INTERNAL_SERVICE_SECRET: z.string({
    required_error: 'INTERNAL_SERVICE_SECRET is required',
  }).min(1, 'INTERNAL_SERVICE_SECRET cannot be empty'),
  JWT_SECRET: z.string({
    required_error: 'JWT_SECRET is required',
  }).min(1, 'JWT_SECRET cannot be empty'),
  INTEGRATION_ENCRYPTION_KEY: z.string({
    required_error: 'INTEGRATION_ENCRYPTION_KEY is required',
  }).min(1, 'INTEGRATION_ENCRYPTION_KEY cannot be empty'),
  NODE_ENV: z.string().optional().default('development'),
  ALLOW_DEV_MEDIA_MOCKS: z.enum(['true', 'false']).optional().default('false'),
});

const envParseResult = envSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for service-provider:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
  process.exit(1);
}

const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET!;
const jwtSecret = process.env.JWT_SECRET!;
const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY!;
const allowDevMediaMocks = process.env.ALLOW_DEV_MEDIA_MOCKS === 'true';

if (process.env.NODE_ENV === 'production') {
  if (allowDevMediaMocks) {
    throw new Error('FATAL: ALLOW_DEV_MEDIA_MOCKS cannot be enabled in production.');
  }
  if (internalServiceSecret === 'dev-internal-service-secret-change-me') {
    throw new Error('FATAL: A secure, non-default INTERNAL_SERVICE_SECRET environment variable is required in production.');
  }
  if (
    jwtSecret === 'your-secret-key-change-in-production' ||
    jwtSecret === 'your-jwt-secret' ||
    jwtSecret === 'your-default-secret'
  ) {
    throw new Error('FATAL: A secure, non-default JWT_SECRET environment variable is required in production.');
  }
  if (integrationEncryptionKey === 'change-me-in-production') {
    throw new Error('FATAL: A secure, non-default INTEGRATION_ENCRYPTION_KEY environment variable is required in production.');
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3004', 10),
  mongodbUri:
    process.env.MONGO_URI ||
    process.env.MONGODB_URI_BSP ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/wapi_bsp',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  internalServiceSecret,
  jwtSecret,
  integrationEncryptionKey,
  mainServiceUrl: process.env.MAIN_SERVICE_URL || 'http://localhost:5001',
  campaignServiceUrl: process.env.CAMPAIGN_SERVICE_URL || 'http://localhost:3002',
  billingServiceUrl: process.env.BILLING_SERVICE_URL || 'http://localhost:3003',
  gupshup: {
    partnerBaseUrl: process.env.GUPSHUP_PARTNER_BASE_URL || 'https://partner.gupshup.io',
    apiBaseUrl: process.env.GUPSHUP_API_BASE_URL || 'https://api.gupshup.io',
    partnerEmail: process.env.GUPSHUP_PARTNER_EMAIL || '',
    partnerPassword: process.env.GUPSHUP_PARTNER_PASSWORD || '',
    partnerClientSecret: process.env.GUPSHUP_PARTNER_CLIENT_SECRET || '',
    partnerToken: process.env.GUPSHUP_PARTNER_TOKEN || '',
    webhookSecret: process.env.GUPSHUP_WEBHOOK_SECRET || '',
    verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  allowDevMediaMocks: allowDevMediaMocks && process.env.NODE_ENV !== 'production',
};

export type AppConfig = typeof config;

export default config;
