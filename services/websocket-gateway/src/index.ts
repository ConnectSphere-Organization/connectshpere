import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose, { Schema } from 'mongoose';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { config } from './config/env.js';
import { MetricsRegistry } from '@connectsphere/contracts';

const app = express();
const httpServer = createServer(app);
const PORT = config.port;
const JWT_SECRET = config.jwtSecret;
const AUTH_SERVICE_URL = config.authServiceUrl;
const AUTH_SERVICE_TIMEOUT_MS = config.authServiceTimeoutMs;
const metrics = new MetricsRegistry('websocket-gateway');
let ready = false;


const allowedOrigins = config.allowedOrigins;
const allowAnyOrigin = allowedOrigins.includes('*');
const allowedOriginSet = new Set(allowedOrigins);

function isAllowedCloudRunFrontendOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return url.protocol === 'https:' &&
      host.endsWith('.run.app') &&
      (host.startsWith('customer-portal-') || host.startsWith('admin-portal-'));
  } catch {
    return false;
  }
}

const corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  if (!origin || allowAnyOrigin || allowedOriginSet.has(origin) || isAllowedCloudRunFrontendOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by websocket CORS`), false);
};

// Normalize /socket.io? -> /socket.io/? so Engine.IO matches regardless of trailing slash
httpServer.prependListener('request', (req) => {
  if (req.url && req.url.startsWith('/socket.io?')) {
    req.url = req.url.replace('/socket.io?', '/socket.io/?');
  }
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

io.on('connection', (socket) => {
  metrics.increment('websocket_connections_total', 'Accepted WebSocket connections');
  metrics.gauge('websocket_active_connections', 'Current active WebSocket connections', io.engine.clientsCount);
  socket.on('disconnect', () => metrics.gauge('websocket_active_connections', 'Current active WebSocket connections', io.engine.clientsCount));
});

// Database connection
async function connectDb() {
  try {
    mongoose.set('bufferCommands', false);
    await mongoose.connect(config.mongoUri);
    console.log(`[WebSocket Gateway] Connected to MongoDB`);
  } catch (err: any) {
    console.error(`[WebSocket Gateway] Database connection failed: ${err.message}`);
    process.exit(1);
  }
}

// Minimal Permission Schema for socket auth checks
const PermissionSchema = new Schema({
  workspace: { type: Schema.Types.ObjectId, required: true },
  user: { type: Schema.Types.ObjectId, required: true },
  isActive: { type: Boolean, default: true },
});
const Permission = mongoose.models.Permission || mongoose.model('Permission', PermissionSchema);

// Room Helpers
async function userIsWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  if (!userId || !workspaceId) return false;
  if (!mongoose.isValidObjectId(workspaceId)) return false;
  try {
    const membership = await Permission.findOne({
      user: new mongoose.Types.ObjectId(userId),
      workspace: new mongoose.Types.ObjectId(workspaceId),
      isActive: { $ne: false },
    });
    return !!membership;
  } catch (err) {
    return false;
  }
}

function toSocketId(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id) return toSocketId(value._id);
  if (typeof value.toString === 'function') {
    const id = value.toString();
    return id && id !== '[object Object]' ? id : undefined;
  }
  return undefined;
}

function serializeUnreadCounts(value: any): Record<string, number> {
  if (!value) return {};
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, count]) => [String(key), Number(count) || 0])
    );
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, count]) => [String(key), Number(count) || 0])
    );
  }
  return {};
}

function toSocketPlainValue(value: any, seen = new WeakSet<object>()): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (ArrayBuffer.isView(value)) return Array.from(value as any);

  if (seen.has(value)) return undefined;
  seen.add(value);

  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, mapValue]) => [
        String(key),
        toSocketPlainValue(mapValue, seen),
      ])
    );
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => toSocketPlainValue(item, seen))
      .filter((item) => item !== undefined);
  }

  const source = typeof value.toObject === 'function'
    ? value.toObject({ depopulate: true, virtuals: false, getters: false })
    : value;

  const output: Record<string, any> = {};
  for (const [key, entryValue] of Object.entries(source)) {
    if (typeof entryValue === 'function') continue;
    if (key.startsWith('$')) continue;

    const plainValue = toSocketPlainValue(entryValue, seen);
    if (plainValue !== undefined) {
      output[key] = plainValue;
    }
  }

  return output;
}

function normalizeSocketMessage(message: any) {
  const plain = toSocketPlainValue(message) || {};
  const body = plain.body || plain.text || plain.media?.caption || plain.lastMessagePreview || '';

  return {
    ...plain,
    _id: toSocketId(plain._id) || plain._id,
    id: toSocketId(plain.id) || plain.id,
    workspace: toSocketId(plain.workspace) || plain.workspace,
    conversation: toSocketId(plain.conversation) || plain.conversation,
    contact: toSocketPlainValue(plain.contact),
    body,
    text: plain.text || body,
    whatsappMessageId: plain.whatsappMessageId || plain.messageId,
    createdAt: plain.createdAt || plain.sentAt || plain.timestamp || new Date().toISOString(),
  };
}

function normalizeRealtimeEnvelope(envelope: any) {
  const plain = toSocketPlainValue(envelope) || {};
  return {
    ...plain,
    workspaceId: toSocketId(plain.workspaceId) || plain.workspaceId,
    conversationId: toSocketId(plain.conversationId) || plain.conversationId,
    messageId: toSocketId(plain.messageId) || plain.messageId,
    payload: plain.type === 'message_created'
      ? normalizeSocketMessage(plain.payload)
      : toSocketPlainValue(plain.payload),
    contact: toSocketPlainValue(plain.contact),
    conversation: toSocketPlainValue(plain.conversation),
  };
}

function serializeConversationForSocket(conversation: any, contactPayload: any) {
  if (!conversation) return null;
  const plain = toSocketPlainValue(conversation) || {};
  return {
    _id: toSocketId(plain._id),
    contact: toSocketPlainValue(contactPayload || plain.contact),
    channel: plain.channel || 'whatsapp',
    assignedTo: toSocketId(plain.assignedTo),
    team: toSocketId(plain.team),
    status: plain.status || 'open',
    priority: plain.priority || 'normal',
    unreadCount: Number(plain.unreadCount) || 0,
    agentUnreadCounts: serializeUnreadCounts(plain.agentUnreadCounts),
    lastActivityAt: plain.lastActivityAt,
    lastMessageAt: plain.lastMessageAt,
    lastMessagePreview: plain.lastMessagePreview,
    lastMessageDirection: plain.lastMessageDirection,
    lastMessageType: plain.lastMessageType,
    isOpen: plain.isOpen,
    windowExpiresAt: plain.windowExpiresAt,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function verifySessionWithAuthService(token: string) {
  if (!AUTH_SERVICE_URL) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);

  try {
    const response = await fetch(`${AUTH_SERVICE_URL.replace(/\/+$/, '')}/internal/v1/auth/verify-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('Unauthorized: authentication failed');
    }

    if (!response.ok) return null;

    const session = await response.json() as any;
    if (!session?.success) return null;

    const userId = toSocketId(session.user?._id || session.user?.id);
    if (!userId) return null;

    return {
      userId,
      workspaceId: toSocketId(
        session.workspace?._id ||
        session.workspace?.id ||
        session.user?.activeWorkspace ||
        session.user?.workspace
      ),
      role: session.user?.role,
      workspaceRole: session.role,
      isSuperAdmin: session.user?.role === 'super_admin',
    };
  } catch (err: any) {
    if (err?.message?.startsWith('Unauthorized')) {
      throw err;
    }
    console.warn(`[WebSocket Gateway] Auth service session verification unavailable: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// --- SOCKET AUTH MIDDLEWARE ---
io.use(async (socket: any, next) => {
  try {
    let token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token && socket.handshake.headers?.cookie) {
      const parsed = socket.handshake.headers.cookie
        .split(';')
        .map((p: string) => p.trim())
        .find((p: string) => p.startsWith('auth_token='));
      if (parsed) token = parsed.slice('auth_token='.length);
    }

    if (!token) {
      metrics.increment('websocket_authentication_failures_total', 'WebSocket authentication failures', { reason: 'missing_token' });
      return next(new Error('Unauthorized: missing auth token'));
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded || !decoded.id) {
      metrics.increment('websocket_authentication_failures_total', 'WebSocket authentication failures', { reason: 'invalid_token' });
      return next(new Error('Unauthorized: invalid token'));
    }

    const verifiedSession = await verifySessionWithAuthService(token);

    socket.userId = verifiedSession?.userId || decoded.id;
    socket.workspaceId = verifiedSession?.workspaceId || (decoded.workspaceId ? String(decoded.workspaceId) : undefined);
    socket.workspaceRole = verifiedSession?.workspaceRole;
    socket.isSuperAdmin = verifiedSession?.isSuperAdmin || decoded.role === 'super_admin';
    console.log(`[WebSocket Gateway] Authenticated user: ${socket.userId}${socket.workspaceId ? ` workspace:${socket.workspaceId}` : ''}`);
    next();
  } catch (err: any) {
    metrics.increment('websocket_authentication_failures_total', 'WebSocket authentication failures', { reason: 'verification_failed' });
    next(new Error('Unauthorized: authentication failed'));
  }
});

// --- SOCKET CONNECTIONS & EVENTS ---
io.on('connection', (socket: any) => {
  console.log(`[WebSocket Gateway] Agent socket connected: ${socket.id}`);

  // Personal room — lets services target a single user (e.g. assignment
  // notifications) without broadcasting to the whole workspace.
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
  }

  // Heartbeat ping
  socket.emit('server:ping', { status: 'OK', serverTime: new Date().toISOString() });

  // Join Workspace Room
  socket.on('workspace:join', async (data: { workspaceId: string }) => {
    const { workspaceId } = data;
    if (!workspaceId) return;

    const isTokenWorkspace = socket.workspaceId && String(socket.workspaceId) === String(workspaceId);
    const isMember = isTokenWorkspace || await userIsWorkspaceMember(socket.userId, workspaceId);
    if (!isMember && !socket.isSuperAdmin) {
      socket.emit('socket:error', { event: 'workspace:join', reason: 'forbidden' });
      return;
    }

    const workspaceRoom = `workspace:${workspaceId}`;
    socket.join(workspaceRoom);
    console.log(`[WebSocket Gateway] User joined workspace room: ${workspaceRoom}`);
    socket.to(workspaceRoom).emit('agent:online', { userId: socket.userId });
  });

  // Leave Workspace Room
  socket.on('workspace:leave', (data: { workspaceId: string }) => {
    const { workspaceId } = data;
    if (workspaceId) {
      socket.leave(`workspace:${workspaceId}`);
    }
  });

  // Join Conversation Details Room
  socket.on('conversation:join', async (data: { conversationId: string; workspaceId: string }) => {
    const { conversationId, workspaceId } = data;
    if (!conversationId || !workspaceId) return;

    const isTokenWorkspace = socket.workspaceId && String(socket.workspaceId) === String(workspaceId);
    const isMember = isTokenWorkspace || await userIsWorkspaceMember(socket.userId, workspaceId);
    if (!isMember && !socket.isSuperAdmin) {
      socket.emit('socket:error', { event: 'conversation:join', reason: 'forbidden' });
      return;
    }

    const conversationRoom = `conversation:${conversationId}`;
    socket.join(conversationRoom);
    console.log(`[WebSocket Gateway] User joined conversation room: ${conversationRoom}`);
  });

  // Leave Conversation Details Room
  socket.on('conversation:leave', (data: { conversationId: string }) => {
    const { conversationId } = data;
    if (conversationId) {
      socket.leave(`conversation:${conversationId}`);
    }
  });

  // Typing state propagation
  socket.on('typing', (data: { conversationId: string; workspaceId: string; isTyping: boolean }) => {
    const { conversationId, workspaceId, isTyping } = data;
    if (!conversationId || !workspaceId) return;

    const payload = { conversationId, isTyping, userId: socket.userId };
    socket.to(`conversation:${conversationId}`).emit('conversation:typing', payload);
    socket.to(`workspace:${workspaceId}`).emit('inbox:typing', payload);
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket Gateway] Socket disconnected: ${socket.id}`);
  });
});

