import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import { Conversation, Message, Contact, User, Team, Permission, Pipeline } from '../models/index.js';
import { eventProducer, simulatedMode } from '../services/eventBus.js';
import { isSessionWindowOpen, applyOutboundConversationUpdate } from '../services/conversation-lifecycle.js';
import { NotificationService } from '../services/notification-service.js';
import { logActivity } from '../services/activity-log.js';
import { chargeTemplateMessage, refundTemplateCharge } from '../services/billing-client.js';

async function fetchContactByIdForWorkspace(contactId: string, workspaceId: mongoose.Types.ObjectId) {
  const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
  const response = await fetch(`${contactServiceUrl}/internal/v1/contacts/${contactId}`, {
    headers: {
      'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET || '',
      'x-workspace-id': workspaceId.toString(),
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Contact Service lookup failed with status ${response.status}`);
  }

  const payload = await response.json() as any;
  return payload?.data || null;
}

function serializeMessage(message: any) {
  const obj = message?.toObject ? message.toObject() : { ...(message || {}) };
  const body = obj.body || obj.text || templatePreviewText(obj.template) || obj.media?.caption || '';
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

function templatePreviewText(template: any) {
  if (!template) return '';
  if (typeof template.bodyText === 'string') return template.bodyText;
  if (typeof template.body?.text === 'string') return template.body.text;
  const components = Array.isArray(template.components) ? template.components : [];
  const bodyComponent = components.find((component: any) => String(component?.type || '').toUpperCase() === 'BODY');
  return typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
}

function serializeMessages(messages: any[]) {
  return messages.map(serializeMessage);
}

// --- Internal routes ---

export const getConversationsInternal = async (req: express.Request, res: express.Response) => {
  try {
    const workspaceId = req.headers['x-workspace-id'];
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Missing workspace context header' });
    }

    const { status = 'open', limit = 100 } = req.query as any;
    const boundedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 200);

    const list = await Conversation.find({
      workspace: new mongoose.Types.ObjectId(workspaceId as string),
      status,
    }).sort({ lastActivityAt: -1 }).limit(boundedLimit).lean();

    return res.status(200).json({ success: true, data: list });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getTimelineMessagesInternal = async (req: express.Request, res: express.Response) => {
  try {
    const workspaceId = req.headers['x-workspace-id'];
    const { id } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Missing workspace context header' });
    }

    const boundedLimit = Math.min(Math.max(parseInt(String(req.query.limit || 100), 10) || 100, 1), 200);
    const list = await Message.find({
      workspace: new mongoose.Types.ObjectId(workspaceId as string),
      conversation: new mongoose.Types.ObjectId(id),
    }).sort({ sentAt: -1 }).limit(boundedLimit).lean();

    return res.status(200).json({ success: true, data: serializeMessages(list) });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const patchConversationStatusInternal = async (req: express.Request, res: express.Response) => {
  try {
    const workspaceId = req.headers['x-workspace-id'];
    const { id } = req.params;
    const { status } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Missing workspace context header' });
    }

    const conversation = await Conversation.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), workspace: new mongoose.Types.ObjectId(workspaceId as string) },
      { $set: { status, isOpen: status === 'open', lastActivityAt: new Date() } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    // Publish WebSocket sync event
    if (eventProducer && !simulatedMode) {
      const syncPayload = {
        workspaceId: workspaceId.toString(),
        conversationId: id,
        type: 'conversation_status_changed',
        timestamp: new Date().toISOString(),
        payload: { status },
      };
      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: id, value: JSON.stringify(syncPayload) }],
      });
    }

    return res.status(200).json({ success: true, data: conversation });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// --- Authenticated Public routes ---

export const getConversationsPublic = async (req: any, res: express.Response) => {
  try {
    const user = req.user;
    const workspace = req.workspace;
    const workspaceId = workspace?._id;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const view = req.query.view as string || "mine";
    const statusParam = req.query.status as string;
    const sessionParam = req.query.session as string;
    const channel = req.query.channel as string;
    const search = req.query.search as string;
    const page = parseInt(req.query.page as string || "1", 10);
    const limit = parseInt(req.query.limit as string || "50", 10);

    const [permission, userTeams] = await Promise.all([
      Permission.findOne({ workspace: workspaceId, user: user._id }).lean(),
      Team.find({
        workspace: workspaceId,
        'members.user': user._id,
        isActive: true
      })
    ]);

    const workspaceRole = (permission as any)?.role || req.role || user.role;
    const isSuperAdmin = user.role === 'super_admin';
    const hasAllAccess = isSuperAdmin
      || ['owner', 'admin', 'manager'].includes(workspaceRole)
      || (permission as any)?.permissions?.viewAllConversations;
    const userTeamIds = userTeams.map((t: any) => t._id);

    const query: any = { workspace: workspaceId };

    if (view === 'mine') {
      query.assignedTo = user._id;
      query.status = { $ne: 'spam' };
    } else if (view === 'unassigned') {
      query.assignedTo = null;
      query.status = { $ne: 'spam' };
      if (!hasAllAccess) {
        if (userTeamIds.length > 0) {
          query.team = { $in: userTeamIds };
        } else {
          query.team = null;
        }
      }
    } else if (view === 'team') {
      if (userTeamIds.length > 0) {
        const leadTeamIds = userTeams
          .filter((t: any) => t.members.some((m: any) => m.user.toString() === user._id.toString() && m.role === 'lead'))
          .map((t: any) => t._id);

        if (hasAllAccess || leadTeamIds.length > 0) {
          const targetTeamIds = hasAllAccess ? userTeamIds : leadTeamIds;
          const memberIds = [
            ...new Set(
              userTeams
                .filter((t: any) => targetTeamIds.includes(t._id))
                .flatMap((t: any) => t.members.map((m: any) => m.user.toString()))
            )
          ];
          query.$or = [{ assignedTo: { $in: memberIds } }, { team: { $in: targetTeamIds } }];
          query.status = { $ne: 'spam' };
        } else {
          query.assignedTo = user._id;
        }
      } else {
        query.assignedTo = user._id;
      }
    } else if (view === 'resolved') {
      query.status = { $in: ['closed', 'resolved'] };
    } else if (view === 'snoozed') {
      query.status = 'snoozed';
    } else if (view === 'spam') {
      query.status = 'spam';
    } else if (view === 'all') {
      if (!hasAllAccess) {
        if (userTeamIds.length > 0) {
          const memberIds = [
            ...new Set(
              userTeams.flatMap((t: any) => t.members.map((m: any) => m.user.toString()))
            )
          ];
          query.$or = [{ assignedTo: { $in: memberIds } }, { team: { $in: userTeamIds } }];
        } else {
          return res.status(403).json({ success: false, message: "Permission denied" });
        }
      }
    }

    if (statusParam && statusParam !== 'all') {
      query.status = statusParam;
    } else if (!['resolved', 'snoozed', 'spam', 'all'].includes(view)) {
      query.status = { $in: ['open', 'pending'] };
    }

    if (channel) query.channel = channel;
    if (sessionParam === 'open') {
      query.isOpen = true;
      query.windowExpiresAt = { $gt: new Date() };
    }

    if (search) {
      const trimmed = String(search).trim();
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escaped, $options: 'i' };

      const [matchingMessages, matchingContacts] = await Promise.all([
        Message.find({ workspace: workspaceId, text: searchRegex })
          .limit(200)
          .select('conversation')
          .distinct('conversation'),
        Contact.find({
          workspace: workspaceId,
          $or: [{ name: searchRegex }, { phone: searchRegex }],
        })
          .limit(200)
          .select('_id')
          .distinct('_id'),
      ]);

      query.$or = [
        ...(query.$or || []),
        { contact: { $in: matchingContacts } },
        { _id: { $in: matchingMessages } },
      ];
    }

    const skip = (page - 1) * limit;
    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .select('contact assignedTo team channel status priority unreadCount agentUnreadCounts lastActivityAt lastMessageAt lastMessagePreview lastMessageType lastMessageDirection isOpen windowExpiresAt createdAt updatedAt')
        .populate('contact', 'name phone email profilePicture avatar tags')
        .populate('assignedTo', 'name email')
        .populate('team', 'name')
        .sort({ lastActivityAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Conversation.countDocuments(query)
    ]);

    const userIdStr = user._id.toString();
    const enrichedConversations = conversations.map((conv: any) => {
      const unreadCounts = conv.agentUnreadCounts || {};
      return {
        ...conv,
        myUnreadCount: unreadCounts instanceof Map ? unreadCounts.get(userIdStr) || 0 : unreadCounts[userIdStr] || 0
      };
    });

    return res.status(200).json({
      success: true,
      data: enrichedConversations,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err: any) {
    console.error("[getConversationsPublic] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getTimelineMessagesPublic = async (req: any, res: express.Response) => {
  try {
    const workspaceId = req.workspace?._id;
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string || "50", 10);
    const before = req.query.before as string;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const query: any = { workspace: workspaceId, conversation: new mongoose.Types.ObjectId(id), isInternalNote: false };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    const total = await Message.countDocuments({ workspace: workspaceId, conversation: new mongoose.Types.ObjectId(id), isInternalNote: false });
    const actualHasMore = messages.length === limit;
    const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].createdAt : null;

    return res.status(200).json({
      success: true,
      data: serializeMessages(messages.reverse()),
      pagination: {
        total,
        hasMore: actualHasMore,
        lastTimestamp
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const patchConversationStatusPublic = async (req: any, res: express.Response) => {
  try {
    const workspaceId = req.workspace?._id;
    const { id } = req.params;
    const { status } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const conversation = await Conversation.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), workspace: workspaceId },
      { $set: { status, isOpen: status === 'open', lastActivityAt: new Date() } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    // EventBus event sync
    if (eventProducer && !simulatedMode) {
      const syncPayload = {
        workspaceId: workspaceId.toString(),
        conversationId: id,
        type: 'conversation_status_changed',
        timestamp: new Date().toISOString(),
        payload: { status },
      };
      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: id, value: JSON.stringify(syncPayload) }],
      });
    }

    return res.status(200).json({ success: true, data: conversation });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const sendMessageInternal = async (req: express.Request, res: express.Response) => {
  let templateCharge: Awaited<ReturnType<typeof chargeTemplateMessage>> | null = null;
  let templateDispatchSucceeded = false;
  let chargeWorkspaceId: string | null = null;

  try {
    const workspaceId = req.headers['x-workspace-id'];
    const { id } = req.params; // Conversation ID
    const { body, isInternalNote, type = 'text', template, media } = req.body;
    const mediaUrl = req.body.mediaUrl || media?.url || '';
    const mimeType = req.body.mimeType || media?.mimeType || '';
    const filename = req.body.filename || media?.filename || '';
    const caption = req.body.caption || media?.caption || body || '';

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Missing workspace context header' });
    }

    const conversation = await Conversation.findOne({
      _id: new mongoose.Types.ObjectId(id),
      workspace: new mongoose.Types.ObjectId(workspaceId as string),
    }).populate('contact');

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    let chatMessage;

    if (isInternalNote) {
      // Save internal note directly
      chatMessage = await Message.create({
        workspace: conversation.workspace,
        conversation: conversation._id,
        direction: 'outbound',
        type: 'text',
        text: body,
        body,
        mediaUrl: mediaUrl || '',
        messageId: `note_${Date.now()}`,
        status: 'read',
      });
    } else {
      // 24h session-window enforcement (monolith WabaService parity): free-form
      // messages are only deliverable while the customer-initiated window is
      // open; templates are exempt.
      if (type !== 'template') {
        const windowOpen = await isSessionWindowOpen(conversation);
        if (!windowOpen) {
          return res.status(400).json({
            success: false,
            message: 'SESSION_EXPIRED',
            code: 'SESSION_EXPIRED',
          });
        }
      }

      // Outbound integration via bsp-service
      let formattedPayload: any = {};

      if (type === 'text') {
        formattedPayload = {
          type: 'text',
          text: { body },
        };
      } else if (type === 'template' && template) {
        formattedPayload = {
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language || 'en' },
            components: template.components || [],
          },
        };
      } else if (['image', 'video', 'audio', 'document'].includes(type) && mediaUrl) {
        formattedPayload = {
          type,
          [type]: { link: mediaUrl, caption },
        };
      }

      // Fetch the WABA App details to get the appId
      const db = Conversation.db;
      const workspaceDoc = await db.collection('workspaces').findOne({ _id: conversation.workspace });
      if (!workspaceDoc) {
        return res.status(404).json({ success: false, message: 'Workspace context lost' });
      }

      const planId = workspaceDoc.plan;
      let planDoc = null;
      if (planId) {
        planDoc = await db.collection('plans').findOne({ _id: planId });
      }
      if (!planDoc) {
        planDoc = await db.collection('plans').findOne({ isDefault: true }) || await db.collection('plans').findOne({ isActive: true });
      }

      const limits = planDoc?.limits || {};
      const limit = limits.maxMessagesPerMonth || -1;
      const currentUsage = workspaceDoc.usage?.messagesThisMonth || 0;

      if (limit !== -1 && currentUsage >= limit) {
        return res.status(402).json({
          success: false,
          message: `Plan limit exceeded for messages. Current: ${currentUsage}/${limit}.`,
          code: 'PLAN_LIMIT_EXCEEDED',
          limit,
          current: currentUsage,
          resource: 'messages'
        });
      }

      const appId = workspaceDoc?.gupshupAppId;
      if (!appId || String(appId).startsWith('mock_')) {
        return res.status(503).json({ success: false, error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'WhatsApp provider is not configured' } });
      }

      const bspUrl = process.env.BSP_SERVICE_URL || process.env.SERVICE_PROVIDER_URL || 'http://localhost:3004';

      const isBillableTemplate = type === 'template' && template && !req.body.campaign;
      if (isBillableTemplate) {
        chargeWorkspaceId = conversation.workspace.toString();
        templateCharge = await chargeTemplateMessage({
          workspaceId: chargeWorkspaceId,
          templateName: template.name,
          templateCategory: template.category || template.templateCategory,
          contactId: (conversation.contact as any)?._id?.toString?.(),
          phone: conversation.contact.phone || (conversation.contact as any).phone || '',
          source: 'internal',
          idempotencyKey: req.header('x-idempotency-key') || req.header('idempotency-key') || undefined,
        });
      }

      console.log(`[Chat Service] Dispatching outbound to bsp-service: ${bspUrl}/internal/v1/bsp/messages/send`);

      const bspRes = await axios.post(
        `${bspUrl}/internal/v1/bsp/messages/send`,
        {
          workspaceId: conversation.workspace.toString(),
          appId,
          to: conversation.contact.phone || (conversation.contact as any).phone || '',
          type,
          payload: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: conversation.contact.phone || (conversation.contact as any).phone || '',
            ...formattedPayload,
          },
        },
        {
          headers: {
            'x-internal-service': 'chat-service',
            'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET || '',
          },
          timeout: 20000,
        }
      );

      const dispatchResult = bspRes.data?.data || bspRes.data;
      if (!dispatchResult?.success) {
        throw new Error('BSP Message Dispatch failed: ' + JSON.stringify(bspRes.data));
      }
      templateDispatchSucceeded = true;

      chatMessage = await Message.create({
        workspace: conversation.workspace,
        conversation: conversation._id,
        direction: 'outbound',
        type,
        text: body || '',
        body: body || templatePreviewText(req.body.template) || '',
        mediaUrl: mediaUrl || '',
        messageId: dispatchResult.providerMessageId,
        status: 'sent',
        campaign: req.body.campaign || undefined,
        template: req.body.template || undefined,
      });
    }

    // Update conversation inbox metadata (preview, counters, reply tracking)
    if (isInternalNote) {
      await Conversation.findByIdAndUpdate(conversation._id, {
        lastActivityAt: new Date(),
      });
    } else {
      await applyOutboundConversationUpdate(
        conversation,
        chatMessage,
        (req.headers['x-user-id'] as string) || undefined
      );
    }

    // Emit Socket Sync payload to EventBus (websocket-gateway topic)
    if (eventProducer && !simulatedMode) {
      const syncPayload = {
        workspaceId: conversation.workspace.toString(),
        conversationId: conversation._id.toString(),
        messageId: chatMessage._id.toString(),
        type: 'message_created',
        timestamp: new Date().toISOString(),
        payload: serializeMessage(chatMessage),
        contact: conversation.contact ? {
          _id: (conversation.contact as any)._id.toString(),
          name: (conversation.contact as any).name || 'Unknown',
          phone: (conversation.contact as any).phone || '',
        } : null
      };

      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: conversation._id.toString(), value: JSON.stringify(syncPayload) }],
      });
    }

    return res.status(200).json({ success: true, data: serializeMessage(chatMessage) });
  } catch (err: any) {
    if (chargeWorkspaceId && templateCharge && !templateDispatchSucceeded) {
      await refundTemplateCharge(chargeWorkspaceId, templateCharge, err.message);
    }
    console.error('[sendMessageInternal] Error:', err.response?.data || err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const sendMessagePublic = async (req: any, res: express.Response) => {
  let templateCharge: Awaited<ReturnType<typeof chargeTemplateMessage>> | null = null;
  let templateDispatchSucceeded = false;
  let chargeWorkspaceId: string | null = null;

  try {
    const workspaceId = req.workspace?._id;
    const { id } = req.params; // Conversation ID
    const { body, isInternalNote, type = 'text', template, media } = req.body;
    const mediaUrl = req.body.mediaUrl || media?.url || '';
    const mimeType = req.body.mimeType || media?.mimeType || '';
    const filename = req.body.filename || media?.filename || '';
    const caption = req.body.caption || media?.caption || body || '';

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const conversation = await Conversation.findOne({
      _id: new mongoose.Types.ObjectId(id),
      workspace: workspaceId,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    // Prefer a caller-provided contact when the route already resolved it via
    // contact-service; otherwise use the local read model for inbox sends.
    const db = Conversation.db;
    const contactDoc = req.contactOverride || await db.collection('contacts').findOne({ _id: conversation.contact });
    if (!contactDoc) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }
    conversation.contact = contactDoc as any;

    let chatMessage;

    if (isInternalNote) {
      // Save internal note directly
      chatMessage = await Message.create({
        workspace: workspaceId,
        conversation: conversation._id,
        direction: 'outbound',
        type: 'text',
        text: body,
        body,
        mediaUrl: mediaUrl || '',
        messageId: `note_${Date.now()}`,
        status: 'read',
      });
    } else {
      // 24h session-window enforcement (monolith WabaService parity): free-form
      // messages are only deliverable while the customer-initiated window is
      // open; templates are exempt.
      if (type !== 'template') {
        const windowOpen = await isSessionWindowOpen(conversation);
        if (!windowOpen) {
          return res.status(400).json({
            success: false,
            message: 'SESSION_EXPIRED',
            code: 'SESSION_EXPIRED',
          });
        }
      }

      // Outbound integration via bsp-service
      let formattedPayload: any = {};

      if (type === 'text') {
        formattedPayload = {
          type: 'text',
          text: { body },
        };
      } else if (type === 'template' && template) {
        formattedPayload = {
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language || 'en' },
            components: template.components || [],
          },
        };
      } else if (['image', 'video', 'audio', 'document'].includes(type) && mediaUrl) {
        formattedPayload = {
          type,
          [type]: { link: mediaUrl, caption },
        };
      }

      // Fetch the WABA App details to get the appId
      const workspaceDoc = await db.collection('workspaces').findOne({ _id: workspaceId });
      if (!workspaceDoc) {
        return res.status(404).json({ success: false, message: 'Workspace context lost' });
      }

      const planId = workspaceDoc.plan;
      let planDoc = null;
      if (planId) {
        planDoc = await db.collection('plans').findOne({ _id: planId });
      }
      if (!planDoc) {
        planDoc = await db.collection('plans').findOne({ isDefault: true }) || await db.collection('plans').findOne({ isActive: true });
      }

      const limits = planDoc?.limits || {};
      const limit = limits.maxMessagesPerMonth || -1;
      const currentUsage = workspaceDoc.usage?.messagesThisMonth || 0;

      if (limit !== -1 && currentUsage >= limit) {
        return res.status(402).json({
          success: false,
          message: `Plan limit exceeded for messages. Current: ${currentUsage}/${limit}.`,
          code: 'PLAN_LIMIT_EXCEEDED',
          limit,
          current: currentUsage,
          resource: 'messages'
        });
      }

      const appId = workspaceDoc?.gupshupAppId;
      if (!appId || String(appId).startsWith('mock_')) {
        return res.status(503).json({ success: false, error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'WhatsApp provider is not configured' } });
      }

      const bspUrl = process.env.BSP_SERVICE_URL || process.env.SERVICE_PROVIDER_URL || 'http://localhost:3004';

      const isBillableTemplate = type === 'template' && template && !req.body.campaign;
      if (isBillableTemplate) {
        const billWorkspaceId = workspaceId.toString();
        chargeWorkspaceId = billWorkspaceId;
        templateCharge = await chargeTemplateMessage({
          workspaceId: billWorkspaceId,
          templateName: template.name,
          templateCategory: template.category || template.templateCategory,
          contactId: contactDoc._id?.toString?.(),
          phone: contactDoc.phone || '',
          source: 'inbox',
          idempotencyKey: req.header?.('x-idempotency-key') || req.header?.('idempotency-key') || undefined,
        });
      }

      console.log(`[Chat Service] Dispatching outbound to bsp-service: ${bspUrl}/internal/v1/bsp/messages/send`);

      const bspRes = await axios.post(
        `${bspUrl}/internal/v1/bsp/messages/send`,
        {
          workspaceId: workspaceId.toString(),
          appId,
          to: contactDoc.phone || '',
          type,
          payload: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: contactDoc.phone || '',
            ...formattedPayload,
          },
        },
        {
          headers: {
            'x-internal-service': 'chat-service',
            'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET || '',
          },
          timeout: 20000,
        }
      );

      const dispatchResult = bspRes.data?.data || bspRes.data;
      if (!dispatchResult?.success) {
        throw new Error('BSP Message Dispatch failed: ' + JSON.stringify(bspRes.data));
      }
      templateDispatchSucceeded = true;

      chatMessage = await Message.create({
        workspace: workspaceId,
        conversation: conversation._id,
        direction: 'outbound',
        type,
        text: body || '',
        body: body || templatePreviewText(req.body.template) || '',
        mediaUrl: mediaUrl || '',
        messageId: dispatchResult.providerMessageId,
        status: 'sent',
        campaign: req.body.campaign || undefined,
        template: req.body.template || undefined,
      });
    }

    // Update conversation inbox metadata (preview, counters, reply tracking)
    if (isInternalNote) {
      await Conversation.findByIdAndUpdate(conversation._id, {
        lastActivityAt: new Date(),
      });
    } else {
      await applyOutboundConversationUpdate(
        conversation,
        chatMessage,
        (req.headers['x-user-id'] as string) || undefined
      );
    }

    // Emit Socket Sync payload to EventBus (websocket-gateway topic)
    if (eventProducer && !simulatedMode) {
      const syncPayload = {
        workspaceId: workspaceId.toString(),
        conversationId: conversation._id.toString(),
        messageId: chatMessage._id.toString(),
        type: 'message_created',
        timestamp: new Date().toISOString(),
        payload: serializeMessage(chatMessage),
        contact: contactDoc ? {
          _id: contactDoc._id.toString(),
          name: contactDoc.name || 'Unknown',
          phone: contactDoc.phone || '',
        } : null
      };

      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: conversation._id.toString(), value: JSON.stringify(syncPayload) }],
      });
    }

    await logActivity(req, 'send', 'message', {
      entityId: chatMessage._id.toString(),
      metadata: { conversationId: conversation._id.toString(), type, isInternalNote: !!isInternalNote },
    });

    return res.status(200).json({ success: true, data: serializeMessage(chatMessage) });
  } catch (err: any) {
    if (chargeWorkspaceId && templateCharge && !templateDispatchSucceeded) {
      await refundTemplateCharge(chargeWorkspaceId, templateCharge, err.message);
    }
    console.error('[sendMessagePublic] Error:', err.response?.data || err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Send a WhatsApp template directly to a contact.
 * Resolves (or creates) the contact's conversation, then reuses sendMessagePublic's
 * dispatch path. Restores the monolith's POST /contacts/:id/send-template behaviour.
 */
export const sendTemplateToContactPublic = async (req: any, res: express.Response) => {
  try {
    const workspaceId = req.workspace?._id;
    const { contactId } = req.params;
    const { templateName, languageCode, variables, templatePreview } = req.body || {};

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }
    if (!contactId || !templateName) {
      return res.status(400).json({ success: false, message: 'contactId and templateName are required' });
    }

    let contactObjectId: mongoose.Types.ObjectId;
    try {
      contactObjectId = new mongoose.Types.ObjectId(contactId);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid contact id' });
    }

    let contactDoc = await fetchContactByIdForWorkspace(contactId, workspaceId);
    if (!contactDoc) {
      const db = Conversation.db;
      contactDoc = await db.collection('contacts').findOne({ _id: contactObjectId });
    }

    if (!contactDoc || (contactDoc.workspace && String(contactDoc.workspace) !== String(workspaceId))) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    // Find or create the WhatsApp conversation (unique on workspace + contact).
    const conversation = await Conversation.findOneAndUpdate(
      { workspace: workspaceId, contact: contactObjectId },
      { $setOnInsert: { workspace: workspaceId, contact: contactObjectId, channel: 'whatsapp', status: 'open', isOpen: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Reuse the conversation send path (plan limits, bsp dispatch, message save, realtime sync).
    req.params.id = conversation._id.toString();
    req.body = {
      type: 'template',
      body: templatePreviewText(templatePreview) || templateName,
      template: {
        ...(templatePreview && typeof templatePreview === 'object' ? templatePreview : {}),
        name: templateName,
        language: languageCode || 'en',
        components: Array.isArray(variables) ? variables : [],
      },
    };
    req.contactOverride = contactDoc;
    return sendMessagePublic(req, res);
  } catch (err: any) {
    console.error('[sendTemplateToContactPublic] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getBootstrapDataPublic = async (req: any, res: express.Response) => {
  try {
    const user = req.user;
    const workspace = req.workspace;
    const workspaceId = workspace?._id;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const [permission, userTeams, allTeams, pipelines] = await Promise.all([
      Permission.findOne({ workspace: workspaceId, user: user._id }).lean(),
      Team.find({
        workspace: workspaceId,
        'members.user': user._id,
        isActive: true
      }),
      Team.find({ workspace: workspaceId, isActive: true }).populate('members.user', 'name email').lean(),
      Pipeline.find({ workspace: workspaceId }).select('name stages').lean()
    ]);

    const workspaceRole = (permission as any)?.role || req.role || user.role;
    const hasAllAccess = user.role === 'super_admin'
      || ['owner', 'admin', 'manager'].includes(workspaceRole)
      || (permission as any)?.permissions?.viewAllConversations;

    const leadTeamIds = userTeams
      .filter((t: any) => t.members.some((m: any) => m.user.toString() === user._id.toString() && m.role === 'lead'))
      .map((t: any) => t._id);

    const initialQuery: any = {
      workspace: workspaceId,
      status: { $in: ['open', 'pending'] }
    };

    if (hasAllAccess) {
      initialQuery.assignedTo = user._id;
    } else {
      initialQuery.$or = [
        { assignedTo: user._id },
        { assignedTo: null, team: { $in: leadTeamIds } }
      ];
    }

    const initialConversations = await Conversation.find(initialQuery)
      .select('contact assignedTo team channel status priority unreadCount agentUnreadCounts lastActivityAt lastMessageAt lastMessagePreview lastMessageType lastMessageDirection isOpen windowExpiresAt createdAt updatedAt')
      .populate('contact', 'name phone email profilePicture avatar tags')
      .populate('assignedTo', 'name email')
      .populate('team', 'name')
      .sort({ lastActivityAt: -1 })
      .limit(50)
      .lean();

    const agentsMap = new Map();

    // Collect from Permission collection
    const memberships = await Permission.find({ workspace: workspaceId, isActive: { $ne: false } })
      .populate('user', 'name email role status')
      .lean();

    memberships.forEach((m: any) => {
      if (m.user) {
        agentsMap.set(m.user._id.toString(), {
          ...m.user,
          role: m.role || m.user.role
        });
      }
    });

    // Collect from Teams
    allTeams.forEach((team: any) => {
      team.members?.forEach((m: any) => {
        if (m.user) {
          const userIdStr = m.user._id.toString();
          if (!agentsMap.has(userIdStr)) {
            agentsMap.set(userIdStr, {
              ...m.user,
              role: m.role || 'member'
            });
          }
        }
      });
    });

    const userIdStr = user._id.toString();
    const enrichedConversations = initialConversations.map((conv: any) => {
      const unreadCounts = conv.agentUnreadCounts || {};
      return {
        ...conv,
        myUnreadCount: unreadCounts instanceof Map ? unreadCounts.get(userIdStr) || 0 : unreadCounts[userIdStr] || 0
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        conversations: {
          data: enrichedConversations,
          pagination: { total: enrichedConversations.length, page: 1, limit: 50, pages: 1 }
        },
        agents: Array.from(agentsMap.values()),
        teams: allTeams,
        pipelines,
        metadata: {
          hasAllAccess,
          userTeamIds: userTeams.map((t: any) => t._id),
          totalInitial: enrichedConversations.length
        }
      }
    });
  } catch (err: any) {
    console.error("[getBootstrapDataPublic] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const markAsReadPublic = async (req: any, res: express.Response) => {
  try {
    const user = req.user;
    const workspace = req.workspace;
    const workspaceId = workspace?._id;
    const { id: conversationId } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const conversation = await Conversation.findOne({ _id: conversationId, workspace: workspaceId });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const userIdStr = user._id.toString();

    // Keep the legacy/global unread count in sync with the per-agent read state.
    // The inbox list falls back to `unreadCount` when no per-agent value exists
    // (for example unassigned conversations), so leaving it non-zero keeps the
    // badge visible even after the current agent reads the thread.
    (conversation as any).markReadForAgent(user._id);

    await conversation.save();

    const lastInboundWithProviderId = await Message.findOne({
      workspace: workspaceId,
      conversation: conversationId,
      direction: 'inbound',
      messageId: { $exists: true, $nin: [null, ''] },
    }).sort({ createdAt: -1 }).select('messageId');

    // Mark inbound messages as read
    const now = new Date();
    const result = await Message.updateMany(
      {
        workspace: workspaceId,
        conversation: conversationId,
        direction: 'inbound',
        status: { $ne: 'read' }
      },
      {
        $set: {
          status: 'read',
          readAt: now
        }
      }
    );

    // Emit Socket sync events to EventBus
    if (eventProducer && !simulatedMode) {
      const conversationSyncPayload = {
        workspaceId: workspaceId.toString(),
        conversationId,
        type: 'conversation_read',
        timestamp: now.toISOString(),
        payload: {
          conversationId,
          readBy: userIdStr,
          unreadCount: conversation.unreadCount || 0,
          myUnreadCount: (conversation as any).getUnreadForAgent(user._id),
          viewedAt: now.toISOString(),
        },
      };

      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: conversationId, value: JSON.stringify(conversationSyncPayload) }],
      }).catch((err: any) => console.error('[markAsReadPublic] Conversation read publish failed:', err.message));
    }

    if (result.modifiedCount > 0 && eventProducer && !simulatedMode) {
      const unreadMessages = await Message.find({
        workspace: workspaceId,
        conversation: conversationId,
        direction: 'inbound',
        status: 'read',
        readAt: now
      }).select('_id');

      for (const msg of unreadMessages) {
        const syncPayload = {
          workspaceId: workspaceId.toString(),
          conversationId: conversationId,
          messageId: msg._id.toString(),
          type: 'message_status_changed',
          timestamp: now.toISOString(),
          payload: { status: 'read', readAt: now.toISOString() },
        };

        await eventProducer.send({
          topic: 'chat-realtime-sync',
          messages: [{ key: conversationId, value: JSON.stringify(syncPayload) }],
        }).catch((err: any) => console.error('[markAsReadPublic] EventBus publish failed:', err.message));
      }
    }

    let providerReadSync: { success: boolean; messageId?: string; error?: string } | undefined;
    if (lastInboundWithProviderId?.messageId) {
      try {
        const db = Conversation.db;
        const workspaceDoc = await db.collection('workspaces').findOne({ _id: workspaceId });
        const appId = workspaceDoc?.gupshupAppId;

        if (appId) {
          const bspUrl = process.env.BSP_SERVICE_URL || process.env.SERVICE_PROVIDER_URL || 'http://localhost:3004';
          await axios.post(
            `${bspUrl}/internal/v1/bsp/messages/read`,
            {
              workspaceId: workspaceId.toString(),
              appId,
              messageId: lastInboundWithProviderId.messageId,
            },
            {
              headers: {
                'x-internal-service': 'chat-service',
                'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET || '',
              },
              timeout: 12000,
            },
          );
          providerReadSync = { success: true, messageId: lastInboundWithProviderId.messageId };
        }
      } catch (err: any) {
        providerReadSync = {
          success: false,
          messageId: lastInboundWithProviderId.messageId,
          error: err.response?.data?.message || err.message,
        };
        console.warn('[markAsReadPublic] WhatsApp read receipt sync failed:', providerReadSync.error);
      }
    }

    return res.status(200).json({
      success: true,
      markedAsReadCount: result.modifiedCount,
      unreadCount: conversation.unreadCount || 0,
      myUnreadCount: (conversation as any).getUnreadForAgent(user._id),
      providerReadSync
    });
  } catch (err: any) {
    console.error("[markAsReadPublic] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const performConversationActionPublic = async (req: any, res: express.Response) => {
  try {
    const user = req.user;
    const workspace = req.workspace;
    const workspaceId = workspace?._id;
    const { id: conversationId } = req.params;
    const { action, data = {} } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const conversation = await Conversation.findOne({ _id: conversationId, workspace: workspaceId });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    switch (action) {
      case 'assign':
      case 'claim':
        const targetAgentId = action === 'claim' ? user._id : data.agentId;
        if (!targetAgentId) {
          return res.status(400).json({ success: false, message: "Agent ID is required for assignment" });
        }

        // Limit check
        const agentPerm = await Permission.findOne({ workspace: workspaceId, user: targetAgentId });
        if (agentPerm) {
          const maxChats = (agentPerm as any).maxConcurrentChats || 10;
          const currentChats = await Conversation.countDocuments({
            workspace: workspaceId,
            assignedTo: targetAgentId,
            status: { $in: ['open', 'pending'] }
          });

          if (currentChats >= maxChats) {
            return res.status(400).json({
              success: false,
              message: `Agent has reached maximum capacity (${maxChats} chats).`
            });
          }
        }

        (conversation as any).assignTo(targetAgentId, user._id);

        // Notify the assigned agent (monolith parity) — persisted notification
        // + realtime toast via websocket-gateway.
        if (targetAgentId.toString() !== user._id.toString()) {
          await NotificationService.notify({
            workspaceId: workspaceId,
            recipientId: targetAgentId,
            type: 'assignment',
            title: 'New Conversation Assigned',
            message: 'You have been assigned to a conversation.',
            link: `/dashboard/inbox/${conversation._id}`,
          }).catch((e: any) => console.warn('[Action:Assign] Notification failed:', e.message));
        }
        break;

      case 'unassign':
        (conversation as any).unassign(user._id);
        break;

      case 'assignToTeam':
        if (!data.teamId) {
          return res.status(400).json({ success: false, message: "Team ID is required" });
        }
        conversation.team = data.teamId;
        break;

      case 'resolve':
      case 'close':
        (conversation as any).updateStatus('resolved', user._id);
        break;

      case 'open':
      case 'reopen':
        (conversation as any).updateStatus('open', user._id);
        break;

      case 'snooze':
        if (!data.until) {
          return res.status(400).json({ success: false, message: "Snooze duration required" });
        }
        (conversation as any).updateStatus('snoozed', user._id);
        conversation.snoozedUntil = new Date(data.until);
        break;

      case 'spam':
        (conversation as any).updateStatus('spam', user._id);
        break;

      case 'label':
        conversation.label = data.label;
        break;

      case 'priority':
        conversation.priority = data.priority;
        break;

      default:
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
    }

    conversation.lastActivityAt = new Date();
    await conversation.save();

    await logActivity(req, 'update', 'conversation', {
      entityId: conversation._id.toString(),
      metadata: { action, data },
    });

    // Emit Socket sync event via EventBus
    if (eventProducer && !simulatedMode) {
      const syncPayload = {
        workspaceId: workspaceId.toString(),
        conversationId: conversationId,
        type: 'conversation_updated',
        timestamp: new Date().toISOString(),
        payload: conversation.toObject ? conversation.toObject() : conversation,
      };

      await eventProducer.send({
        topic: 'chat-realtime-sync',
        messages: [{ key: conversationId, value: JSON.stringify(syncPayload) }],
      }).catch((err: any) => console.error('[performConversationActionPublic] EventBus publish failed:', err.message));
    }

    return res.status(200).json({ success: true, data: conversation });
  } catch (err: any) {
    console.error("[performConversationActionPublic] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getMessagesByContactPublic = async (req: any, res: express.Response) => {
  try {
    const workspaceId = req.workspace?._id;
    const { contactId } = req.params;
    const limit = parseInt(req.query.limit as string || "50", 10);
    const before = req.query.before as string;

    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'Workspace context missing' });
    }

    const query: any = { workspace: workspaceId, contact: contactId, isInternalNote: false };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    const actualHasMore = messages.length === limit;
    const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].createdAt : null;

    return res.status(200).json({
      success: true,
      data: serializeMessages(messages.reverse()),
      pagination: {
        hasMore: actualHasMore,
        lastTimestamp
      }
    });
  } catch (err: any) {
    console.error("[getMessagesByContactPublic] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
