import { Worker, Job } from 'bullmq';
import { Campaign, CampaignBatch, CampaignMessage, ICampaignModel, ICampaignBatchModel, Workspace } from "../models";
import { JOB_TYPES, CampaignQueueService, campaignQueue } from "../lib/campaign-queue";
import { CampaignService } from "../services/CampaignService";
import { SegmentService } from "../services/SegmentService";
import { getSharedRedis } from "../lib/redis";
import { microserviceWorkerClient } from "../lib/microservice-worker-client";
import { Types } from "mongoose";
import { DistributedRateLimiter } from '../lib/distributed-rate-limiter';
import type { MetricsRegistry } from '@wapi/contracts';

/**
 * CAMPAIGN WORKER (Microservice)
 * 
 * Consumes and processes campaign jobs.
 * This worker uses explicit service clients for chat, contact, billing, BSP,
 * and realtime fan-out.
 */
export class CampaignWorker {
  private worker: Worker;
  private limiter = new DistributedRateLimiter(getSharedRedis() as any);

  constructor(private readonly metrics?: MetricsRegistry) {
    this.worker = new Worker('campaign-engine', this.processJob.bind(this), {
      connection: getSharedRedis() as any,
      concurrency: 5,
    });

    this.worker.on('completed', (job) => {
      this.metrics?.increment('queue_jobs_completed_total', 'Completed BullMQ jobs', { queue_name: 'campaign-engine', job_name: job.name });
      console.log(`[CampaignWorker] ✅ Job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      this.metrics?.increment('queue_jobs_failed_total', 'Failed BullMQ jobs', { queue_name: 'campaign-engine', job_name: job?.name || 'unknown' });
      console.error(`[CampaignWorker] ❌ Job ${job?.id} failed:`, err.message);
      const exhausted = !!job && job.attemptsMade >= Number(job.opts.attempts || 1);
      if (exhausted) {
        void CampaignQueueService.deadLetter(job, err).then(async () => {
          if (job.data?.campaignId) {
            await (Campaign as any).findOneAndUpdate(
              { _id: job.data.campaignId, status: { $nin: ['COMPLETED', 'CANCELLED'] } },
              { $set: { status: 'FAILED', pausedReason: err.message, updatedAt: new Date() } },
            );
          }
        }).catch((dlqError) => console.error('[CampaignWorker] DLQ persistence failed:', dlqError.message));
      }
    });

    void campaignQueue.add(JOB_TYPES.CAMPAIGN_CHECK, {}, {
      repeat: { pattern: '*/1 * * * *' },
      jobId: 'campaign-maintenance-cron'
    }).catch((err: any) => console.error('[CampaignWorker] Failed to schedule maintenance cron:', err.message));
  }

  async close() {
    await this.worker.close(false);
  }

  private async processJob(job: Job) {
    try {
      console.log(`[CampaignWorker] Starting job ${job.id} (${job.name})`);
      switch (job.name) {
        case JOB_TYPES.CAMPAIGN_START:
          return await this.handleCampaignStart(job);
        case JOB_TYPES.BATCH_PROCESS:
          return await this.handleBatchProcess(job);
        case JOB_TYPES.CAMPAIGN_CHECK:
          return await this.handleMaintenance(job);
        default:
          console.warn(`[CampaignWorker] Unknown job type: ${job.name}`);
      }
    } catch (err: any) {
      console.error(`[CampaignWorker] CRITICAL ERROR in job ${job.id}:`, err.message);
      if (job.name === JOB_TYPES.CAMPAIGN_START && job.data?.campaignId) {
        try {
          const campaign = await Campaign.findById(job.data.campaignId);
          if (campaign && ['DRAFT', 'SCHEDULED', 'QUEUED'].includes(campaign.status)) {
            campaign.status = 'PAUSED';
            campaign.pausedReason = null;
            campaign.pausedAt = new Date();
            await (Campaign as ICampaignModel).addAuditEntry(job.data.campaignId, 'SYSTEM_PAUSED', {
              reason: `Launch failed: ${err.message}`,
              systemInitiated: true,
            });
            await campaign.save();

            await microserviceWorkerClient.socketBroadcast(job.data.workspaceId, 'campaign:status_update', {
              campaignId: job.data.campaignId,
              status: 'PAUSED',
              reason: err.message,
              updatedAt: campaign.updatedAt,
            });
          }
        } catch (statusErr: any) {
          console.error(`[CampaignWorker] Failed to mark campaign as paused after launch error:`, statusErr.message);
        }
      }
      throw err;
    }
  }

  private async handleCampaignStart(job: Job) {
    const { campaignId, workspaceId } = job.data;
    this.metrics?.increment('campaigns_started_total', 'Campaigns entering execution');
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    // 1. Pre-flight Validation
    const preflight = await microserviceWorkerClient.preflightValidate(workspaceId, campaign.template.toString(), campaign.contacts?.length || 0);
    if (!preflight.valid) {
      campaign.status = 'PAUSED';
      await (Campaign as ICampaignModel).addAuditEntry(campaignId, 'SYSTEM_PAUSED', {
        reason: `Preflight failed: ${preflight.reason}`,
        systemInitiated: true
      });
      await campaign.save();

      await microserviceWorkerClient.socketBroadcast(workspaceId, 'campaign:status_update', {
        campaignId,
        status: 'PAUSED',
        reason: preflight.reason,
        updatedAt: campaign.updatedAt,
      });
      throw new Error(`PREFLIGHT_FAILED: ${preflight.reason}`);
    }

    console.log(`[CampaignWorker] 📦 Initializing campaign ${campaignId}...`);

    // 1. Resolve Contacts
    let contacts = campaign.contacts;
    if (campaign.recipientFilter?.type === 'segment' && campaign.recipientFilter.segmentId) {
      contacts = await SegmentService.resolveSegmentContacts(workspaceId, campaign.recipientFilter.segmentId);
    }

    // 2. Budget Parking & Instant Batch Execution
    const { template } = await microserviceWorkerClient.getTemplate(workspaceId, campaign.template.toString());

    // Fetch pricing from Billing Service
    let cost = 100;
    try {
      const { serviceRequest } = await import('../lib/service-client');
      const pricingResponse = await serviceRequest('billing', {
        method: 'GET',
        url: `/api/billing/wallets/${workspaceId}/pricing`,
        params: { category: template?.category || 'MARKETING' }
      });
      if (pricingResponse.status === 200 && pricingResponse.data?.cost) {
        cost = pricingResponse.data.cost;
      }
    } catch (pricingErr: any) {
      console.warn(`[CampaignWorker] Failed to fetch pricing, defaulting to 100 paise: ${pricingErr.message}`);
    }

    const totalReservation = contacts.length * cost;

    // 2.5 Snapshot
    if (!campaign.templateSnapshot || !campaign.templateSnapshot.name) {
      campaign.templateSnapshot = {
        name: template?.name,
        category: template?.category,
        language: template?.language,
        headerType: template?.components?.find((c: any) => String(c?.type || '').toUpperCase() === 'HEADER')?.format || 'TEXT',
        bodyText: template?.bodyText || template?.body?.text || template?.providerData?.bodyText || template?.components?.find((c: any) => String(c?.type || '').toUpperCase() === 'BODY')?.text,
      };
      await campaign.save();
    }

    // Direct budget park
    try {
      await microserviceWorkerClient.billingPark(workspaceId, totalReservation, campaignId);
    } catch (parkErr: any) {
      console.warn(`[CampaignWorker] Direct billing park notice for campaign ${campaignId}: ${parkErr.message}`);
    }

    // Saga event (for billing ledger event bus)
    try {
      const { billingEventsQueue } = await import('../lib/events/EventBus');
      await billingEventsQueue.add('CampaignCreatedEvent', {
        campaignId,
        workspaceId,
        estimatedCost: totalReservation,
        contacts,
        templateId: campaign.template.toString(),
        templateSnapshot: campaign.templateSnapshot,
        variableMapping: campaign.variableMapping
      });
    } catch (evtErr: any) {
      console.warn(`[CampaignWorker] Saga event emit notice: ${evtErr.message}`);
    }

    // 3. Instant Batch Creation & Enqueue
    const normalizedContacts = (contacts || []).map((contact: any) => (
      contact && typeof contact === 'object' && contact._id ? contact : { _id: contact }
    ));

    if (normalizedContacts.length === 0) {
      throw new Error('NO_RECIPIENTS_FOR_BATCHING');
    }

    let batches = await CampaignBatch.find({ campaign: campaignId }).sort({ batchIndex: 1 });
    if (batches.length === 0) {
      batches = await (CampaignBatch as ICampaignBatchModel).createBatches(
        campaignId,
        workspaceId,
        normalizedContacts,
        campaign.template.toString(),
        campaign.templateSnapshot?.name || template?.name || 'template',
        campaign.variableMapping,
        50
      );
    }

    campaign.contacts = normalizedContacts.map((c: any) => c._id);
    campaign.totalContacts = normalizedContacts.length;
    campaign.totals = {
      ...(campaign.totals || {}),
      totalRecipients: normalizedContacts.length,
      queued: normalizedContacts.length,
    } as any;
    campaign.batching = {
      ...(campaign.batching || {}),
      totalBatches: batches.length,
      batchSize: 50,
      currentBatchIndex: 0,
    } as any;

    const workspace = await Workspace.findById(workspaceId).select('inboxSettings').lean() as any;
    const mps = workspace?.inboxSettings?.agentMessagesPerMinute ? workspace.inboxSettings.agentMessagesPerMinute / 60 : 10;
    const delayPerBatch = Math.ceil((50 / mps) * 1000);

    for (let i = 0; i < batches.length; i++) {
      await CampaignQueueService.enqueueBatch(
        batches[i]._id,
        campaignId,
        workspaceId,
        i,
        i * delayPerBatch
      );
    }

    campaign.status = 'RUNNING';
    campaign.startedAt = campaign.startedAt || new Date();
    await campaign.save();

    await microserviceWorkerClient.socketBroadcast(workspaceId, "campaign:status_update", {
      campaignId,
      status: 'RUNNING',
      totalBatches: batches.length,
      updatedAt: campaign.updatedAt,
      startedAt: campaign.startedAt
    });

    console.log(`[CampaignWorker] 🚀 Campaign ${campaignId} launched instantly with ${batches.length} batch(es).`);
    return { status: 'RUNNING', totalBatches: batches.length };
  }

  private async handleBatchProcess(job: Job) {
    const { batchId, campaignId, workspaceId } = job.data;
    const batch = await (CampaignBatch as any).findById(batchId);
    const campaign = await Campaign.findById(campaignId);
    if (!batch || !campaign) throw new Error('Batch or Campaign not found');

    await (batch as any).markStarted();
    console.log(`[CampaignWorker] 📤 Processing batch ${batchId} index ${batch.batchIndex}...`);

    let successCount = 0;
    let failCount = 0;

    const workspace = await Workspace.findById(workspaceId).select('inboxSettings').lean() as any;
    const perSecondLimit = Math.max(1, Math.floor((workspace?.inboxSettings?.agentMessagesPerMinute || 600) / 60));
    const providerAppId = String((workspace as any)?.gupshupAppId || workspaceId);

    const CONCURRENCY = 10;
    const activeRecipients = batch.recipients.filter((r: any) => !!r.contactId && (r.status === 'pending' || r.status === 'queued'));

    for (let i = 0; i < activeRecipients.length; i += CONCURRENCY) {
      const chunk = activeRecipients.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (recipient: any) => {
        let contactIdStr = '';
        try {
          const rawContactId = recipient.contactId?._id || recipient.contactId;
          contactIdStr = typeof rawContactId === 'object' && rawContactId ? rawContactId.toString() : String(rawContactId || '');

          const internalMessageId = `campaign:${campaignId}:contact:${contactIdStr}`;
          const existingMessage = await CampaignMessage.findOne({ internalMessageId });
          if (existingMessage?.whatsappMessageId || ['accepted', 'sent', 'delivered', 'read'].includes(existingMessage?.status || '')) {
            successCount++;
            return;
          }
          if (existingMessage?.status === 'reconciliation_required') {
            failCount++;
            return;
          }

          let contact: any = null;
          try {
            const contactResponse = await microserviceWorkerClient.getContact(workspaceId, contactIdStr);
            contact = contactResponse?.contact || contactResponse?.data || contactResponse;
          } catch (cErr: any) {
            console.warn(`[CampaignWorker] Contact lookup warning for ${contactIdStr}:`, cErr.message);
          }

          if (!contact || !contact.phone) {
            contact = { _id: contactIdStr, phone: recipient.phone || '' };
          }
          if (!contact.phone) throw new Error('RECIPIENT_PHONE_MISSING');

          const components: any[] = [];
          const mapping = batch.variableMapping || {};

          // Variable resolution (Body)
          const bodyMapping = mapping.body || (typeof mapping === 'object' && !mapping.body && !mapping.header ? mapping : null);
          if (bodyMapping) {
            const bodyParams = Object.keys(bodyMapping).sort((a, b) => Number(a) - Number(b)).map(k => ({
              type: 'text', text: String(this.resolveVar(contact, bodyMapping[k]) || '')
            }));
            if (bodyParams.length > 0) components.push({ type: 'body', parameters: bodyParams });
          }

          await CampaignMessage.findOneAndUpdate(
            { internalMessageId },
            {
              $setOnInsert: {
                workspace: workspaceId, campaign: campaignId, contact: contact._id, phone: contact.phone,
                internalMessageId, provider: 'gupshup', status: 'queued', queuedAt: new Date(),
                batchId: batch._id, batchIndex: batch.batchIndex,
              },
              $set: { status: 'dispatching', lastAttemptAt: new Date() },
              $inc: { attempts: 1 },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          await this.limiter.wait({ workspaceId, appId: providerAppId, limit: perSecondLimit });

          const result = await microserviceWorkerClient.sendTemplate({
            workspaceId,
            to: contact.phone,
            templateName: batch.templateName || 'template',
            languageCode: (campaign.templateSnapshot as any)?.language,
            components,
            options: {
              contactId: (contact as any)._id,
              campaignId: (campaign as any)._id,
              metadata: { batchId, batchIndex: batch.batchIndex },
              idempotencyKey: internalMessageId,
            },
            internalMessageId,
          });

          if (result.success) {
            this.metrics?.increment('campaign_messages_accepted_total', 'Campaign messages accepted by provider');
            successCount++;
            const messageId = result.message?.whatsappMessageId || (result.result as any)?.messageId || (result.result as any)?.providerMessageId || (result as any)?.providerMessageId;
            await (batch as any).updateRecipientStatus(contact._id.toString(), 'sent', messageId);
            await CampaignMessage.findOneAndUpdate(
              { campaign: campaignId, contact: contact._id },
              {
                $set: {
                  workspace: workspaceId,
                  campaign: campaignId,
                  contact: contact._id,
                  phone: contact.phone,
                  internalMessageId,
                  provider: 'gupshup',
                  status: 'accepted',
                  whatsappMessageId: messageId,
                  sentAt: new Date(),
                  batchId: batch._id,
                  batchIndex: batch.batchIndex,
                },
                $setOnInsert: {
                  queuedAt: new Date(),
                  createdAt: new Date(),
                },
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            if (messageId && (String(messageId).startsWith('wamid.simulated_') || String(messageId).startsWith('mock_'))) {
              setTimeout(async () => {
                try {
                  const { campaignEventsQueue } = await import('../lib/events/EventBus');
                  await campaignEventsQueue.add('MessageStatusUpdateEvent', {
                    campaignId: campaignId.toString(),
                    status: 'delivered',
                    contactId: contact._id.toString(),
                    whatsappMessageId: messageId,
                    timestamp: new Date().toISOString()
                  });
                  await campaignEventsQueue.add('MessageStatusUpdateEvent', {
                    campaignId: campaignId.toString(),
                    status: 'read',
                    contactId: contact._id.toString(),
                    whatsappMessageId: messageId,
                    timestamp: new Date().toISOString()
                  });
                } catch (simErr: any) {
                  console.warn('[CampaignWorker] Simulated status transition error:', simErr.message);
                }
              }, 500);
            }
          } else {
            this.metrics?.increment('campaign_messages_failed_total', 'Campaign message dispatch failures');
            failCount++;
            const error = result.result?.error || 'Unknown Error';
            await (batch as any).updateRecipientStatus(contact._id.toString(), 'failed', null, error);
            await CampaignMessage.findOneAndUpdate(
              { campaign: campaignId, contact: contact._id },
              {
                $set: {
                  workspace: workspaceId,
                  campaign: campaignId,
                  contact: contact._id,
                  phone: contact.phone,
                  internalMessageId,
                  provider: 'gupshup',
                  status: result?.status === 'reconciliation_required' ? 'reconciliation_required' : 'failed',
                  failedAt: new Date(),
                  failureReason: error,
                  batchId: batch._id,
                  batchIndex: batch.batchIndex,
                },
                $setOnInsert: {
                  queuedAt: new Date(),
                  createdAt: new Date(),
                },
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          }
        } catch (err: any) {
          failCount++;
          const targetContactId = contactIdStr || (recipient.contactId?._id || recipient.contactId)?.toString();
          await (batch as any).updateRecipientStatus(targetContactId, 'failed', null, err.message);
          if (targetContactId) {
            await CampaignMessage.findOneAndUpdate(
              { campaign: campaignId, contact: targetContactId },
              {
                $set: {
                  workspace: workspaceId,
                  campaign: campaignId,
                  contact: recipient.contactId,
                  phone: recipient.phone,
                  status: 'failed',
                  failedAt: new Date(),
                  failureReason: err.message,
                  lastError: err.message,
                  batchId: batch._id,
                  batchIndex: batch.batchIndex,
                },
                $setOnInsert: {
                  queuedAt: new Date(),
                  createdAt: new Date(),
                },
              },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          }
        }
      }));

      if (i + CONCURRENCY < activeRecipients.length) await new Promise(r => setTimeout(r, 25));
    }

    await (batch as any).markCompleted();

    // Updates
    await (Campaign as ICampaignModel).incrementTotal(campaignId.toString(), 'sent', successCount);
    await (Campaign as ICampaignModel).incrementTotal(campaignId.toString(), 'failed', failCount);
    const afterAudit = await (Campaign as ICampaignModel).addAuditEntry(campaignId.toString(), 'BATCH_COMPLETED', {
      reason: `Batch ${batch.batchIndex + 1} processed`,
      meta: { batchIndex: batch.batchIndex, successCount, failCount }
    });

    const batchStats = await (CampaignBatch as any).getCampaignBatchStats(campaignId);
    const isLastBatch = batchStats.completedBatches + batchStats.failedBatches >= batchStats.totalBatches;

    await microserviceWorkerClient.socketBroadcast(workspaceId, "campaign:batch_completed", {
      campaignId, batchIndex: batch.batchIndex, successCount, failCount, isLastBatch,
      totals: afterAudit?.totals || campaign.totals
    });

    if (isLastBatch) {
      const finalized = await Campaign.findOneAndUpdate({ _id: campaignId, status: { $ne: 'COMPLETED' } }, { $set: { status: 'COMPLETED', completedAt: new Date() } }, { new: true });
      if (finalized) {
        this.metrics?.increment('campaigns_completed_total', 'Campaigns completed');
        const { template } = await microserviceWorkerClient.getTemplate(workspaceId, finalized.template.toString());
        const { cost } = await microserviceWorkerClient.getPricing(workspaceId, template?.category || 'MARKETING');
        const reservedRecipientCount =
          finalized.totals?.totalRecipients ||
          finalized.totalContacts ||
          await this.countReservedRecipients(campaignId);

        const successAmount = (finalized.totals?.sent || 0) * cost;

        const { billingEventsQueue } = await import('../lib/events/EventBus');
        await billingEventsQueue.add('CampaignCompletedEvent', {
          campaignId: campaignId.toString(),
          workspaceId,
          reservedAmount: reservedRecipientCount * cost,
          actualSpend: successAmount // We only deduct actual successes
        });

        await microserviceWorkerClient.socketBroadcast(workspaceId, "campaign:status_update", {
          campaignId, status: 'COMPLETED', updatedAt: finalized.updatedAt, totals: finalized.totals
        });
      }
    }

    return { successCount, failCount };
  }

  private async countReservedRecipients(campaignId: string) {
    const result = await CampaignBatch.aggregate([
      { $match: { campaign: new Types.ObjectId(campaignId) } },
      { $group: { _id: null, total: { $sum: '$recipientCount' } } }
    ]);
    return result[0]?.total || 0;
  }

  private resolveVar(contact: any, field: string): any {
    if (!field || typeof field !== 'string') return field;
    const parts = field.split('.');
    let curr = contact;
    for (const p of parts) { curr = curr?.[p]; }
    return curr || field;
  }

  private async handleMaintenance(job: Job) {
    console.log('[CampaignWorker] 🛠️ Running periodic maintenance...');
    const { CampaignScheduler } = await import("../services/CampaignScheduler");
    const queuedCount = await CampaignScheduler.processStuckQueuedCampaigns();
    const stalledCount = await CampaignScheduler.processStalledCampaigns();
    const scheduledCount = await CampaignScheduler.processScheduledCampaigns();
    return { queuedCount, stalledCount, scheduledCount };
  }
}
