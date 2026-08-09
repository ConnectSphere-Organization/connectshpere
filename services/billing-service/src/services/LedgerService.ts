import { WalletModel, WalletTransactionModel, WorkspaceModel } from '../models';
import mongoose from 'mongoose';

export class LedgerService {
  private async syncWorkspaceDoc(workspaceId: string, wallet: any) {
    if (!workspaceId || !wallet) return;
    try {
      const balanceRupees = (wallet.availableBalance + (wallet.parkedBalance || 0)) / 100;
      await WorkspaceModel.findByIdAndUpdate(workspaceId, {
        $set: {
          wallet: {
            balance: balanceRupees,
            availableBalance: wallet.availableBalance,
            parkedBalance: wallet.parkedBalance || 0,
            currency: wallet.currency || 'INR',
          }
        }
      });
    } catch (err: any) {
      console.warn('[LedgerService] Non-fatal: failed to sync workspace.wallet document:', err.message);
    }
  }

  async getWallet(workspaceId: string) {
    let wallet = await WalletModel.findOne({ workspaceId });
    if (!wallet) {
      wallet = await WalletModel.create({ workspaceId, availableBalance: 0, parkedBalance: 0 });
    }
    await this.syncWorkspaceDoc(workspaceId, wallet);
    return wallet;
  }

  async credit(
    workspaceId: string,
    amount: number,
    description: string,
    externalReferenceId?: string
  ) {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_CREDIT_AMOUNT');
    if (!externalReferenceId) throw new Error('EXTERNAL_REFERENCE_REQUIRED');

    await WalletModel.updateOne(
      { workspaceId },
      { $setOnInsert: { availableBalance: 0, parkedBalance: 0, currency: 'INR' } },
      { upsert: true },
    );

    const wallet = await WalletModel.findOneAndUpdate(
      { workspaceId, processedExternalReferences: { $ne: externalReferenceId } },
      {
        $inc: { availableBalance: amount },
        $addToSet: { processedExternalReferences: externalReferenceId },
      },
      { new: true },
    );

    if (!wallet) {
      const existingWallet = await WalletModel.findOne({ workspaceId });
      if (!existingWallet) throw new Error('WALLET_NOT_FOUND');
      return existingWallet;
    }

    const newBalance = wallet.availableBalance + wallet.parkedBalance;
    const previousBalance = newBalance - amount;
    await WalletTransactionModel.updateOne({ externalReferenceId }, {
      $setOnInsert: {
        workspaceId,
        amount,
        type: 'RECHARGE',
        previousBalance,
        newBalance,
        description,
        externalReferenceId,
        status: 'COMPLETED'
      }
    }, { upsert: true });

    await this.syncWorkspaceDoc(workspaceId, wallet);
    return wallet;
  }