// --- REDIS PUB/SUB EVENT LISTENER ---
let redisProducer: Redis | null = null;
let redisConsumer: Redis | null = null;

async function processRealtimeSyncEvent(envelope: any) {
  const safeEnvelope = normalizeRealtimeEnvelope(envelope);
  const workspaceRoom = `workspace:${safeEnvelope.workspaceId}`;
  const conversationId = safeEnvelope.conversationId || safeEnvelope.payload?.conversationId;
  const conversationRoom = conversationId ? `conversation:${conversationId}` : null;
  const emitToInboxRooms = (event: string, payload: any) => {
    const target = conversationRoom ? io.to(workspaceRoom).to(conversationRoom) : io.to(workspaceRoom);
    target.emit(event, payload);
  };

  // Personal notifications target only the recipient's room — never the
  // whole workspace. Payload shape matches the frontend socket-hub handler
  // ({ title, message, type }).
  if (safeEnvelope.type === 'notification') {
    if (safeEnvelope.recipientId) {
      // The frontend handler calls toast[type], which only knows these four —
      // map domain types like 'assignment' to 'info'.
      const toastTypes = ['success', 'info', 'error', 'warning'];
      const payload = {
        ...safeEnvelope.payload,
        type: toastTypes.includes(safeEnvelope.payload?.type) ? safeEnvelope.payload.type : 'info',
      };
      io.to(`user:${safeEnvelope.recipientId}`).emit('workspace:notification', payload);
    }
    return;
  }

  // Map and emit exact frontend-compatible Socket.io events. Use Socket.io's
  // room union operator so sockets joined to both workspace and conversation
  // receive each logical update once.
  if (safeEnvelope.type === 'message_created') {
    const db = mongoose.connection.db;
    if (!db) {
      console.error('[WS Gateway EventBus] Database connection db object is missing.');
      return;
    }

    // Fetch Conversation and Contact to construct full inbox:message_new payload
    let conversationPayload = safeEnvelope.conversation || null;
    let contactPayload = safeEnvelope.contact || null;
    try {
      if (!conversationPayload) {
        conversationPayload = await db.collection('conversations').findOne({
          _id: new mongoose.Types.ObjectId(safeEnvelope.conversationId),
        });
      }

      if (!contactPayload && conversationPayload?.contact) {
        const contact = await db.collection('contacts').findOne({
          _id: conversationPayload.contact,
        });
        if (contact) {
          contactPayload = {
            _id: contact._id.toString(),
            name: contact.name || 'Unknown',
            phone: contact.phone || '',
          };
        }
      }
    } catch (dbErr: any) {
      console.error('[WS Gateway EventBus] MongoDB lookup error:', dbErr.message);
    }

    const messagePayload = normalizeSocketMessage(safeEnvelope.payload);
    const socketMsgPayload = {
      conversationId: safeEnvelope.conversationId,
      message: messagePayload,
      contact: toSocketPlainValue(contactPayload),
      conversation: serializeConversationForSocket(conversationPayload, contactPayload),
    };

    // Emit frontend compatible new message event
    emitToInboxRooms('inbox:message_new', socketMsgPayload);

    // Also emit legacy compatibility events
    if (conversationRoom) {
      io.to(conversationRoom).emit('message:created', messagePayload);
    }
    console.log(`[WS Gateway EventBus] Broadcasted inbox:message_new for messageId: ${safeEnvelope.messageId}`);
  }
  else if (safeEnvelope.type === 'message_status_updated' || safeEnvelope.type === 'message_status_changed') {
    const statusPayload = {
      messageId: safeEnvelope.payload?.messageId || safeEnvelope.messageId,
      providerMessageId: safeEnvelope.payload?.providerMessageId,
      whatsappMessageId: safeEnvelope.payload?.whatsappMessageId,
      conversationId,
      status: (safeEnvelope.payload?.status || '').toLowerCase(),
      timestamp: safeEnvelope.payload?.timestamp || safeEnvelope.timestamp,
    };

    emitToInboxRooms('inbox:message_status', statusPayload);
    console.log(`[WS Gateway EventBus] Broadcasted inbox:message_status status: ${statusPayload.status}`);
  }
  else if (safeEnvelope.type === 'conversation_status_changed') {
    const updatePayload = {
      conversationId: safeEnvelope.conversationId,
      status: safeEnvelope.payload?.status,
      isOpen: safeEnvelope.payload?.status === 'open',
      lastActivityAt: safeEnvelope.timestamp,
    };

    emitToInboxRooms('inbox:conversation_updated', updatePayload);
    io.to(workspaceRoom).emit('conversation:updated', updatePayload);
    if (conversationRoom) {
      io.to(conversationRoom).emit('conversation:status-updated', safeEnvelope.payload);
    }
    console.log(`[WS Gateway EventBus] Broadcasted inbox:conversation_updated status: ${updatePayload.status}`);
  }
  else if (safeEnvelope.type === 'conversation_read' || safeEnvelope.type === 'conversation_updated') {
    const updatePayload = {
      conversationId: safeEnvelope.conversationId || safeEnvelope.payload?.conversationId,
      ...safeEnvelope.payload,
      updatedAt: safeEnvelope.timestamp,
    };

    emitToInboxRooms('inbox:conversation_updated', updatePayload);
    io.to(workspaceRoom).emit('conversation:updated', updatePayload);
    console.log(`[WS Gateway EventBus] Broadcasted inbox:conversation_updated for conversation: ${updatePayload.conversationId}`);
  }
  else {
    // Fallback for newer producers that do not have a dedicated frontend event
    // yet. Keep it off known inbox event paths to avoid double-processing.
    io.to(workspaceRoom).emit('inbox:sync', safeEnvelope);
  }
}

