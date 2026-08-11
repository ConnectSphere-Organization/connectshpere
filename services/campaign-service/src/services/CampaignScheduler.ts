import { Campaign, ICampaignModel } from '../models';
import { CampaignQueueService } from '../lib/campaign-queue';
import { CampaignService } from './CampaignService';
import { CampaignBatch } from '../models/CampaignBatch';

export class CampaignScheduler {
  /**
   * Scan for campaigns that should have started by now
   */
  static async processScheduledCampaigns(): Promise<number> {
    const now = new Date();
    const campaigns = await Campaign.find({
      status: 'SCHEDULED',
      scheduledAt: { $lte: now }
    });

    for (const campaign of campaigns) {
      try {
        console.log(`[Scheduler] ⏰ Triggering scheduled campaign: ${campaign.name} (${campaign._id})`);
        
        await CampaignService.startCampaign(
          campaign._id.toString(),
          campaign.workspace.toString(),
          (campaign.createdBy as any)?.toString() || 'SYSTEM'
        );

        await CampaignQueueService.enqueue(
          campaign._id.toString(),
          campaign.workspace.toString()
        );

      } catch (err: any) {
        console.error(`[Scheduler] Failed to start campaign ${campaign._id}:`, err.message);
        campaign.status = 'FAILED';
        await campaign.save();
      }
    }

    return campaigns.length;
  }

  /**
   * Scan for campaigns stuck in 'QUEUED' state and recover them.
   */
  static async processStuckQueuedCampaigns(): Promise<number> {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    const queuedCampaigns = await Campaign.find({
      status: 'QUEUED',
      updatedAt: { $lte: twoMinutesAgo }
    });

    for (const campaign of queuedCampaigns) {
      try {
        console.warn(`[Scheduler] ⚠️ Recovering stuck QUEUED campaign: ${campaign.name} (${campaign._id})`);

        const batchCount = await CampaignBatch.countDocuments({ campaign: campaign._id });

        if (batchCount > 0) {
          campaign.status = 'RUNNING';
          campaign.startedAt = campaign.startedAt || new Date();
          await campaign.save();
          await (Campaign as ICampaignModel).addAuditEntry(campaign._id.toString(), 'SYSTEM_RECOVERED', {
            reason: 'Promoted QUEUED campaign to RUNNING as batches already exist'
          });
        } else {
          await CampaignQueueService.enqueue(
            campaign._id.toString(),
            campaign.workspace.toString()
          );
          await (Campaign as ICampaignModel).addAuditEntry(campaign._id.toString(), 'SYSTEM_RETRY', {
            reason: 'Re-enqueued stuck QUEUED campaign execution job'
          });
        }
      } catch (err: any) {
        console.error(`[Scheduler] Failed recovery for QUEUED campaign ${campaign._id}:`, err.message);
      }
    }

    return queuedCampaigns.length;
  }

  /**
   * Scan for campaigns stuck in 'RUNNING' state with no active progress
   */
  static async processStalledCampaigns(): Promise<number> {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    
    const stalled = await Campaign.find({
      status: 'RUNNING',
      updatedAt: { $lte: fourHoursAgo }
    });

    for (const campaign of stalled) {
      try {
        console.warn(`[Scheduler] ⚠️ Detected stalled campaign: ${campaign.name} (${campaign._id})`);
        
        const pendingCount = await CampaignBatch.countDocuments({
          campaign: campaign._id,
          status: { $in: ['PENDING', 'PROCESSING'] }
        });

        if (pendingCount === 0) {
          campaign.status = 'COMPLETED';
          await campaign.save();
          await (Campaign as ICampaignModel).addAuditEntry(campaign._id.toString(), 'SYSTEM_RECOVERED', { reason: 'No pending batches found after stall check' });
        } else {
          campaign.status = 'PAUSED';
          await campaign.save();
          await (Campaign as ICampaignModel).addAuditEntry(campaign._id.toString(), 'SYSTEM_PAUSED', { reason: 'Stalled with pending batches. User review required.' });
        }
      } catch (err: any) {
        console.error(`[Scheduler] Failed recovery for campaign ${campaign._id}:`, err.message);
      }
    }

    return stalled.length;
  }
}
