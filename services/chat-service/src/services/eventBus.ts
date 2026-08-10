import mongoose from 'mongoose';
import Redis from 'ioredis';
import { Conversation, Message, Contact } from '../models/index.js';
import config from '../config/index.js';

export let redisProducer: Redis | null = null;
export let redisConsumer: Redis | null = null;
export let simulatedMode = false;

// Shim for Redis Pub/Sub syntax to redis pubsub
export const eventProducer = {
  send: async (payload: { topic: string; messages: any[] }) => {
    if (!redisProducer) return;
    for (const msg of payload.messages) {
      await redisProducer.publish(
        payload.topic,
        JSON.stringify({
          key: msg.key,
          value: msg.value,
          headers: msg.headers || {},
        })
      );
    }
  },
};

export async function initEventBus() {
  const url = config.redisUrl;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Chat Service EventBus] REDIS_URL is missing in production');
    }
    simulatedMode = true;
    console.warn('[Chat Service EventBus] REDIS_URL missing. Running in simulated mode.');
    return;
  }

  try {
    redisProducer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    await redisProducer.connect();

    redisConsumer = new Redis(url);

    redisConsumer.subscribe('parsed-message-events', (err, count) => {
      if (err) {
        console.error('[Chat Service EventBus] Failed to subscribe to parsed-message-events');
      }
    });

    redisConsumer.on('message', async (topic, messageStr) => {
      if (topic !== 'parsed-message-events') return;

      const maxRetries = 3;
      let attempt = 0;
      let success = false;
      let lastError = null;

      let messageWrapper;
      try {
        messageWrapper = JSON.parse(messageStr);
      } catch (err) {
        console.error('[Chat Service EventBus] Invalid JSON:', err);
        return;
      }

      const value = messageWrapper.value;
      if (!value) return;

      while (attempt < maxRetries && !success) {
        try {
          attempt++;
          const parsed = JSON.parse(value);
          await processParsedMessage(parsed);
          success = true;
        } catch (err: any) {
          lastError = err;
          console.error(`[Chat Service EventBus] Attempt ${attempt} failed:`, err.message);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!success) {
        console.error(`[Chat Service EventBus] Message processing failed after ${maxRetries} attempts. Publishing to DLQ...`);
        try {
          await redisProducer?.publish(
            `${topic}-dlq`,
            JSON.stringify({
              key: messageWrapper.key,
              value: messageWrapper.value,
              headers: {
                ...messageWrapper.headers,
                'x-dead-letter-reason': lastError?.message || 'unknown',
                'x-dead-letter-attempts': String(maxRetries),
              }
            })
          );
          console.log(`[Chat Service EventBus] Successfully published dead letter to ${topic}-dlq`);
        } catch (dlqErr: any) {
          console.error('[Chat Service EventBus] Failed to publish dead letter to DLQ:', dlqErr.message);
        }
      }
    });

    console.log(`[Chat Service EventBus] Successfully connected and subscribed to "parsed-message-events"`);
  } catch (error: any) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`[Chat Service EventBus] Failed to connect to Redis at ${url}: ${error.message}`);
    }
    simulatedMode = true;
    console.warn(`[Chat Service EventBus] Failed to connect to Redis: ${error.message}. Running in local fallback mode.`);
  }
}

/**
 * Workspace business-hours check, ported from the monolith's
 * isWithinBusinessHoursLegacy. Used to flag inbound messages for
 * "outside business hours" auto-replies.
 */
function isWithinBusinessHours(settings: any): boolean {
  if (!settings?.businessHours?.enabled) return true;

  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const schedule = settings.businessHours.schedule?.find(
    (s: any) => String(s.day).toLowerCase() === dayName
  );
  if (!schedule || !schedule.enabled) return false;

  return currentTime >= schedule.startTime && currentTime <= schedule.endTime;
}

function serializeMessage(message: any) {
  const obj = message?.toObject ? message.toObject() : { ...(message || {}) };
  const body = obj.body || obj.text || obj.media?.caption || '';
  return {
    ...obj,
    body,
    text: obj.text || body,
    whatsappMessageId: obj.whatsappMessageId || obj.messageId,
    media: obj.media || (obj.mediaUrl ? {
      url: obj.mediaUrl,
      caption: body || undefined,
    } : undefined),
  };
}

