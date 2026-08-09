import fastify from 'fastify';
import crypto from 'crypto';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import { config } from './config/env.js';
import { normalizeWebhookProvider, verifyProviderSignature } from './webhook-security.js';
import { isEmptyWebhookProbe } from './webhook-probe.js';
import { MetricsRegistry } from '@connectsphere/contracts';

const server = fastify({
  logger: config.env !== 'production',
  // Ensure we capture the raw body as a string for precise HMAC validation
  bodyLimit: 1048576, // 1MB
});

const PORT = config.port;
const REDIS_URL = config.redisUrl;
const REDIS_TOPIC = config.redisTopic;
const INTERNAL_SECRET = config.internalServiceSecret;
const MONGO_URI = config.mongoUri;
const DEAD_LETTER_COLLECTION = config.deadLetterCollection;
const metrics = new MetricsRegistry('webhook-ingestor');


// --- REDIS SETUP ---
let redisProducer: Redis | null = null;
let simulatedMode = false;
let mongoClient: MongoClient | null = null;
let redisReconnectAfter = 0;
let lastRedisErrorLogAt = 0;
let ready = false;

const REDIS_RECONNECT_COOLDOWN_MS = 30_000;
const REDIS_ERROR_LOG_COOLDOWN_MS = 60_000;

async function deadLetterCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    await mongoClient.db().collection(DEAD_LETTER_COLLECTION).createIndex({ eventId: 1 }, { unique: true });
    await mongoClient.db().collection(DEAD_LETTER_COLLECTION).createIndex({ status: 1, createdAt: 1 });
  }
  return mongoClient.db().collection(DEAD_LETTER_COLLECTION);
}

async function receiptCollection() {
  if (!mongoClient) await deadLetterCollection();
  const collection = mongoClient!.db().collection('webhook_ingress_receipts');
  await collection.createIndex({ eventId: 1 }, { unique: true });
  await collection.createIndex({ status: 1, updatedAt: 1 });
  return collection;
}

function logRedisWarning(message: string) {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < REDIS_ERROR_LOG_COOLDOWN_MS) return;
  lastRedisErrorLogAt = now;
  console.warn(message);
}

async function initRedis(force = false): Promise<boolean> {
  if (!REDIS_URL) {
    simulatedMode = true;
    logRedisWarning('[Webhook Ingestor] REDIS_URL missing. Webhooks will be stored in dead letters until Redis is configured.');
    return false;
  }

  if (!force && Date.now() < redisReconnectAfter) {
    return false;
  }

  if (redisProducer?.status === 'ready') {
    simulatedMode = false;
    return true;
  }

  try {
    redisProducer?.disconnect();
    redisProducer = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    redisProducer.on('error', (err) => {
      logRedisWarning(`[Webhook Ingestor] Redis producer error: ${err.message}`);
    });
    await redisProducer.connect();
    redisReconnectAfter = 0;
    simulatedMode = false;
    console.log(`[Webhook Ingestor] Connected to Redis`);
    return true;
  } catch (error: any) {
    redisProducer?.disconnect();
    redisProducer = null;
    redisReconnectAfter = Date.now() + REDIS_RECONNECT_COOLDOWN_MS;
    simulatedMode = true;
    logRedisWarning(`[Webhook Ingestor] Redis unavailable (${error.message}). Webhooks will be stored in dead letters and replay can retry later.`);
    return false;
  }
}

async function publishRawWebhook(eventId: string, eventMessage: any) {
  const connected = await initRedis();
  if (!connected || !redisProducer) {
    throw new Error('Redis producer is not connected');
  }

  const subscribers = await redisProducer.publish(
    REDIS_TOPIC,
    JSON.stringify({
      key: eventId,
      value: JSON.stringify(eventMessage),
    })
  );
  if (subscribers < 1) {
    throw new Error('No webhook event consumer is currently available');
  }
}

