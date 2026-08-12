import express, { type RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'crypto';
import IORedis from 'ioredis';
import { config } from './config/env';
import { featureForApiPath } from './config/feature-flags';
import { createServiceLogger, MetricsRegistry, metricsEndpoint, signInternalIdentity, tracingMiddleware } from '@connectsphere/contracts';
// IMPORTANT: http-proxy-middleware v3's `createProxyMiddleware` strips the
// Express mount prefix from `req.url` BEFORE `pathRewrite` runs. Every
// pathRewrite in this gateway (and every downstream service, which mount their
// handlers on the *full* `/api/v1/...` paths) assumes the full original URL is
// present. `legacyCreateProxyMiddleware` restores `req.originalUrl` (the v2
// behaviour), so `pathRewrite` and stripPrefix work as written. Swapping the
// alias keeps the rest of this file unchanged.
import { legacyCreateProxyMiddleware as createProxyMiddleware } from 'http-proxy-middleware';
import { authRateLimit, apiRateLimit, bulkRateLimit } from './middleware/rateLimit.js';

const app = express();
const port = config.port;
const isProduction = config.isProduction;
const observability = createServiceLogger({ service: 'api-gateway' });
const metrics = new MetricsRegistry('api-gateway');
let ready = true;

app.set('trust proxy', 1);
app.use(apiRateLimit);
app.use(tracingMiddleware());
app.use(metrics.middleware() as RequestHandler);

const publicAuthPaths = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/signup',
  '/api/v1/auth/verify-signup-otp',
  '/api/v1/auth/session',
  '/api/v1/auth/logout',
  '/api/v1/auth/otp/send',
  '/api/v1/auth/otp/verify',
  '/api/v1/auth/login/send-otp',
  '/api/v1/auth/login/verify-otp',
  '/api/v1/auth/request-password-reset',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/google/auth-url',
  '/api/v1/auth/google/url',
  '/api/v1/auth/google/login',
  '/api/v1/auth/google/callback',
  '/api/v1/auth/facebook',
  '/api/v1/auth/facebook/login',
  '/api/v1/auth/accept-invite',
]);

const isPublicAuthPath = (path: string) =>
  publicAuthPaths.has(path) || path.startsWith('/api/v1/auth/invitation/');

const isPublicWebhookPath = (path: string) => path === '/api/webhooks' || path.startsWith('/api/webhooks/');
const isPublicWidgetPath = (path: string) => path.startsWith('/api/v1/widget/public/');

type ServiceControl = {
  published?: boolean;
  maintenance?: boolean;
  message?: string;
};

const SERVICE_CONTROLS_KEY = 'platform:service-controls';
let redisClient: IORedis | null = null;
let serviceControlCache: Record<string, ServiceControl> = {};
let serviceControlCacheUntil = 0;
let serviceControlErrorLogUntil = 0;

function getRedis(): IORedis | null {
  if (!config.redisUrl) return null;
  if (!redisClient) {
    redisClient = new IORedis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redisClient.on('error', (err) => {
      if (Date.now() > serviceControlErrorLogUntil) {
        serviceControlErrorLogUntil = Date.now() + 60_000;
        console.warn(`[API Gateway] Redis service-control read failed: ${err.message}`);
      }
    });
  }
  return redisClient;
}

async function getServiceControls(): Promise<Record<string, ServiceControl>> {
  if (Date.now() < serviceControlCacheUntil) return serviceControlCache;
  serviceControlCacheUntil = Date.now() + 5000;

  try {
    const redis = getRedis();
    if (!redis) return serviceControlCache;
    if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
      await redis.connect();
    }
    const raw = await redis.get(SERVICE_CONTROLS_KEY);
    serviceControlCache = raw ? JSON.parse(raw) : {};
  } catch {
    serviceControlCacheUntil = Date.now() + 30_000;
    serviceControlCache = serviceControlCache || {};
  }

  return serviceControlCache;
}

