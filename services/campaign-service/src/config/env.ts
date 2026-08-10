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
  NODE_ENV: z.string().optional().default('development'),
});

const envParseResult = envSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for campaign-service:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET!;
const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET!;

const serviceUrls = {
  billingServiceUrl: process.env.BILLING_SERVICE_URL || 'http://localhost:3003',
  bspServiceUrl: process.env.BSP_SERVICE_URL || 'http://localhost:3004',
  chatServiceUrl: process.env.CHAT_SERVICE_URL || 'http://localhost:3008',
  contactServiceUrl: process.env.CONTACT_SERVICE_URL || 'http://localhost:3007',
  automationServiceUrl: process.env.AUTOMATION_SERVICE_URL || 'http://localhost:3001',
  apiGatewayUrl: process.env.API_GATEWAY_URL || process.env.MONOLITH_URL || 'http://localhost:5001',
};

if (process.env.NODE_ENV === 'production') {
  if (jwtSecret === 'your-secret-key-change-in-production' || jwtSecret === 'your-jwt-secret') {
    throw new Error('FATAL: A secure, non-default JWT_SECRET environment variable is required in production.');
  }
  if (internalServiceSecret === 'dev-internal-service-secret-change-me') {
    throw new Error('FATAL: A secure, non-default INTERNAL_SERVICE_SECRET environment variable is required in production.');
  }
  for (const [name, value] of Object.entries(serviceUrls)) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(value)) {
      throw new Error(`FATAL: ${name} must use an in-cluster service URL in production.`);
    }
  }
}

export const config = {
  port: process.env.PORT || 3002,
  mongodbUri:
    process.env.MONGO_URI ||
    process.env.MONGODB_URI_CAMPAIGN ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/wa_campaigns',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  ...serviceUrls,
  jwtSecret,
  internalServiceSecret,
};

export type AppConfig = typeof config;

export default config;
