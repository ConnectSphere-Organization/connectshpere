import { z } from 'zod';

const publicEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().optional(),
  NEXT_PUBLIC_SOCKET_URL: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_GOOGLE_AUTH_ENABLED: z.string().optional(),
  NEXT_PUBLIC_FACEBOOK_APP_ID: z.string().optional(),
  NEXT_PUBLIC_FACEBOOK_AUTH_ENABLED: z.string().optional(),
  NEXT_PUBLIC_BUSINESS_VERIFICATION_MANDATORY: z.string().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().optional(),
  NEXT_PUBLIC_FEATURE_COMMERCE: z.string().optional(),
  NEXT_PUBLIC_FEATURE_AI_FAQ: z.string().optional(),
  NEXT_PUBLIC_FEATURE_META_ADS: z.string().optional(),
  NEXT_PUBLIC_FEATURE_PETPOOJA: z.string().optional(),
  NEXT_PUBLIC_FEATURE_ADVANCED_ANSWERBOT: z.string().optional(),
  NEXT_PUBLIC_FEATURE_DEVELOPER_API: z.string().optional(),
  NEXT_PUBLIC_FEATURE_FORMS: z.string().optional(),
});

const rawEnv = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  NEXT_PUBLIC_GOOGLE_AUTH_ENABLED: process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED,
  NEXT_PUBLIC_FACEBOOK_APP_ID: process.env.NEXT_PUBLIC_FACEBOOK_APP_ID,
  NEXT_PUBLIC_FACEBOOK_AUTH_ENABLED: process.env.NEXT_PUBLIC_FACEBOOK_AUTH_ENABLED,
  NEXT_PUBLIC_BUSINESS_VERIFICATION_MANDATORY: process.env.NEXT_PUBLIC_BUSINESS_VERIFICATION_MANDATORY,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_FEATURE_COMMERCE: process.env.NEXT_PUBLIC_FEATURE_COMMERCE,
  NEXT_PUBLIC_FEATURE_AI_FAQ: process.env.NEXT_PUBLIC_FEATURE_AI_FAQ,
  NEXT_PUBLIC_FEATURE_META_ADS: process.env.NEXT_PUBLIC_FEATURE_META_ADS,
  NEXT_PUBLIC_FEATURE_PETPOOJA: process.env.NEXT_PUBLIC_FEATURE_PETPOOJA,
  NEXT_PUBLIC_FEATURE_ADVANCED_ANSWERBOT: process.env.NEXT_PUBLIC_FEATURE_ADVANCED_ANSWERBOT,
  NEXT_PUBLIC_FEATURE_DEVELOPER_API: process.env.NEXT_PUBLIC_FEATURE_DEVELOPER_API,
  NEXT_PUBLIC_FEATURE_FORMS: process.env.NEXT_PUBLIC_FEATURE_FORMS,
};

const envParseResult = publicEnvSchema.safeParse(rawEnv);
if (!envParseResult.success) {
  console.error('Environment validation failed for customer-portal:');
  console.error(JSON.stringify(envParseResult.error.format(), null, 2));
}

export const config = {
  env: rawEnv.NODE_ENV || 'development',
  baseUrl: rawEnv.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  apiUrl: rawEnv.NEXT_PUBLIC_API_URL || '/api',
  // Empty means Socket.io uses the current origin. `next.config.ts` rewrites
  // /socket.io to the API gateway, so Docker/prod builds do not accidentally
  // bake a developer localhost into the browser bundle.
  socketUrl: rawEnv.NEXT_PUBLIC_SOCKET_URL || '',
  googleClientId: rawEnv.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
  googleAuthEnabled: rawEnv.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED !== 'false',
  facebookAppId: rawEnv.NEXT_PUBLIC_FACEBOOK_APP_ID || '',
  facebookAuthEnabled: rawEnv.NEXT_PUBLIC_FACEBOOK_AUTH_ENABLED === 'true',
  businessVerificationMandatory: rawEnv.NEXT_PUBLIC_BUSINESS_VERIFICATION_MANDATORY === 'true',
  appName: rawEnv.NEXT_PUBLIC_APP_NAME || 'ConnectSphere',
  optionalFeatures: {
    commerce: rawEnv.NEXT_PUBLIC_FEATURE_COMMERCE !== 'false',
    aiFaq: rawEnv.NEXT_PUBLIC_FEATURE_AI_FAQ !== 'false',
    metaAds: rawEnv.NEXT_PUBLIC_FEATURE_META_ADS !== 'false',
    petpooja: rawEnv.NEXT_PUBLIC_FEATURE_PETPOOJA !== 'false',
    advancedAnswerbot: rawEnv.NEXT_PUBLIC_FEATURE_ADVANCED_ANSWERBOT !== 'false',
    developerApi: rawEnv.NEXT_PUBLIC_FEATURE_DEVELOPER_API !== 'false',
    forms: rawEnv.NEXT_PUBLIC_FEATURE_FORMS !== 'false',
  },
};

export type PublicConfig = typeof config;

export default config;