function serviceIdsForPath(path: string): string[] {
  if (path.startsWith('/socket.io')) return ['websocket'];
  if (/^\/api\/v1\/contacts\/[^/]+\/send-template(?:\/|$)/.test(path)) return ['chat'];
  if (path.startsWith('/api/v1/inbox') || path.startsWith('/api/v1/conversations') || path.startsWith('/api/v1/analytics') || path.startsWith('/api/v1/metrics') || path.startsWith('/api/v1/support')) return ['chat'];
  if (path.startsWith('/api/v1/contacts') || path.startsWith('/api/v1/crm') || path.startsWith('/api/v1/tags') || path.startsWith('/api/v1/messaging/quick-replies') || path.startsWith('/api/v1/bulk')) return ['contact'];
  if (path.startsWith('/api/v1/billing') || path.startsWith('/api/v1/commerce') || path.startsWith('/api/v1/workspace/billing') || path.startsWith('/api/v1/workspace/pricing')) return ['billing'];
  if (path.startsWith('/api/v1/campaign') || path.startsWith('/api/v1/ads')) return ['campaign'];
  if (path.startsWith('/api/v1/automation') || path.startsWith('/api/v1/flows') || path.startsWith('/api/v1/widget') || path.startsWith('/api/v1/developer') || path.startsWith('/api/v1/external') || path.startsWith('/api/v1/integrations')) return ['automation'];
  if (path.startsWith('/api/v1/onboarding') || path.startsWith('/api/v1/templates') || path.startsWith('/api/v1/upload') || path.startsWith('/api/v1/workspace/waba') || path.startsWith('/api/v1/workspace/profile') || path.startsWith('/api/v1/workspace/webhooks') || path.startsWith('/api/v1/workspace/whatsapp') || path.startsWith('/api/v1/workspace/settings/waba') || path.startsWith('/api/v1/workspace/phone-numbers') || path.startsWith('/api/v1/workspace/connection-status')) return ['bsp'];
  if (path.startsWith('/api/v1/settings/api-keys') || path.startsWith('/api/v1/settings/integrations')) return ['automation'];
  if (path.startsWith('/api/v1/settings/billing')) return ['billing'];
  if (path.startsWith('/api/v1/auth') || path.startsWith('/api/v1/business') || path.startsWith('/api/v1/settings') || path.startsWith('/api/v1/workspace') || path.startsWith('/api/v1/inbox/settings')) return ['auth'];
  return [];
}

const corsOrigin = config.corsOrigin;

// Helmet security policy
app.use(helmet());

// Public website widget runtime calls this endpoint from arbitrary customer
// domains, so it needs a narrow CORS carve-out. All authenticated APIs keep the
// normal allow-list below.
app.use('/api/v1/widget/public', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// CORS config
app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  credentials: true
}));

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (isPublicWebhookPath(req.path) || req.path.startsWith('/api/internal') || req.path.startsWith('/socket.io')) return next();
  const cookieAuthenticated = typeof req.headers.cookie === 'string' && req.headers.cookie
    .split(';')
    .some((value) => value.trim().startsWith('auth_token='));
  if (!cookieAuthenticated) return next();

  const origin = typeof req.headers.origin === 'string'
    ? req.headers.origin
    : typeof req.headers.referer === 'string'
      ? new URL(req.headers.referer).origin
      : '';
  if (!origin || !config.allowedOrigins.includes(origin) || req.headers['x-requested-with'] !== 'ConnectSpherePortal') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_VALIDATION_FAILED',
        message: 'Request origin validation failed',
        requestId: req.headers['x-correlation-id'] || null,
      },
    });
  }
  next();
});