async function processPlatformEvent(topic: string, envelope: any) {
  const safeEnvelope = toSocketPlainValue(envelope) || {};
  const workspaceId = safeEnvelope.workspaceId || safeEnvelope.payload?.workspaceId;
  if (!workspaceId) return;

  const workspaceRoom = `workspace:${workspaceId}`;
  io.to(workspaceRoom).emit('platform:event', { topic, ...safeEnvelope });

  if (topic === 'contact-events') {
    io.to(workspaceRoom).emit('contact:updated', safeEnvelope);
    io.to(workspaceRoom).emit('inbox:contact_updated', safeEnvelope);
  } else if (topic === 'automation-events') {
    io.to(workspaceRoom).emit('automation:event', safeEnvelope);
    io.to(workspaceRoom).emit('automation:execution_update', safeEnvelope);
  } else if (topic === 'billing-events') {
    io.to(workspaceRoom).emit('billing:event', safeEnvelope);
    if (safeEnvelope.event === 'wallet_recharged') {
      io.to(workspaceRoom).emit('wallet:recharged', safeEnvelope.payload);
    }
  } else if (topic === 'campaign-events' || topic === 'billing-events') {
    io.to(workspaceRoom).emit('campaign:event', safeEnvelope);
  }
}

const REDIS_URL = config.redisUrl;