  /**
   * Deduct funds. Pass `idempotencyKey` (or `externalReferenceId`) for any
   * caller that may retry — duplicate calls with the same key return the
   * existing wallet without double-spending.
   */
  async deduct(
    workspaceId: string,
    amount: number,
    description: string,
    referenceType?: string,
    referenceId?: string,
    idempotencyKey?: string
  ) {
    // Idempotency check
    if (idempotencyKey) {
      const existingTx = await WalletTransactionModel.findOne({ externalReferenceId: idempotencyKey });
      if (existingTx) {
        const wallet = await WalletModel.findOne({ workspaceId });
        return wallet!;
      }
    }

    const wallet = await WalletModel.findOne({ workspaceId });
    if (!wallet) throw new Error('WORKSPACE_NOT_FOUND');
    if (wallet.availableBalance < amount) throw new Error('INSUFFICIENT_FUNDS');

    const previousBalance = wallet.availableBalance + wallet.parkedBalance;
    wallet.availableBalance -= amount;
    await wallet.save();

    await WalletTransactionModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      amount,
      type: 'SPEND',
      previousBalance,
      newBalance: wallet.availableBalance + wallet.parkedBalance,
      description,
      referenceType,
      referenceId,
      externalReferenceId: idempotencyKey,
      status: 'COMPLETED'
    });

    await this.syncWorkspaceDoc(workspaceId, wallet);
    return wallet;
  }

  /**
   * Reserve (park) campaign budget. Idempotent per campaignId.
   */
  async reserveCampaignBudget(workspaceId: string, amount: number, campaignId: string) {
    const idempotencyKey = `park:${campaignId}`;
    const existingTx = await WalletTransactionModel.findOne({ externalReferenceId: idempotencyKey });
    if (existingTx) return;

    const wallet = await WalletModel.findOne({ workspaceId });
    if (!wallet) throw new Error('WORKSPACE_NOT_FOUND');
    if (wallet.availableBalance < amount) throw new Error('INSUFFICIENT_FUNDS');

    const previousBalance = wallet.availableBalance + wallet.parkedBalance;
    wallet.availableBalance -= amount;
    wallet.parkedBalance += amount;
    await wallet.save();

    await WalletTransactionModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      amount,
      type: 'PARK',
      previousBalance,
      newBalance: wallet.availableBalance + wallet.parkedBalance,
      description: `Budget reserved for campaign ${campaignId}`,
      referenceType: 'CAMPAIGN',
      referenceId: campaignId,
      externalReferenceId: idempotencyKey,
      status: 'COMPLETED'
    });
    await this.syncWorkspaceDoc(workspaceId, wallet);
  }

  /**
   * Settle a previously-parked campaign budget. Idempotent per campaignId.
   */
  async settleCampaignBudget(
    workspaceId: string,
    campaignId: string,
    reservedAmount: number,
    actualSpend: number
  ) {
    const idempotencyKey = `settle:${campaignId}`;
    const existingTx = await WalletTransactionModel.findOne({ externalReferenceId: idempotencyKey });
    if (existingTx) return;

    const wallet = await WalletModel.findOne({ workspaceId });
    if (!wallet) throw new Error('WORKSPACE_NOT_FOUND');
    if (wallet.parkedBalance < reservedAmount) throw new Error('INVALID_RESERVED_AMOUNT');

    const previousBalance = wallet.availableBalance + wallet.parkedBalance;
    const refundAmount = reservedAmount - actualSpend;
    wallet.parkedBalance -= reservedAmount;
    wallet.availableBalance += refundAmount;
    await wallet.save();

    const isRefund = refundAmount > 0;
    await WalletTransactionModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      amount: actualSpend,
      type: isRefund ? 'UNPARK' : 'SPEND',
      previousBalance,
      newBalance: wallet.availableBalance + wallet.parkedBalance,
      description: `Campaign ${campaignId} settled. Spent: ${actualSpend}. Refunded: ${Math.max(0, refundAmount)}`,
      referenceType: 'CAMPAIGN',
      referenceId: campaignId,
      externalReferenceId: idempotencyKey,
      status: 'COMPLETED'
    });
    await this.syncWorkspaceDoc(workspaceId, wallet);
  }

  /**
   * Migrate a balance from the legacy (monolith) wallet store. Captures
   * `previousBalance` BEFORE the mutation so the audit trail does not
   * mis-report an already-mutated value. Idempotent via `isLegacySynced`.
   */
  async syncLegacyBalance(workspaceId: string, balancePaise: number) {
    let wallet = await WalletModel.findOne({ workspaceId });

    let previousBalance = 0;
    let isNew = false;

    if (!wallet) {
      isNew = true;
      wallet = new WalletModel({
        workspaceId,
        availableBalance: balancePaise,
        parkedBalance: 0,
        isLegacySynced: true,
      });
    } else {
      if (wallet.isLegacySynced) return wallet;

      // Capture state BEFORE mutation; the previous logic computed it
      // post-hoc by subtracting and could drift if other fields changed.
      previousBalance = wallet.availableBalance + wallet.parkedBalance;
      wallet.availableBalance += balancePaise;
      wallet.isLegacySynced = true;
    }

    await wallet.save();

    const tx = new WalletTransactionModel({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      amount: balancePaise,
      type: 'MIGRATION',
      previousBalance: isNew ? 0 : previousBalance,
      newBalance: wallet.availableBalance + wallet.parkedBalance,
      description: 'Legacy Balance Sync (Automated Merge)',
      externalReferenceId: `legacy-sync:${workspaceId}`,
      status: 'COMPLETED'
    });
    await tx.save();

    await this.syncWorkspaceDoc(workspaceId, wallet);
    return wallet;
  }
}