app.use('/api', (req, res, next) => {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(morgan(isProduction ? 'combined' : 'dev'));

// 1. Correlation ID, Header Stripping & Session Verification Middleware
// Generate or propagate x-correlation-id across all microservices requests
app.use(async (req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || crypto.randomUUID();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  // Trusted internal caller (e.g. admin-portal server) — proves itself with the
  // shared INTERNAL_SERVICE_SECRET. Identity headers it sends are kept as-is and
  // session verification is skipped. Constant-time compare to avoid timing leaks.
  const callerSecret = req.headers['x-internal-service-secret'];
  const expectedSecret = config.internalServiceSecret;
  if (typeof callerSecret === 'string' && callerSecret.length === expectedSecret.length &&
    crypto.timingSafeEqual(Buffer.from(callerSecret), Buffer.from(expectedSecret))) {
    // service-provider's guards additionally require an x-internal-service name.
    if (!req.headers['x-internal-service']) {
      req.headers['x-internal-service'] = 'api-gateway';
    }
    return next();
  }

  // P0 SECURITY: Forcefully strip client-supplied gateway headers to prevent spoofing
  delete req.headers['x-user-id'];
  delete req.headers['x-user-role'];
  delete req.headers['x-user-system-role'];
  delete req.headers['x-workspace-id'];
  delete req.headers['x-permissions'];
  delete req.headers['x-impersonating'];
  delete req.headers['x-internal-service-secret'];
  delete req.headers['x-internal-service'];

  // Skip verification for internal API calls, provider webhooks, public health
  // check endpoints, public auth endpoints, and socket.io connections. Public auth routes must still reach auth-service
  // when the browser has an expired/stale auth_token cookie; otherwise login
  // cannot replace the bad cookie.
  if (req.path.startsWith('/api/internal') || isPublicWebhookPath(req.path) || isPublicWidgetPath(req.path) || req.path === '/health' || req.path === '/' || isPublicAuthPath(req.path) || req.path.startsWith('/socket.io')) {
    return next();
  }

  // Parse session token from Authorization header or auth_token cookie
  let token: string | undefined;
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (typeof req.headers['cookie'] === 'string') {
    const cookies = req.headers['cookie'].split(';').map(c => c.trim());
    const match = cookies.find(c => c.startsWith('auth_token='));
    if (match) {
      token = match.substring('auth_token='.length);
    }
  }

  if (token) {
    try {
      const authServiceUrl = SERVICES.auth;
      const verifyRes = await fetch(`${authServiceUrl}/internal/v1/auth/verify-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': String(correlationId),
        },
        body: JSON.stringify({ token }),
      });

      if (verifyRes.ok) {
        const verifyData = await verifyRes.json() as any;
        if (verifyData && verifyData.success) {
          const userId = verifyData.user?._id || verifyData.user?.id;
          const workspaceRole = verifyData.role || verifyData.workspace?.role || 'agent';
          const systemRole = verifyData.user?.role || 'user';
          const workspaceId = verifyData.workspace?._id || verifyData.workspace?.id || verifyData.user?.activeWorkspace || verifyData.user?.workspace;
          const permissions = Array.isArray(verifyData.permissions) ? verifyData.permissions : [];

          if (userId) {
            req.headers['x-user-id'] = String(userId);
          }
          req.headers['x-user-role'] = String(workspaceRole);
          req.headers['x-user-system-role'] = String(systemRole);
          req.headers['x-permissions'] = encodeURIComponent(JSON.stringify(permissions));
          req.headers['x-impersonating'] = verifyData.isImpersonating ? 'true' : 'false';
          if (workspaceId) {
            req.headers['x-workspace-id'] = String(workspaceId);
          }

          // Inject shared internal key to prove that these headers were set by API Gateway
          req.headers['x-internal-service-secret'] = config.internalServiceSecret;
          req.headers['x-internal-service'] = 'api-gateway';
        }
      } else if (verifyRes.status === 401 || verifyRes.status === 403 || verifyRes.status === 400) {
        // The token is invalid/expired — an auth failure, not a gateway failure.
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
          message: 'Your session is invalid or has expired. Please log in again.'
        });
        return;
      } else {
        console.error(`[API Gateway Session Verification Error]: Auth Service returned status ${verifyRes.status}`);
        res.status(502).json({
          success: false,
          error: 'Bad Gateway',
          message: 'The authentication service is currently offline or unreachable. Please try again shortly.'
        });
        return;
      }
    } catch (err: any) {
      console.error(`[API Gateway Session Verification Error]: ${err.message}`);
      res.status(502).json({
        success: false,
        error: 'Bad Gateway',
        message: 'The authentication service is currently unreachable.'
      });
      return;
    }
  }

  next();
});

app.use('/api/v1', (req, res, next) => {
  const fullPath = `/api/v1${req.path}`;
  const feature = featureForApiPath(fullPath);
  if (!feature || config.featureFlags[feature]) return next();
  return res.status(404).json({
    success: false,
    error: {
      code: 'FEATURE_DISABLED',
      message: `${feature.replaceAll('_', ' ').toLowerCase()} is disabled`,
      requestId: req.headers['x-correlation-id'] || null,
    },
  });
});

// Public frontend status check. The customer portal uses this before login so
// a frontend-level maintenance toggle cannot be bypassed by visiting `/`.
app.get('/api/public/service-status', async (_req, res) => {
  const controls = await getServiceControls();
  const control = controls['customer-portal'] || {};
  return res.json({
    service: 'customer-portal',
    statusKnown: true,
    available: control.published !== false && control.maintenance !== true,
    maintenance: control.maintenance === true,
    published: control.published !== false,
    message: control.message || '',
  });
});

app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/internal') || isPublicWebhookPath(req.path) || isPublicWidgetPath(req.path) || req.path === '/health' || req.path === '/') {
    return next();
  }
  if (req.headers['x-user-system-role'] === 'super_admin') {
    return next();
  }

  const serviceIds = serviceIdsForPath(req.path);
  if (!serviceIds.length) {
    return next();
  }

  const controls = await getServiceControls();
  const blocked = serviceIds
    .map((serviceId) => ({ serviceId, control: controls[serviceId] }))
    .find(({ control }) => control?.published === false || control?.maintenance === true);

  if (!blocked) {
    return next();
  }

  const maintenance = blocked.control?.maintenance === true;
  return res.status(503).json({
    success: false,
    error: maintenance ? 'SERVICE_MAINTENANCE' : 'SERVICE_UNAVAILABLE',
    service: blocked.serviceId,
    message:
      blocked.control?.message ||
      (maintenance
        ? 'This service is temporarily under maintenance.'
        : 'This service is temporarily unavailable.'),
  });
});


// Define the Microservice URLs
const SERVICES = {
  ...config.services,
};

// Standard Proxy Error Handler.
// NOTE: for WebSocket upgrade failures, http-proxy emits 'error' with a raw
// net.Socket as the third argument (not an HTTP response), so guard on writeHead
// to avoid "res.writeHead is not a function" crashing the gateway.
const handleProxyError = (serviceName: string) => (err: any, req: any, res: any) => {
  const correlationId = req?.headers?.['x-correlation-id'] || 'unknown';
  observability.logger.error('proxy.request.failed', { operation: 'proxy', downstreamService: serviceName, method: req?.method, path: req?.url, errorCode: err?.code || 'DOWNSTREAM_UNAVAILABLE', error: err?.message, correlationId });
  metrics.increment('gateway_proxy_errors_total', 'API gateway downstream proxy errors', { downstream_service: serviceName });
  if (!res || typeof res.writeHead !== 'function') {
    // WebSocket upgrade error: res is a net.Socket — just tear it down.
    try { res?.destroy?.(); } catch { /* noop */ }
    return;
  }
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: false,
    error: 'Bad Gateway',
    message: `The ${serviceName} service is currently offline or unreachable. Please try again shortly.`,
    correlationId,
  }));
};

// Create a proxy helper — strips the Express mount prefix so downstream
// services receive paths starting from "/" (e.g. /login, not /api/v1/auth/login)
// NOTE: these are HTTP-only proxies. We deliberately do NOT set `ws: true` here:
// http-proxy-middleware auto-subscribes every `ws:true` proxy to the server's
// 'upgrade' event with no path filtering, so each would try to proxy the
// /socket.io WebSocket upgrade to its own service. Only the dedicated socket.io
// proxy below handles upgrades.
const proxyTo = (target: string, serviceName: string, stripPrefix?: string) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    ...(stripPrefix ? { pathRewrite: { [`^${stripPrefix}`]: '' } } : {}),
    on: {
      proxyReq: (proxyReq, req: any) => {
        const userId = req.headers['x-user-id'];
        const workspaceId = req.headers['x-workspace-id'];
        if (!userId || !workspaceId) return;
        let permissions: string[] = [];
        try { permissions = JSON.parse(decodeURIComponent(String(req.headers['x-permissions'] || '[]'))); } catch { permissions = []; }
        const token = signInternalIdentity({
          typ: 'internal_identity',
          sub: String(userId),
          workspaceId: String(workspaceId),
          workspaceRole: String(req.headers['x-user-role'] || 'agent'),
          systemRole: String(req.headers['x-user-system-role'] || 'user'),
          permissions,
          requestId: String(req.headers['x-correlation-id'] || crypto.randomUUID()),
          impersonating: req.headers['x-impersonating'] === 'true',
        }, config.internalServiceSecret, serviceName);
        proxyReq.setHeader('x-internal-auth', `Bearer ${token}`);
      },
      error: handleProxyError(serviceName)
    }
  });
};

// Custom proxy to bridge /api/v1/workspace/waba -> /bsp/v1/workspace/waba
// (service-provider mounts its customer-facing controllers under /bsp/v1/*)
const proxyToProviderWorkspace = (target: string) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => path.replace('/api/v1/workspace', '/bsp/v1/workspace'),
    on: {
      error: handleProxyError('service-provider')
    }
  });
};

const proxyToProviderOnboarding = (target: string) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // /api/v1/onboarding/provider/start -> /bsp/v1/onboarding/start
    pathRewrite: (path) => path.replace('/api/v1/onboarding/provider', '/bsp/v1/onboarding'),
    on: {
      error: handleProxyError('service-provider')
    }
  });
};

// Custom proxy to rewrite /api/v1/settings -> /settings
const proxyToSettings = (target: string) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => path.replace('/api/v1/settings', '/settings'),
    on: {
      error: handleProxyError('auth')
    }
  });
};

const proxyRewrite = (target: string, serviceName: string, rewrite: (path: string, req?: any) => string) => {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: rewrite,
    on: {
      proxyReq: (proxyReq, req: any) => {
        const userId = req.headers['x-user-id'];
        const workspaceId = req.headers['x-workspace-id'];
        if (!userId || !workspaceId) return;
        let permissions: string[] = [];
        try { permissions = JSON.parse(decodeURIComponent(String(req.headers['x-permissions'] || '[]'))); } catch { permissions = []; }
        proxyReq.setHeader('x-internal-auth', `Bearer ${signInternalIdentity({
          typ: 'internal_identity', sub: String(userId), workspaceId: String(workspaceId),
          workspaceRole: String(req.headers['x-user-role'] || 'agent'), systemRole: String(req.headers['x-user-system-role'] || 'user'),
          permissions, requestId: String(req.headers['x-correlation-id'] || crypto.randomUUID()), impersonating: req.headers['x-impersonating'] === 'true',
        }, config.internalServiceSecret, serviceName)}`);
      },
      error: handleProxyError(serviceName)
    }
  });
};

// --- Proxy Routes ---

// Apply general API rate limit to customer-facing API routes. Internal health
// probes are intentionally skipped so monitoring does not consume quota or
// spam Redis fallback logs when Redis is unavailable.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/internal/health')) return next();
  return apiRateLimit(req, res, next);
});

const authRateLimitedPaths = new Set([
  '/login',
  '/signup',
  '/verify-signup-otp',
  '/otp/send',
  '/otp/verify',
  '/request-password-reset',
  '/reset-password',
  '/google/login',
  '/google/callback',
  '/facebook',
  '/facebook/login',
  '/accept-invite',
]);

const authWriteRateLimit = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.method !== 'POST') return next();
  return authRateLimitedPaths.has(req.path) ? authRateLimit(req, res, next) : next();
};

// 1. Auth Service
// Apply stricter authRateLimit only to login/signup/OTP/password-reset style writes.
// Read endpoints such as /session, /workspaces, and /invitations/pending should
// use the general API limiter so normal app navigation cannot exhaust auth quota.
app.use('/api/v1/auth', authWriteRateLimit, proxyTo(SERVICES.auth, 'auth', '/api/v1/auth'));
// No super-admin APIs are exposed through the customer gateway. The standalone
// admin portal owns the complete control plane and connects to its data stores
// and external provider APIs server-side.

// 2. Billing Service
// NOTE: /api/v1/workspace/billing MUST come before /api/v1/workspace so that
// billing requests are routed to the billing-service, not the auth-service.
app.use('/api/v1/workspace/billing', proxyTo(SERVICES.billing, 'billing', '/api/v1/workspace/billing'));
// Conversation pricing map lives in billing (workspace context from token).
app.use('/api/v1/workspace/pricing', proxyRewrite(
  SERVICES.billing,
  'billing',
  (path) => path.replace('/api/v1/workspace/pricing', '/pricing')
));

// 3. BSP Service (WABA workspace settings & onboarding)
// Specific WABA connections and settings must route to NestJS BSP service
app.use('/api/v1/workspace/tags', proxyTo(SERVICES.contact, 'contact'));
app.use('/api/v1/workspace/quick-replies', proxyTo(SERVICES.contact, 'contact'));
app.use('/api/v1/workspace/waba', proxyToProviderWorkspace(SERVICES.serviceProvider));
app.use('/api/v1/workspace/profile', proxyToProviderWorkspace(SERVICES.serviceProvider));
app.use('/api/v1/workspace/webhooks', proxyToProviderWorkspace(SERVICES.serviceProvider));
// Covers /whatsapp/health, /whatsapp/profile* and /whatsapp/subscriptions/status
// (monolith served all /workspace/whatsapp/* itself).
app.use('/api/v1/workspace/whatsapp', proxyToProviderWorkspace(SERVICES.serviceProvider));
// Monolith alias: /workspace/settings/waba[/test] — same handlers as /workspace/waba.
app.use('/api/v1/workspace/settings/waba', proxyRewrite(
  SERVICES.serviceProvider,
  'service-provider',
  (path) => path.replace('/api/v1/workspace/settings/waba', '/bsp/v1/workspace/waba')
));
app.use('/api/v1/workspace/phone-numbers', proxyToProviderWorkspace(SERVICES.serviceProvider));
app.use('/api/v1/workspace/connection-status', proxyToProviderWorkspace(SERVICES.serviceProvider));

// 4. Fallback Workspace routes go to Auth Service
app.use('/api/v1/workspace', proxyRewrite(SERVICES.auth, 'auth', (path) => path.replace('/api/v1/workspace', '/workspace')));

// 5. General Settings and Business profile mappings
app.use('/api/v1/settings/api-keys', proxyRewrite(
  SERVICES.automation,
  'automation',
  (path) => path.replace('/api/v1/settings/api-keys', '/keys')
));

app.use('/api/v1/settings/integrations', proxyRewrite(
  SERVICES.automation,
  'automation',
  (path) => path.replace('/api/v1/settings/integrations', '/api/v1/integrations')
));

app.use('/api/v1/settings/team', proxyRewrite(
  SERVICES.auth,
  'auth',
  (path) => path.replace('/api/v1/settings/team', '/workspace/members')
));

app.use('/api/v1/settings/notifications', proxyRewrite(
  SERVICES.auth,
  'auth',
  (path) => path.replace('/api/v1/settings/notifications', '/user/settings/notifications')
));

app.use('/api/v1/settings/workspace', proxyRewrite(
  SERVICES.auth,
  'auth',
  (path) => path.replace('/api/v1/settings/workspace', '/workspace/settings')
));

app.use('/api/v1/settings/billing', proxyRewrite(
  SERVICES.billing,
  'billing',
  (path, req) => {
    if (req?.method === 'GET') {
      return '/info';
    }
    return '/settings';
  }
));

app.use('/api/v1/settings', proxyRewrite(
  SERVICES.auth,
  'auth',
  (path) => path.replace('/api/v1/settings', '/workspace/settings')
));

app.use('/api/v1/business', proxyTo(SERVICES.auth, 'auth', '/api/v1/business'));

// Legacy compatibility routes that old frontend/components still call.
app.use('/api/v1/tags', proxyTo(SERVICES.contact, 'contact'));
app.use('/api/v1/messaging/quick-replies', proxyTo(SERVICES.contact, 'contact'));
// inbox/settings — workspace inbox configuration (auth-service owns workspace settings)
app.use('/api/v1/inbox/settings', proxyRewrite(
  SERVICES.auth,
  'auth',
  (path) => path.replace('/api/v1/inbox/settings', '/workspace/inbox/settings')
));

// 6. Contact Service
// Carve-out: sending a template to a contact is a messaging concern (chat-service
// owns conversations + dispatch). Must be registered before the generic /contacts mount.
app.use('/api/v1/contacts/:contactId/send-template', proxyRewrite(
  SERVICES.chat,
  'chat',
  (path, req) => (req?.originalUrl || path).replace('/api/v1/contacts/', '/api/v1/inbox/contacts/')
));
app.use('/api/v1/contacts', proxyTo(SERVICES.contact, 'contact'));
app.use('/api/v1/crm', proxyTo(SERVICES.contact, 'contact'));
app.use('/api/v1/bulk/messages', proxyRewrite(
  SERVICES.campaign,
  'campaign',
  (path) => path.replace('/api/v1/bulk/messages', '/api/campaign/bulk/messages')
));
app.use('/api/v1/bulk/status', proxyRewrite(
  SERVICES.campaign,
  'campaign',
  (path) => path.replace('/api/v1/bulk/status', '/api/campaign/bulk/status')
));
app.use('/api/v1/bulk', bulkRateLimit, proxyTo(SERVICES.contact, 'contact'));

// 7. Chat/Inbox Service
app.use('/api/v1/inbox', proxyTo(SERVICES.chat, 'chat'));
app.use('/api/v1/conversations', proxyRewrite(
  SERVICES.chat,
  'chat',
  (path) => path.replace('/api/v1/conversations', '/conversations')
));
app.use('/api/v1/analytics', proxyTo(SERVICES.chat, 'chat'));
app.use('/api/v1/metrics', proxyTo(SERVICES.chat, 'chat'));
app.use('/api/v1/support', proxyTo(SERVICES.chat, 'chat'));

// 8. Other Billing endpoints
app.use('/api/v1/billing', proxyRewrite(
  SERVICES.billing,
  'billing',
  (path) => path.replace('/api/v1/billing', '/api/billing/wallets')
));
app.use('/api/v1/commerce', proxyTo(SERVICES.billing, 'billing'));

// 9. Campaign and Marketing Service
app.use('/api/v1/campaign', proxyRewrite(
  SERVICES.campaign,
  'campaign',
  (path) => path.replace('/api/v1/campaign', '/api/campaign')
));
app.use('/api/v1/ads', proxyTo(SERVICES.campaign, 'campaign'));

// 10. Automation and Workflow Service
// automation-service mounts its engine routes at /api/automation/engine (no /v1),
// so rewrite /api/v1/automation -> /api/automation before proxying.
app.use('/api/v1/automation', proxyRewrite(
  SERVICES.automation,
  'automation',
  (path) => path.replace('/api/v1/automation', '/api/automation')
));
app.use('/api/v1/flows', proxyTo(SERVICES.automation, 'automation'));
app.use('/api/v1/widget', proxyTo(SERVICES.automation, 'automation'));
app.use('/api/v1/developer', proxyTo(SERVICES.automation, 'automation'));
app.use('/api/v1/external', proxyTo(SERVICES.automation, 'automation'));
app.use('/api/v1/integrations', proxyTo(SERVICES.automation, 'automation'));

// 11. BSP Onboarding and Templates
app.use('/api/v1/onboarding/provider', proxyToProviderOnboarding(SERVICES.serviceProvider));
// Frontend calls /api/v1/onboarding/bsp/* (start, status, sync, register-phone,
// complete, disconnect, runtime-profile) — service-provider serves these at
// /bsp/v1/onboarding/*. Must be registered before the generic /api/v1/onboarding.
app.use('/api/v1/onboarding/bsp', proxyRewrite(
  SERVICES.serviceProvider,
  'service-provider',
  (path) => path.replace('/api/v1/onboarding/bsp', '/bsp/v1/onboarding')
));
// service-provider exposes onboarding under /bsp/v1/onboarding/* (e.g. /status, /complete)
app.use('/api/v1/onboarding', proxyRewrite(
  SERVICES.serviceProvider,
  'service-provider',
  (path) => path.replace('/api/v1/onboarding', '/bsp/v1/onboarding')
));
app.use('/api/v1/templates', proxyTo(SERVICES.serviceProvider, 'service-provider'));
app.use('/api/v1/upload', proxyTo(SERVICES.serviceProvider, 'service-provider'));

// 12. Internal Service Bridge Routing
app.use('/api/internal/billing', proxyRewrite(
  SERVICES.billing,
  'billing',
  (path) => path.replace('/api/internal/billing', '/api/billing')
));

app.use('/api/internal/contacts', proxyRewrite(
  SERVICES.contact,
  'contact',
  (path) => path.replace('/api/internal/contacts', '/internal/v1/contacts')
));

app.use('/api/internal/provider', proxyRewrite(
  SERVICES.serviceProvider,
  'service-provider',
  (path) => path.replace('/api/internal/provider', '/internal/v1/bsp')
));

app.use('/api/internal/automation', proxyRewrite(
  SERVICES.automation,
  'automation',
  (path) => path.replace('/api/internal/automation', '/api/automation')
));

app.use('/api/internal/campaign', proxyRewrite(
  SERVICES.campaign,
  'campaign',
  (path) => path.replace('/api/internal/campaign', '/api/campaign')
));

app.use('/api/internal/ingestor', proxyRewrite(
  SERVICES.ingestor,
  'ingestor',
  (path) => path.replace('/api/internal/ingestor', '')
));

app.use('/api/internal/chat', proxyRewrite(
  SERVICES.chat,
  'chat',
  (path) => path.replace('/api/internal/chat', '/api/internal')
));

const healthServiceAliases: Record<string, keyof typeof SERVICES> = {
  auth: 'auth',
  contact: 'contact',
  chat: 'chat',
  billing: 'billing',
  campaign: 'campaign',
  automation: 'automation',
  websocket: 'websocket',
  ingestor: 'ingestor',
  'service-provider': 'serviceProvider',
  serviceProvider: 'serviceProvider',
};

const healthProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>();

// Universal internal health proxy: /api/internal/health/:service -> target /health
app.use('/api/internal/health/:service', (req, res, next) => {
  const serviceKey = healthServiceAliases[req.params.service];
  const target = SERVICES[serviceKey];
  if (!target) {
    res.status(404).json({ error: 'Service not found' });
    return;
  }

  let proxy = healthProxyCache.get(serviceKey);
  if (!proxy) {
    proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: () => '/health',
      on: {
        error: handleProxyError(serviceKey)
      }
    });
    healthProxyCache.set(serviceKey, proxy);
  }

  proxy(req, res, next);
});

app.use('/api/internal', proxyTo(SERVICES.chat, 'chat'));

// 13. Provider webhooks. Payment webhooks belong to billing; BSP/message
// provider webhooks belong to the ingestion edge.
app.use('/api/webhooks/razorpay', proxyRewrite(
  SERVICES.billing,
  'billing',
  (path) => path.replace('/api/webhooks', '/api/billing/webhooks')
));
app.use('/api/webhooks', proxyRewrite(
  SERVICES.ingestor,
  'webhook-ingestor',
  (path) => path.replace('/api/webhooks', '/webhooks')
));


// 13. Socket.io WebSocket Gateway — the ONLY proxy with `ws: true`, so it is the only
// one that handles HTTP "upgrade" events (socket.io is the only WebSocket here).
// We also wire server.on('upgrade') below: http-proxy-middleware only auto-subscribes
// after the first *HTTP* request reaches this mount, but socket.io clients try the
// `websocket` transport first (a raw upgrade that bypasses Express routing).
const wsProxy = createProxyMiddleware({
  target: SERVICES.websocket,
  changeOrigin: true,
  ws: true,
  pathRewrite: (path) => (path.startsWith('/socket.io') ? path : `/socket.io${path}`),
  on: {
    error: handleProxyError('websocket-gateway')
  }
});
app.use('/socket.io', wsProxy);

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'wapi-api-gateway',
    timestamp: new Date().toISOString()
  });
});

app.get('/readiness', (_req, res) => {
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'draining', service: 'api-gateway' });
});

app.get('/metrics', metricsEndpoint(metrics));

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'wapi-api-gateway',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`\x1b[32m[API Gateway] Running at http://0.0.0.0:${port}\x1b[0m`);
  console.log(`[API Gateway] Proxying /api/v1/auth -> ${SERVICES.auth}`);
  console.log(`[API Gateway] Proxying /api/v1/contacts -> ${SERVICES.contact}`);
  console.log(`[API Gateway] Proxying /api/v1/inbox -> ${SERVICES.chat}`);
  console.log(`[API Gateway] Proxying /api/v1/billing -> ${SERVICES.billing}`);
  console.log(`[API Gateway] Proxying /api/v1/campaign -> ${SERVICES.campaign}`);
  console.log(`[API Gateway] Proxying /api/v1/automation -> ${SERVICES.automation}`);
  console.log(`[API Gateway] Proxying /api/v1/onboarding -> ${SERVICES.serviceProvider}`);
  console.log(`[API Gateway] Proxying /socket.io (ws) -> ${SERVICES.websocket}`);
});

// Proxy WebSocket upgrades for socket.io to the websocket-gateway.
server.on('upgrade', (wsProxy as any).upgrade);

const shutdown = (signal: string) => {
  ready = false;
  observability.logger.info('service.shutdown.started', { operation: 'shutdown', signal, result: 'draining' });
  server.close(async () => {
    try { await redisClient?.quit(); } catch { redisClient?.disconnect(); }
    observability.logger.info('service.shutdown.completed', { operation: 'shutdown', signal, result: 'success' });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 45_000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