async function initEventBus() {
  try {
    redisProducer = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
    await redisProducer.connect();

    redisConsumer = new Redis(REDIS_URL);
    const topics = ['chat-realtime-sync', 'contact-events', 'automation-events', 'billing-events', 'campaign-events'];

    redisConsumer.subscribe(...topics, (err, count) => {
      if (err) {
        console.error('[WS Gateway EventBus] Failed to subscribe to topics:', err);
      } else {
        console.log(`[WS Gateway EventBus] Successfully subscribed to ${count} topics`);
      }
    });

    redisConsumer.on('message', async (topic, messageStr) => {
      let wrapper;
      try {
        wrapper = JSON.parse(messageStr);
      } catch (e) {
        console.error('[WS Gateway EventBus] Invalid JSON payload');
        return;
      }

      const value = wrapper.value;
      if (!value) return;

      const maxRetries = 3;
      let attempt = 0;
      let success = false;
      let lastError: any = null;

      while (attempt < maxRetries && !success) {
        try {
          attempt++;
          const envelope = JSON.parse(value);
          console.log(`[WS Gateway EventBus] Event ingested. Topic: ${topic}, Type: ${envelope.type || envelope.event}, workspaceId: ${envelope.workspaceId}, attempt: ${attempt}`);
          if (topic === 'chat-realtime-sync') {
            await processRealtimeSyncEvent(envelope);
          } else {
            await processPlatformEvent(topic, envelope);
          }
          success = true;
        } catch (err: any) {
          lastError = err;
          console.error(`[WS Gateway EventBus] Attempt ${attempt} failed:`, err.message);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!success) {
        console.error(`[WS Gateway EventBus] Sync broadcast failed after ${maxRetries} attempts. Publishing to DLQ...`);
        try {
          const dlqTopic = `${topic}-dlq`;
          await redisProducer?.publish(dlqTopic, JSON.stringify({
            key: wrapper.key,
            value: wrapper.value,
            headers: {
              ...wrapper.headers,
              'x-dead-letter-reason': lastError?.message || 'unknown',
              'x-dead-letter-attempts': String(maxRetries),
            }
          }));
          console.log(`[WS Gateway EventBus] Successfully published dead letter to ${dlqTopic}`);
        } catch (dlqErr: any) {
          console.error('[WS Gateway EventBus] Failed to publish dead letter to DLQ:', dlqErr.message);
        }
      }
    });

  } catch (error: any) {
    console.warn(`[WS Gateway EventBus] Failed to connect to Redis: ${error.message}. Running in local isolation.`);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'wapi-websocket-gateway' });
});
app.get('/readiness', (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const redisReady = !!redisProducer && redisProducer.status === 'ready';
  const isReady = ready && mongoReady && redisReady;
  res.status(isReady ? 200 : 503).json({ status: isReady ? 'ready' : 'not_ready', mongo: mongoReady, redis: redisReady });
});
app.get('/metrics', (_req, res) => {
  metrics.gauge('websocket_active_connections', 'Current active WebSocket connections', io.engine.clientsCount);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.render());
});

async function initRedisAdapter() {
  try {
    const pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err: Error) => console.error('[WebSocket Gateway Redis] Pub client error:', err));
    subClient.on('error', (err: Error) => console.error('[WebSocket Gateway Redis] Sub client error:', err));

    io.adapter(createAdapter(pubClient, subClient));
    console.log('[WebSocket Gateway] Redis Adapter connected successfully');
  } catch (err: any) {
    console.warn(`[WebSocket Gateway] Failed to connect to Redis Adapter: ${err.message}. Running in local memory adapter.`);
  }
}

async function start() {
  await connectDb();
  await initRedisAdapter();
  await initEventBus();
  httpServer.listen(PORT, '0.0.0.0', () => {
    ready = true;
    console.log(`[WebSocket Gateway] Running at http://localhost:${PORT}`);
  });
}

start();

const shutdown = (signal: string) => {
  ready = false;
  io.close();
  httpServer.close(async () => {
    try { redisProducer?.disconnect(); redisConsumer?.disconnect(); } catch { /* noop */ }
    await mongoose.connection.close(false);
    console.log(`[WebSocket Gateway] ${signal} shutdown complete`);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 45_000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