export async function processParsedMessage(parsed: any) {
  // 1. Process Status Updates
  if (parsed.type === 'status_update') {
    console.log(`[Chat Service EventBus] Status update event. Message provider ID: ${parsed.messageId}, status: ${parsed.status}`);

    const statusMessageIds = Array.from(
      new Set([parsed.messageId, ...(Array.isArray(parsed.messageIds) ? parsed.messageIds : [])].filter(Boolean).map(String))
    );

    if (statusMessageIds.length === 0) {
      console.warn('[Chat Service EventBus] Status update skipped because no provider message ID was present.');
      return;
    }

    const chatMessage = await Message.findOne({
      workspace: new mongoose.Types.ObjectId(parsed.workspaceId),
      $or: [
        { messageId: { $in: statusMessageIds } },
        { whatsappMessageId: { $in: statusMessageIds } },
      ],
    });

    if (chatMessage) {
      await (chatMessage as any).updateStatus(parsed.status, parsed.timestamp);
      await Conversation.findByIdAndUpdate(chatMessage.conversation, { lastActivityAt: new Date() });

      const syncPayload = {
        workspaceId: parsed.workspaceId,
        conversationId: chatMessage.conversation.toString(),
        messageId: chatMessage._id.toString(),
        type: 'message_status_updated',
        timestamp: new Date().toISOString(),
        payload: {
          messageId: chatMessage._id.toString(),
          providerMessageId: chatMessage.messageId,
          whatsappMessageId: chatMessage.whatsappMessageId,
          conversationId: chatMessage.conversation.toString(),
          status: chatMessage.status,
          timestamp: new Date().toISOString()
        }
      };

      await redisProducer?.publish('chat-realtime-sync', JSON.stringify({
        key: chatMessage.conversation.toString(),
        value: JSON.stringify(syncPayload)
      }));

      console.log(`[Chat Service EventBus] Message status updated and sync event published. msgId: ${chatMessage._id}`);

      if (chatMessage.campaign && chatMessage.campaign.id) {
        const campaignEvent = {
          name: 'MessageStatusUpdateEvent',
          data: {
            campaignId: chatMessage.campaign.id.toString(),
            status: chatMessage.status,
            contactId: chatMessage.contact?.toString(),
            whatsappMessageId: chatMessage.messageId,
            timestamp: new Date().toISOString()
          },
          ts: Date.now()
        };

        await redisProducer?.publish('campaign-events', JSON.stringify({
          key: 'MessageStatusUpdateEvent',
          value: JSON.stringify(campaignEvent)
        }));
        console.log(`[Chat Service EventBus] ✓ Dispatched MessageStatusUpdateEvent to campaign-events topic for campaign ${chatMessage.campaign.id}`);
      }
    } else {
      console.warn(`[Chat Service EventBus] Message not found for status update. providerIds: ${statusMessageIds.join(',')}`);
    }
    return;
  }

  // 2. Process Inbound Messages
  console.log(`[Chat Service EventBus] Ingested message event. Id: ${parsed.messageId}, type: ${parsed.type}`);

  // Dedup: providers (and EventBus redelivery) can replay the same message.
  // The monolith skipped already-persisted provider message ids — do the same.
  if (parsed.messageId && parsed.workspaceId) {
    const existing = await Message.findOne({
      workspace: new mongoose.Types.ObjectId(parsed.workspaceId),
      messageId: parsed.messageId,
    }).select('_id').lean();
    if (existing) {
      console.log(`[Chat Service EventBus] Duplicate message ${parsed.messageId} ignored.`);
      return;
    }
  }

  // Provider webhook timestamp (seconds or ms) — used for ordering and the
  // 24h customer-service window. Falls back to now.
  const eventTimestamp = (() => {
    const numeric = Number(parsed.timestamp);
    if (!numeric || Number.isNaN(numeric)) return new Date();
    return new Date(numeric > 1e12 ? numeric : numeric * 1000);
  })();

  let contactObjectId: mongoose.Types.ObjectId | null = null;

  if (parsed.contactId && mongoose.Types.ObjectId.isValid(parsed.contactId)) {
    contactObjectId = new mongoose.Types.ObjectId(parsed.contactId);
  } else {
    const phone = parsed.senderPhone || parsed.contactId || parsed.to;
    if (phone && parsed.workspaceId) {
      const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
      const resolveRes = await fetch(`${contactServiceUrl}/internal/v1/contacts/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
          'x-workspace-id': parsed.workspaceId,
        },
        body: JSON.stringify({
          workspaceId: parsed.workspaceId,
          phone: phone,
          name: parsed.senderName || phone,
          ...(parsed.direction !== 'outbound'
            ? { lastInboundAt: eventTimestamp.toISOString() }
            : {}),
        }),
      });

      if (resolveRes.ok) {
        const resolveData = await resolveRes.json() as any;
        if (resolveData && resolveData.success && resolveData.data?._id) {
          contactObjectId = new mongoose.Types.ObjectId(resolveData.data._id);
        }
      }
    }
  }

  if (!contactObjectId) {
    throw new Error(`contactId could not be resolved for phone ${parsed.senderPhone}`);
  }

  let conversation = await Conversation.findOne({
    workspace: new mongoose.Types.ObjectId(parsed.workspaceId),
    contact: contactObjectId,
  });

  if (!conversation && parsed.workspaceId) {
    conversation = await Conversation.create({
      workspace: new mongoose.Types.ObjectId(parsed.workspaceId),
      contact: contactObjectId,
      status: 'open',
      isOpen: true,
      lastActivityAt: eventTimestamp,
      conversationType: (parsed.direction || 'inbound') === 'inbound' ? 'customer_initiated' : 'business_initiated',
      conversationStartedAt: eventTimestamp,
    });
  }

  if (conversation) {
    const messageType = parsed.type === 'status_update' ? 'text' : parsed.type;
    const chatMessage = await Message.create({
      workspace: conversation.workspace,
      conversation: conversation._id,
      contact: contactObjectId,
      direction: parsed.direction || 'inbound',
      type: messageType,
      text: parsed.text || '',
      body: parsed.text || '',
      mediaUrl: parsed.mediaUrl || '',
      messageId: parsed.messageId,
      status: parsed.direction === 'inbound' ? 'delivered' : 'sent',
      sentAt: eventTimestamp,
    });

    // Restore the monolith's full inbound conversation lifecycle: inbox-list
    // preview fields, unread counters, reopen-on-inbound and the 24h
    // customer-service window stamp.
    const isInbound = (parsed.direction || 'inbound') === 'inbound';
    let workspaceDoc: any = null;
    if (isInbound) {
      try {
        workspaceDoc = await Conversation.db
          .useDb('wapi')
          .collection('workspaces')
          .findOne(
            { _id: conversation.workspace },
            { projection: { inboxSettings: 1, settings: 1 } }
          );
      } catch (wsErr: any) {
        console.error('[Chat Service EventBus] Workspace lookup failed:', wsErr?.message || wsErr);
      }

      const preview =
        messageType === 'text'
          ? String(parsed.text || '').substring(0, 100)
          : `[${messageType}]`;

      conversation.set({
        lastInboundAt: eventTimestamp,
        lastCustomerMessageAt: eventTimestamp,
        lastActivityAt: eventTimestamp,
        lastMessageAt: eventTimestamp,
        lastMessagePreview: preview,
        lastMessageDirection: 'inbound',
        lastMessageType: messageType,
        isOpen: true,
        status: 'open',
        windowExpiresAt: new Date(eventTimestamp.getTime() + 24 * 60 * 60 * 1000),
      });
      conversation.messageCount = (conversation.messageCount || 0) + 1;
      (conversation as any).incrementUnreadForAllAgents();
      await conversation.save();

      // Auto-assignment (monolith parity): assign unassigned conversations
      // when the workspace has auto-assignment enabled.
      if (!conversation.assignedTo && workspaceDoc?.inboxSettings?.autoAssignmentEnabled) {
        try {
          const { AutoAssignService } = await import('./auto-assign-service.js');
          await AutoAssignService.assign(conversation.workspace, conversation._id).catch(() => { });
        } catch (assignErr: any) {
          console.error('[Chat Service EventBus] Auto-assign failed:', assignErr?.message || assignErr);
        }
      }
    } else {
      await Conversation.findByIdAndUpdate(conversation._id, { lastActivityAt: eventTimestamp });
    }

    const contactDoc = contactObjectId ? await Contact.findById(contactObjectId).lean() : null;
    const syncPayload = {
      workspaceId: conversation.workspace.toString(),
      conversationId: conversation._id.toString(),
      messageId: chatMessage._id.toString(),
      type: 'message_created',
      timestamp: new Date().toISOString(),
      payload: serializeMessage(chatMessage),
      contact: contactDoc ? {
        _id: (contactDoc as any)._id.toString(),
        name: (contactDoc as any).name || 'Unknown',
        phone: (contactDoc as any).phone || '',
      } : null
    };

    await redisProducer?.publish('chat-realtime-sync', JSON.stringify({
      key: conversation._id.toString(),
      value: JSON.stringify(syncPayload)
    }));

    console.log(`[Chat Service EventBus] Message appended and real-time sync event published. messageId: ${parsed.messageId}`);

    // Hand the inbound message to the automation engine (auto-replies, answer-bot,
    // AI-intent matching, keyword workflows). Mirrors the monolith's
    // processInbound -> AutomationClient.handleInbound hand-off. Fire-and-forget so
    // message persistence is never blocked on the automation round-trip.
    if ((parsed.direction || 'inbound') === 'inbound') {
      void fetch(`${config.automationServiceUrl}/api/automation/engine/trigger-inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
        },
        body: JSON.stringify({
          workspaceId: conversation.workspace.toString(),
          contactId: contactObjectId.toString(),
          conversationId: conversation._id.toString(),
          messageId: chatMessage._id.toString(),
          body: parsed.text || '',
          phone: parsed.senderPhone || '',
          metadata: {
            ...(parsed.metadata || {}),
            type: parsed.type,
            channel: parsed.metadata?.channel || parsed.channel,
            provider: parsed.metadata?.provider || parsed.provider,
          },
          isOutsideBusinessHours: !isWithinBusinessHours(workspaceDoc?.settings),
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            console.error(`[Chat Service EventBus] Automation trigger returned ${r.status} for message ${parsed.messageId}`);
          }
        })
        .catch((err) => {
          console.error('[Chat Service EventBus] Automation trigger failed:', err?.message || err);
        });
    }
  }
}

export async function replayDlq(dlqTopic: string, limit: number = 50) {
  if (simulatedMode || !redisProducer) {
    return { success: false, message: 'Redis not connected or running in simulated mode' };
  }

  // NOTE: Pub/Sub doesn't natively support DLQ replay because messages aren't persisted.
  // This is a stub left for compatibility with the old API.
  return { success: false, message: 'DLQ replay is not supported with Redis Pub/Sub.' };
}