async function persistDeadLetter(eventId: string, eventMessage: any, reason: string) {
  const collection = await deadLetterCollection();
  await collection.updateOne(
    { eventId },
    {
      $set: {
        eventId,
        eventMessage,
        reason,
        status: 'pending',
        updatedAt: new Date(),
      },
      $setOnInsert: {
        attempts: 0,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

function parseJsonBuffer(body: unknown) {
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  if (typeof body === 'string') return JSON.parse(body);
  return body || {};
}

function isInternalRequest(headers: Record<string, any>) {
  return headers['x-internal-service-secret'] === INTERNAL_SECRET;
}

function getHeader(headers: Record<string, any>, name: string): string | undefined {
  const value = headers[name.toLowerCase()] || headers[name];
  if (Array.isArray(value)) return value[0];
  return value ? String(value) : undefined;
}

function providerHeaders(headers: Record<string, any>) {
  const allowed = [
    'x-gupshup-signature',
    'x-hub-signature-256',
    'x-delivery-id',
    'x-request-id',
    'content-type',
  ];

  return allowed.reduce<Record<string, string>>((acc, name) => {
    const value = getHeader(headers, name);
    if (value) acc[name] = value;
    return acc;
  }, {});
}

function resolveWebhookEventId(headers: Record<string, any>, payload: any, rawBody: string) {
  const firstChangeValue = payload?.entry?.[0]?.changes?.[0]?.value;
  const firstStatus = firstChangeValue?.statuses?.[0];
  const statusName = firstStatus?.status || firstStatus?.type;
  const statusProviderId =
    firstStatus?.messageId ||
    firstStatus?.whatsappMessageId ||
    firstStatus?.wamid ||
    firstStatus?.gs_id ||
    firstStatus?.gsId ||
    firstStatus?.id;
  if (!getHeader(headers, 'x-delivery-id') && !getHeader(headers, 'x-request-id') && statusProviderId && statusName) {
    return `status:${String(statusProviderId)}:${String(statusName)}`
      .replace(/[^a-zA-Z0-9._:-]+/g, '-')
      .slice(0, 180);
  }

  const providerId =
    payload?.payload?.id ||
    payload?.payload?.messageId ||
    payload?.payload?.gsId ||
    payload?.payload?.gs_id ||
    payload?.id ||
    payload?.messageId ||
    payload?.gsId ||
    payload?.gs_id ||
    firstChangeValue?.messages?.[0]?.id ||
    firstStatus?.id ||
    firstStatus?.gs_id ||
    firstStatus?.gsId;

  const fallbackDigest = crypto.createHash('sha256').update(rawBody).digest('hex');
  return String(getHeader(headers, 'x-delivery-id') || getHeader(headers, 'x-request-id') || providerId || fallbackDigest)
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .slice(0, 180);
}

// Custom raw body parser plugin for Fastify (so we can get the exact buffer for crypto)
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    done(null, body);
  } catch (err: any) {
    done(err);
  }
});

// --- HELPER: Signature Validator ---
// --- ENDPOINTS ---

// Webhook subscription validation endpoint (for Meta/Gupshup subscription setup)
server.get('/webhooks', async (req, reply) => {
  const query = req.query as Record<string, string>;
  const hubChallenge = query['hub.challenge'] || query['challenge'];
  const hubVerifyToken = query['hub.verify_token'] || query['verify_token'];

  const localVerifyToken = config.verifyToken;

  if (hubChallenge) {
    if (hubVerifyToken === localVerifyToken) {
      console.log('[Webhook Ingestor] Subscription validation successful.');
      return reply.status(200).send(hubChallenge);
    }
    return reply.status(403).send({ error: 'VERIFICATION_FAILED' });
  }

  // Gupshup performs a reachability probe without Meta's hub parameters before
  // it accepts a V3 subscription. This is only a liveness acknowledgement;
  // actual webhook POSTs still require a valid provider signature.
  return reply.status(200).send({ success: true, service: 'webhook-ingestor' });
});

server.get('/webhooks/:provider', async (req, reply) => {
  return server.inject({
    method: 'GET',
    url: `/webhooks?${new URLSearchParams(req.query as Record<string, string>).toString()}`,
  }).then((response) => reply.status(response.statusCode).send(response.body));
});

// Primary Webhook Ingestion endpoint
async function handleWebhookPost(req: any, reply: any, providerParam?: string) {
  const headers = req.headers;
  const rawBodyBuffer = req.body as Buffer;

  // Gupshup's subscription validator sends an empty POST to prove that the
  // callback is reachable.  Acknowledge only that empty probe; non-empty
  // callbacks continue through mandatory signature and JSON validation below.
  if (isEmptyWebhookProbe(rawBodyBuffer)) {
    return reply.status(200).send({ success: true, service: 'webhook-ingestor' });
  }

  if (!Buffer.isBuffer(rawBodyBuffer)) {
    return reply.status(400).send({ success: false, error: { code: 'INVALID_WEBHOOK_BODY', message: 'Webhook body must be JSON' } });
  }
  const rawBodyString = rawBodyBuffer.toString('utf8');

  const provider = normalizeWebhookProvider(providerParam || 'gupshup');
  metrics.increment('webhooks_received_total', 'Provider webhooks received', { provider: provider || 'unknown' });
  if (!provider) {
    return reply.status(400).send({ success: false, error: { code: 'UNSUPPORTED_WEBHOOK_PROVIDER', message: 'Unsupported webhook provider' } });
  }

  const signatureValid = verifyProviderSignature({
    provider,
    rawBody: rawBodyBuffer,
    headers,
    secrets: config.webhookSecrets,
  });
  if (!signatureValid && !config.allowUnsignedDevWebhooks) {
    metrics.increment('webhooks_rejected_total', 'Provider webhooks rejected', { provider, reason: 'signature' });
    server.log.warn({ event: 'security.webhook_rejected', provider, reason: 'invalid_signature' });
    return reply.status(401).send({ success: false, error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature verification failed' } });
  }
  metrics.increment('webhooks_verified_total', 'Provider webhooks cryptographically verified', { provider });

  let parsedPayload: any = {};
  try {
    parsedPayload = JSON.parse(rawBodyString);
  } catch (parseErr) {
    return reply.status(400).send({ error: 'INVALID_JSON_BODY' });
  }

  // 2. Resolve target partition or keys
  const eventId = resolveWebhookEventId(headers, parsedPayload, rawBodyString);

  const eventType = parsedPayload?.payload?.status || parsedPayload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]
    ? 'message.status'
    : 'message.inbound';

  // 3. Asynchronously push to EventBus (Non-blocking)
  const eventMessage = {
    eventId,
    eventType,
    provider,
    timestamp: new Date().toISOString(),
    rawBody: rawBodyString,
    headers: providerHeaders(headers),
    rawPayload: parsedPayload,
  };

  const receipts = await receiptCollection();
  try {
    await receipts.insertOne({ eventId, provider, status: 'received', eventMessage, createdAt: new Date(), updatedAt: new Date() });
  } catch (err: any) {
    if (err?.code === 11000) {
      const existing = await receipts.findOne({ eventId });
      if (existing?.status === 'published') {
        metrics.increment('webhooks_duplicates_total', 'Duplicate provider webhooks', { provider });
        return reply.status(200).send({ success: true, duplicate: true, eventId });
      }
    } else {
      throw err;
    }
  }

  try {
    await publishRawWebhook(eventId, eventMessage);
    await receipts.updateOne({ eventId }, { $set: { status: 'published', publishedAt: new Date(), updatedAt: new Date() } });
  } catch (eventErr: any) {
    metrics.increment('webhooks_processing_failed_total', 'Webhook processing failures', { provider });
    metrics.increment('webhooks_dead_lettered_total', 'Webhook events persisted for replay', { provider });
    server.log.error({ event: 'webhook.publish_failed', eventId, provider, error: eventErr.message });
    await receipts.updateOne({ eventId }, { $set: { status: 'pending', error: eventErr.message, updatedAt: new Date() } });
    await persistDeadLetter(eventId, eventMessage, eventErr.message);
    return reply.status(503).send({ success: false, error: { code: 'WEBHOOK_PROCESSING_UNAVAILABLE', message: 'Webhook processing is temporarily unavailable' }, eventId });
  }

  // 4. Instantly reply with 200 OK (Prevents timeouts & carrier duplicate retries)
  return reply.status(200).send({ success: true, eventId });
}

server.post('/webhooks', async (req, reply) => {
  return handleWebhookPost(req, reply);
});

server.post('/webhooks/:provider', async (req: any, reply) => {
  return handleWebhookPost(req, reply, req.params.provider);
});

server.post('/internal/v1/webhooks/replay', async (req, reply) => {
  if (!isInternalRequest(req.headers)) {
    return reply.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBuffer(req.body) as any;
  const limit = Math.min(parseInt(String(body.limit || 50), 10), 200);
  const collection = await deadLetterCollection();
  const pending = await collection.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(limit).toArray();

  let replayed = 0;
  const failed: Array<{ eventId: string; reason: string }> = [];

  for (const item of pending) {
    try {
      await publishRawWebhook(item.eventId, item.eventMessage);
      await (await receiptCollection()).updateOne(
        { eventId: item.eventId },
        { $set: { status: 'published', publishedAt: new Date(), updatedAt: new Date() } }
      );
      await collection.updateOne(
        { _id: item._id },
        { $set: { status: 'replayed', replayedAt: new Date(), updatedAt: new Date() }, $inc: { attempts: 1 } }
      );
      replayed += 1;
    } catch (err: any) {
      await collection.updateOne(
        { _id: item._id },
        { $set: { reason: err.message, updatedAt: new Date() }, $inc: { attempts: 1 } }
      );
      failed.push({ eventId: item.eventId, reason: err.message });
    }
  }

  return reply.send({ success: true, replayed, failed });
});

// Health check
server.get('/health', async () => {
  return {
    status: 'OK',
    redisConnected: !!redisProducer && redisProducer.status === 'ready' && !simulatedMode,
    mode: simulatedMode ? 'degraded' : 'live',
  };
});
server.get('/readiness', async (_req, reply) => {
  const redisReady = !!redisProducer && redisProducer.status === 'ready' && !simulatedMode;
  const mongoReady = !!mongoClient;
  const isReady = ready && redisReady && mongoReady;
  return reply.status(isReady ? 200 : 503).send({ status: isReady ? 'ready' : 'not_ready', redis: redisReady, mongo: mongoReady });
});
server.get('/metrics', async (_req, reply) => {
  reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return reply.send(metrics.render());
});

// Root path Tunnel check
server.get('/', async () => {
  return { service: 'wapi-webhook-ingestor', healthy: true };
});

async function start() {
  try {
    await initRedis();
    await deadLetterCollection();
    await receiptCollection();
    await server.listen({ port: PORT, host: '0.0.0.0' });
    ready = true;
    console.log(`[Webhook Ingestor] Server running at http://localhost:${PORT}`);
  } catch (err) {
    console.error('[Webhook Ingestor] Fatal startup error:', err);
    if (server.log) server.log.error(err);
    process.exit(1);
  }
}

start();

const shutdown = async (signal: string) => {
  ready = false;
  try { await server.close(); } catch { /* noop */ }
  try { redisProducer?.disconnect(); } catch { /* noop */ }
  try { await mongoClient?.close(); } catch { /* noop */ }
  console.log(`[Webhook Ingestor] ${signal} shutdown complete`);
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
