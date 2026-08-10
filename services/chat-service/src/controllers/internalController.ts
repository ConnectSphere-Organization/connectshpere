import { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { Contact, Conversation, Message, Deal, Pipeline } from '../models/index.js';
import { CheckoutCart } from '../models/CheckoutCart.js';
import { Product } from '../models/Product.js';
import { CheckoutBotService } from '../services/checkout-bot-service.js';
import { eventProducer, simulatedMode } from '../services/eventBus.js';
import { chargeTemplateMessage, refundTemplateCharge } from '../services/billing-client.js';
import { dispatchBspMessage, resolveAutomationText } from '../services/bsp-dispatch.js';

/**
 * Shared dispatcher for bot-originated outbound messages (text / interactive / flow).
 * Mirrors the monolith's wabaSend path: resolve the contact + conversation, forward the
 * raw WhatsApp Cloud payload to bsp-service, persist the outbound Message, and emit a
 * realtime sync event. bsp-service's /messages/send is a passthrough, so any valid
 * WhatsApp payload type is supported here.
 */
async function dispatchBotOutbound(opts: {
  workspaceId: string;
  phone: string;
  messageType: string;
  waPayload: any;
  previewText?: string;
}) {
  const { workspaceId, phone, messageType, waPayload } = opts;

  let contact: any;
  try {
    const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
    const resolveRes = await fetch(`${contactServiceUrl}/internal/v1/contacts/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
        'x-workspace-id': workspaceId,
      },
      body: JSON.stringify({ workspaceId, phone, name: phone }),
    });
    if (resolveRes.ok) {
      const resolveData = (await resolveRes.json()) as any;
      contact = resolveData.data;
    }
  } catch (err: any) {
    console.error('[InternalAction] Failed to resolve contact via Contact Service:', err.message);
  }

  if (!contact) {
    contact = await Contact.findOne({ workspace: new Types.ObjectId(workspaceId), phone });
    if (!contact) {
      throw new Error('Failed to resolve contact via Contact Service');
    }
  }

  let conversation = await Conversation.findOne({ workspace: new Types.ObjectId(workspaceId), contact: contact._id });
  if (!conversation) {
    conversation = await Conversation.create({
      workspace: new Types.ObjectId(workspaceId),
      contact: contact._id,
      status: 'open',
      isOpen: true,
      lastActivityAt: new Date(),
    });
  }

  const db = mongoose.connection.db;
  const workspaceDoc = await db?.collection('workspaces').findOne({ _id: new Types.ObjectId(workspaceId) });
  const appId = workspaceDoc?.gupshupAppId;
  if (!appId || String(appId).startsWith('mock_')) {
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }

  const bspUrl = process.env.BSP_SERVICE_URL || 'http://localhost:3004';
  const { providerMessageId, dispatchResult } = await dispatchBspMessage({
    bspUrl,
    internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || '',
    workspaceId,
    conversationId: conversation._id.toString(),
    contactId: contact._id.toString(),
    appId: String(appId),
    to: phone,
    type: messageType,
    payload: waPayload,
  });

  const chatMessage = await Message.create({
    workspace: new Types.ObjectId(workspaceId),
    conversation: conversation._id,
    contact: contact._id,
    direction: 'outbound',
    type: 'interactive',
    text: opts.previewText || '',
    messageId: providerMessageId,
    whatsappMessageId: providerMessageId,
    status: 'sent',
  });

  await Conversation.findByIdAndUpdate(conversation._id, { lastActivityAt: new Date() });

  if (eventProducer && !simulatedMode) {
    const syncPayload = {
      workspaceId,
      conversationId: conversation._id.toString(),
      messageId: chatMessage._id.toString(),
      type: 'message_created',
      timestamp: new Date().toISOString(),
      payload: chatMessage,
    };
    await eventProducer.send({
      topic: 'chat-realtime-sync',
      messages: [{ key: conversation._id.toString(), value: JSON.stringify(syncPayload) }],
    });
  }

  return { chatMessage, dispatchResult };
}

export const internalController = {
  /**
   * WORKER BRIDGE (Called by Campaign Service)
   */
  async workerBridge(req: Request, res: Response) {
    try {
      const { action, data } = req.body;

      if (!data || !data.workspaceId) {
        return res.status(400).json({ error: 'workspaceId is required for worker-bridge calls' });
      }
      const workspaceId = String(data.workspaceId);

      switch (action) {
        case 'send-template': {
          const { to, templateName, languageCode, components, options = {} } = data;
          let templateCharge: Awaited<ReturnType<typeof chargeTemplateMessage>> | null = null;

          let contact;
          try {
            const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
            const resolveRes = await fetch(`${contactServiceUrl}/internal/v1/contacts/resolve`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
                'x-workspace-id': workspaceId,
              },
              body: JSON.stringify({
                workspaceId,
                phone: to,
                name: to,
              }),
            });
            if (resolveRes.ok) {
              const resolveData = await resolveRes.json() as any;
              contact = resolveData.data;
            }
          } catch (err: any) {
            console.error('[WorkerBridge] Failed to resolve contact via Contact Service:', err.message);
          }

          if (!contact) {
            contact = await Contact.findOne({ workspace: new Types.ObjectId(workspaceId), phone: to });
            if (!contact) {
              throw new Error('Failed to resolve contact via Contact Service');
            }
          }

          let conversation = await Conversation.findOne({ workspace: new Types.ObjectId(workspaceId), contact: contact._id });
          if (!conversation) {
            conversation = await Conversation.create({
              workspace: new Types.ObjectId(workspaceId),
              contact: contact._id,
              status: 'open',
              isOpen: true,
              lastActivityAt: new Date(),
            });
          }

          const formattedPayload = {
            type: 'template',
            template: {
              name: templateName,
              language: { code: languageCode || 'en' },
              components: components || [],
            },
          };

          const db = mongoose.connection.db;
          const workspaceDoc = await db?.collection('workspaces').findOne({ _id: new Types.ObjectId(workspaceId) });
          const appId = workspaceDoc?.gupshupAppId;
          if (!appId || String(appId).startsWith('mock_')) {
            throw new Error('PROVIDER_NOT_CONFIGURED');
          }

          if (!options.campaignId) {
            templateCharge = await chargeTemplateMessage({
              workspaceId,
              templateName,
              templateCategory: data.templateCategory || data.category,
              contactId: contact._id?.toString?.(),
              phone: to,
              source: 'automation',
              idempotencyKey: data.idempotencyKey,
            });
          }

          const bspUrl = process.env.BSP_SERVICE_URL || 'http://localhost:3004';
          let dispatchResult: any;
          let providerMessageId: string;
          try {
            const dispatch = await dispatchBspMessage({
              bspUrl,
              internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || '',
              workspaceId,
              conversationId: conversation._id.toString(),
              contactId: contact._id.toString(),
              campaignId: options.campaignId,
              appId: String(appId),
              to,
              type: 'template',
              payload: {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                ...formattedPayload,
              },
            });
            dispatchResult = dispatch.dispatchResult;
            providerMessageId = dispatch.providerMessageId;
          } catch (err: any) {
            await refundTemplateCharge(workspaceId, templateCharge, err.message);
            throw err;
          }

          const chatMessage = await Message.create({
            workspace: new Types.ObjectId(workspaceId),
            conversation: conversation._id,
            contact: contact._id,
            direction: 'outbound',
            type: 'template',
            text: templateName,
            messageId: providerMessageId,
            whatsappMessageId: providerMessageId,
            status: 'sent',
            campaign: options.campaignId ? {
              id: new Types.ObjectId(options.campaignId),
              name: options.metadata?.campaignName || 'Campaign',
              batchId: options.metadata?.batchId
            } : undefined,
            template: {
              name: templateName,
              language: languageCode || 'en'
            }
          });

          await Conversation.findByIdAndUpdate(conversation._id, { lastActivityAt: new Date() });

          if (eventProducer && !simulatedMode) {
            const syncPayload = {
              workspaceId,
              conversationId: conversation._id.toString(),
              messageId: chatMessage._id.toString(),
              type: 'message_created',
              timestamp: new Date().toISOString(),
              payload: chatMessage,
            };
            await eventProducer.send({
              topic: 'chat-realtime-sync',
              messages: [{ key: conversation._id.toString(), value: JSON.stringify(syncPayload) }],
            });
          }

          return res.json({ success: true, message: chatMessage, result: dispatchResult });
        }

        case 'preflight-validate': {
          const { templateId, contactsCount } = data;
          const db = mongoose.connection.db;
          const workspace = await db?.collection('workspaces').findOne({ _id: new Types.ObjectId(workspaceId) });
          if (!workspace) return res.json({ valid: false, reason: 'WORKSPACE_NOT_FOUND' });

          const bspDb = (mongoose.connection as any).getClient().db('wapi_bsp');
          const template = await bspDb.collection('bsp_template_mirrors').findOne({ _id: new Types.ObjectId(templateId) });
          if (!template) return res.json({ valid: false, reason: 'TEMPLATE_MISSING' });

          const isConnected = workspace.esbFlow?.status === 'completed' && !!workspace.phoneNumberId;
          if (!isConnected) {
            return res.json({ valid: false, reason: 'WHATSAPP_DISCONNECTED', details: 'WABA connection is required to send campaigns.' });
          }

          if (template.status !== 'APPROVED') {
            return res.json({ valid: false, reason: 'TEMPLATE_NOT_APPROVED', details: `Template status is ${template.status}. Only APPROVED templates can be used.` });
          }

          const billingServiceUrl = process.env.BILLING_SERVICE_URL || 'http://localhost:3003';
          const billingHeaders = {
            'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
            'x-workspace-id': workspaceId,
          };

          const detailsRes = await fetch(`${billingServiceUrl}/api/billing/wallets/${workspaceId}/details`, { headers: billingHeaders });
          const walletRes = await fetch(`${billingServiceUrl}/api/billing/wallets/${workspaceId}`, { headers: billingHeaders });

          if (!detailsRes.ok || !walletRes.ok) {
            return res.json({ valid: false, reason: 'BILLING_SERVICE_ERROR' });
          }

          const detailsData = await detailsRes.json() as any;
          const walletData = await walletRes.json() as any;

          const billingData = detailsData.workspace || {};
          const wallet = walletData.wallet || {};

          if (billingData.billingStatus === 'suspended' || billingData.billingStatus === 'canceled') {
            return res.json({ valid: false, reason: 'BILLING_ACCOUNT_INACTIVE', details: `Account status is ${billingData.billingStatus}` });
          }

          const pricingRes = await fetch(`${billingServiceUrl}/api/billing/wallets/${workspaceId}/pricing?category=${template.category || 'MARKETING'}`, { headers: billingHeaders });
          if (!pricingRes.ok) return res.json({ valid: false, reason: 'PRICING_QUERY_ERROR' });
          const pricingData = await pricingRes.json() as any;

          const costPerMsg = pricingData.cost || 0;
          const estimatedCost = contactsCount * costPerMsg;
          const availableBalance = wallet.availableBalance || 0;

          if (availableBalance < estimatedCost) {
            return res.json({
              valid: false,
              reason: 'INSUFFICIENT_FUNDS',
              details: {
                required: estimatedCost / 100,
                available: availableBalance / 100
              }
            });
          }

          return res.json({ valid: true });
        }

        case 'socket-broadcast': {
          if (eventProducer && !simulatedMode) {
            const syncPayload = {
              workspaceId,
              type: data.event,
              payload: data.payload,
              timestamp: new Date().toISOString(),
            };
            await eventProducer.send({
              topic: 'chat-realtime-sync',
              messages: [{ key: workspaceId, value: JSON.stringify(syncPayload) }],
            });
          }
          return res.json({ success: true });
        }

        default:
          return res.status(400).json({ error: 'Invalid worker-bridge action' });
      }
    } catch (error: any) {
      console.error('[WorkerBridge] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * ACTIONS ENDPOINT (Called by Automation Service)
   */
  async executeAction(req: Request, res: Response) {
    try {
      const { type, payload } = req.body || {};
      if (!payload || !payload.workspaceId) {
        return res.status(400).json({ success: false, error: 'payload.workspaceId is required' });
      }
      const { workspaceId, contactId } = payload;
      const config = payload.config || {};
      const action = String(type || '').toLowerCase();

      console.log(`[InternalAction] Executing ${action} for workspace ${workspaceId}`);

      switch (action) {
        case 'send_text':
        case 'send_message': {
          const text = resolveAutomationText(payload, config);
          if (!text) {
            return res.status(400).json({
              success: false,
              error: 'A non-empty text body is required for send_message',
            });
          }

          let contact;
          try {
            const contactServiceUrl = process.env.CONTACT_SERVICE_URL || 'http://localhost:3007';
            const resolveRes = await fetch(`${contactServiceUrl}/internal/v1/contacts/resolve`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
                'x-workspace-id': workspaceId,
              },
              body: JSON.stringify({
                workspaceId,
                phone: payload.phone,
                name: payload.phone,
              }),
            });
            if (resolveRes.ok) {
              const resolveData = await resolveRes.json() as any;
              contact = resolveData.data;
            }
          } catch (err: any) {
            console.error('[InternalAction] Failed to resolve contact via Contact Service:', err.message);
          }

          if (!contact) {
            contact = await Contact.findOne({ workspace: new Types.ObjectId(workspaceId), phone: payload.phone });
            if (!contact) {
              throw new Error('Failed to resolve contact via Contact Service');
            }
          }

          let conversation = await Conversation.findOne({ workspace: new Types.ObjectId(workspaceId), contact: contact._id });
          if (!conversation) {
            conversation = await Conversation.create({
              workspace: new Types.ObjectId(workspaceId),
              contact: contact._id,
              status: 'open',
              isOpen: true,
              lastActivityAt: new Date(),
            });
          }

          const db = mongoose.connection.db;
          const workspaceDoc = await db?.collection('workspaces').findOne({ _id: new Types.ObjectId(workspaceId) });
          const appId = workspaceDoc?.gupshupAppId;
          if (!appId || String(appId).startsWith('mock_')) {
            throw new Error('PROVIDER_NOT_CONFIGURED');
          }

          const bspUrl = process.env.BSP_SERVICE_URL || 'http://localhost:3004';
          const { providerMessageId, dispatchResult } = await dispatchBspMessage({
            bspUrl,
            internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || '',
            workspaceId: String(workspaceId),
            conversationId: conversation._id.toString(),
            contactId: contact._id.toString(),
            appId: String(appId),
            to: payload.phone,
            type: 'text',
            payload: {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: payload.phone,
              type: 'text',
              text: { body: text },
            },
          });

          const chatMessage = await Message.create({
            workspace: new Types.ObjectId(workspaceId),
            conversation: conversation._id,
            contact: contact._id,
            direction: 'outbound',
            type: 'text',
            text: text,
            messageId: providerMessageId,
            whatsappMessageId: providerMessageId,
            status: 'sent',
          });

          await Conversation.findByIdAndUpdate(conversation._id, { lastActivityAt: new Date() });

          if (eventProducer && !simulatedMode) {
            const syncPayload = {
              workspaceId,
              conversationId: conversation._id.toString(),
              messageId: chatMessage._id.toString(),
              type: 'message_created',
              timestamp: new Date().toISOString(),
              payload: chatMessage,
            };
            await eventProducer.send({
              topic: 'chat-realtime-sync',
              messages: [{ key: conversation._id.toString(), value: JSON.stringify(syncPayload) }],
            });
          }
          return res.json({ success: true, message: chatMessage, result: dispatchResult });
        }

        case 'send_template': {
          const payloadTemplate = {
            workspaceId,
            to: payload.phone,
            templateName: payload.templateName ?? config.templateName,
            languageCode: payload.languageCode ?? config.languageCode ?? 'en_US',
            components: payload.components ?? config.components ?? [],
            templateCategory: payload.templateCategory ?? payload.category ?? config.templateCategory ?? config.category,
            options: { contactId, conversationId: payload.conversationId }
          };

          // Recursively reuse template bridge sender
          const fakeReq = { body: { action: 'send-template', data: payloadTemplate } } as any;
          const results = [] as any[];
          const fakeRes = {
            status: () => ({ json: () => { } }),
            json: (resData: any) => { results.push(resData); }
          } as any;
          await internalController.workerBridge(fakeReq, fakeRes);
          break;
        }

        case 'send_interactive': {
          const interactive = payload.interactive ?? config.interactive;
          if (!interactive) {
            return res.status(400).json({ success: false, error: 'interactive payload is required' });
          }
          const { chatMessage, dispatchResult } = await dispatchBotOutbound({
            workspaceId,
            phone: payload.phone,
            messageType: 'interactive',
            waPayload: {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: payload.phone,
              type: 'interactive',
              interactive,
            },
            previewText: interactive?.body?.text || '',
          });
          return res.json({ success: true, message: chatMessage, result: dispatchResult });
        }

        case 'send_flow': {
          const flow = payload.flow ?? config.flow;
          if (!flow) {
            return res.status(400).json({ success: false, error: 'flow payload is required' });
          }
          // WhatsApp delivers Flows as an interactive message of type "flow".
          const interactive = flow.type === 'flow' ? flow : { type: 'flow', ...flow };
          const { chatMessage, dispatchResult } = await dispatchBotOutbound({
            workspaceId,
            phone: payload.phone,
            messageType: 'interactive',
            waPayload: {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: payload.phone,
              type: 'interactive',
              interactive,
            },
            previewText: interactive?.body?.text || 'Flow',
          });
          return res.json({ success: true, message: chatMessage, result: dispatchResult });
        }

        case 'create_deal': {
          const dealData = payload.data || {
            contactId,
            title: config.title || 'New Deal from Automation',
            value: config.value || 0,
            stageId: config.stageId,
          };

          const pipeline = await Pipeline.findOne({ workspace: new Types.ObjectId(workspaceId), isDefault: true }) ||
            await Pipeline.findOne({ workspace: new Types.ObjectId(workspaceId) });
          if (pipeline) {
            const stage = dealData.stageId || pipeline.stages[0]?.id;
            await Deal.create({
              workspace: new Types.ObjectId(workspaceId),
              contact: new Types.ObjectId(dealData.contactId),
              pipeline: pipeline._id,
              title: dealData.title,
              value: dealData.value || 0,
              stage,
              status: 'active',
              priority: 'medium',
              source: 'automation'
            });
          }
          break;
        }

        case 'move_deal_stage': {
          await Deal.updateOne(
            { _id: new Types.ObjectId(payload.dealId), workspace: new Types.ObjectId(workspaceId) },
            { $set: { stage: payload.stageId } }
          );
          break;
        }

        case 'add_tag':
        case 'add_contact_tag': {
          const tagId = payload.tag ?? payload.tagId ?? config.tagId;
          await Contact.updateOne(
            { _id: new Types.ObjectId(contactId || payload.contactId), workspace: new Types.ObjectId(workspaceId) },
            { $addToSet: { tags: tagId } }
          );
          break;
        }

        case 'update_contact': {
          await Contact.updateOne(
            { _id: new Types.ObjectId(payload.contactId), workspace: new Types.ObjectId(workspaceId) },
            { $set: payload.data || {} }
          );
          break;
        }

        case 'bot_escalation': {
          if (payload.conversationId) {
            await Conversation.updateOne(
              { _id: new Types.ObjectId(payload.conversationId), workspace: new Types.ObjectId(workspaceId) },
              {
                'botMetadata.isBotPaused': true,
                'botMetadata.lastBotInteractionAt': new Date(),
              }
            );
          }
          break;
        }

        case 'update_metadata': {
          if (payload.conversationId) {
            await Conversation.updateOne(
              { _id: new Types.ObjectId(payload.conversationId), workspace: new Types.ObjectId(workspaceId) },
              { $set: { botMetadata: payload.metadata } }
            );
          }
          break;
        }

        case 'checkout_bot_process': {
          await CheckoutBotService.processMessage(
            workspaceId,
            payload.contactId,
            payload.conversationId,
            payload.body
          );
          break;
        }

        case 'record_form_submission': {
          if (!payload.flowToken) {
            return res.status(400).json({ success: false, error: 'flowToken is required' });
          }
          const db = mongoose.connection.db;
          await db?.collection('formsubmissions').findOneAndUpdate(
            { workspace: new Types.ObjectId(workspaceId), flowToken: payload.flowToken },
            {
              $set: {
                workspace: new Types.ObjectId(workspaceId),
                contact: payload.contactId ? new Types.ObjectId(payload.contactId) : undefined,
                conversation: payload.conversationId ? new Types.ObjectId(payload.conversationId) : undefined,
                flowToken: payload.flowToken,
                flowId: payload.flowId,
                data: payload.data || {},
                metadata: payload.metadata,
                options: payload.options,
                receivedAt: new Date(),
              },
            },
            { upsert: true }
          );
          break;
        }

        default:
          console.warn(`[InternalAction] Unknown action type: ${type}`);
          return res.status(400).json({ success: false, error: 'Unknown action type', type });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error('[InternalAction] Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * CONVERSATION METADATA (Called by Automation Service)
   */
  async updateConversationMetadata(req: Request, res: Response) {
    try {
      const { conversationId, metadata } = req.body;
      await Conversation.findByIdAndUpdate(conversationId, {
        $set: { botMetadata: metadata }
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * CHECKOUT BOT PROCESS (Called by Automation Service)
   */
  async processCheckout(req: Request, res: Response) {
    try {
      const { workspaceId, contactId, conversationId, messageBody } = req.body;
      const result = await CheckoutBotService.processMessage(
        workspaceId,
        contactId,
        conversationId,
        messageBody
      );
      res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("[InternalCheckout] Error:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * REPLAY DLQ TOPIC
   */
  async replayDlq(req: Request, res: Response) {
    try {
      const { topic, limit } = req.body;
      if (!topic) {
        return res.status(400).json({ success: false, error: 'topic is required' });
      }

      const { replayDlq: replayHelper } = await import('../services/eventBus.js');
      const result = await replayHelper(topic, limit ? parseInt(String(limit), 10) : 50);
      res.json(result);
    } catch (error: any) {
      console.error("[InternalDLQ] Error replaying DLQ:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
};
