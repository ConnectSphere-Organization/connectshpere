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
  AUTOMATION_SERVICE_URL: z.string().url().optional(),
  NODE_ENV: z.string().optional().default('development'),
});

const envParseResult = envSchema.safeParse(process.env);
if (!envParseResult.success) {
  console.error('Environment validation failed for chat-service:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET!;
const internalServiceSecret = process.env.INTERNAL_SERVICE_SECRET!;
const automationServiceUrl = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:3001';

if (process.env.NODE_ENV === 'production') {
  if (jwtSecret === 'your-secret-key-change-in-production' || jwtSecret === 'your-jwt-secret') {
    throw new Error('FATAL: A secure, non-default JWT_SECRET environment variable is required in production.');
  }
  if (internalServiceSecret === 'dev-internal-service-secret-change-me') {
    throw new Error('FATAL: A secure, non-default INTERNAL_SERVICE_SECRET environment variable is required in production.');
  }
  if (!process.env.AUTOMATION_SERVICE_URL || automationServiceUrl.includes('localhost') || automationServiceUrl.includes('127.0.0.1')) {
    throw new Error('FATAL: AUTOMATION_SERVICE_URL must reference the automation service in production.');
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3008', 10),
  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/wapi',
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret,
  internalServiceSecret,
  automationServiceUrl: automationServiceUrl.replace(/\/+$/, ''),
  authCookieName: 'auth_token',
};

export type AppConfig = typeof config;

export default config;
