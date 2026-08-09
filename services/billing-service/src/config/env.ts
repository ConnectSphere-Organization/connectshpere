import dotenv from 'dotenv';
import type { DotenvConfigOptions } from 'dotenv';
import { z } from 'zod';
import { validatePaymentPolicy } from './payment-policy';

dotenv.config({ quiet: true } as DotenvConfigOptions);

const envSchema = z.object({
  JWT_SECRET: z.string({
    required_error: 'JWT_SECRET is required',
  }).min(1, 'JWT_SECRET cannot be empty'),
  INTERNAL_SERVICE_SECRET: z.string({
    required_error: 'INTERNAL_SERVICE_SECRET is required',
  }).min(1, 'INTERNAL_SERVICE_SECRET cannot be empty'),
  NODE_ENV: z.string().optional().default('development'),
  RAZORPAY_ENABLED: z.enum(['true', 'false']).optional(),
  ALLOW_UNSIGNED_DEV_PAYMENT_WEBHOOKS: z.enum(['true', 'false']).optional().default('false'),
});

const envParseResult = envSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for billing-service:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET!;
const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET!;
const paymentPolicy = validatePaymentPolicy({
  nodeEnv: process.env.NODE_ENV,
  razorpayEnabled: process.env.RAZORPAY_ENABLED,
  keyId: process.env.RAZORPAY_KEY_ID,
  keySecret: process.env.RAZORPAY_KEY_SECRET,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET,
  allowUnsignedDevWebhooks: process.env.ALLOW_UNSIGNED_DEV_PAYMENT_WEBHOOKS,
});

if (process.env.NODE_ENV === 'production') {
  if (jwtSecret === 'your-secret-key-change-in-production' || jwtSecret === 'your-jwt-secret') {
    throw new Error('FATAL: A secure, non-default JWT_SECRET environment variable is required in production.');
  }
  if (internalServiceSecret === 'dev-internal-service-secret-change-me') {
    throw new Error('FATAL: A secure, non-default INTERNAL_SERVICE_SECRET environment variable is required in production.');
  }
}

export const config = {
  port: process.env.PORT || 3003,
  mongodbUri: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/wapi_billing',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || '',
  razorpayEnabled: paymentPolicy.enabled,
  allowUnsignedDevPaymentWebhooks: paymentPolicy.allowUnsignedDevWebhooks,
  bspServiceUrl: process.env.BSP_SERVICE_URL || 'http://localhost:3004',
  jwtSecret,
  internalServiceSecret,
};

export type AppConfig = typeof config;

export default config;
