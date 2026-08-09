import { Request, Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { config } from '../config';
import { LedgerService } from '../services/LedgerService';
import { RazorpayService } from '../services/RazorpayService';
import { InvoiceService } from '../services/InvoiceService';
import { PricingService } from '../services/PricingService';
import { PlanModel, SubscriptionModel, WorkspaceModel, WalletTransactionModel, OrderModel, RazorpayOrderModel } from '../models';
import { AuthRequest } from '../middleware/auth';
import { billingMetrics } from '../lib/metrics';
import { classifyPaymentError } from './payment-error';
import { buildSubscriptionActivation, resolveBillingPlan } from '../services/plan-activation-service';

const ledgerService = new LedgerService();
const invoiceService = new InvoiceService();

function sendPaymentError(res: Response, err: any) {
  const response = classifyPaymentError(err);
  return res.status(response.status).json(response.body);
}

export class WalletController {
  static async getWorkspace(req: Request, res: Response) {
    try {
      const { workspaceId } = req.params;
      const workspace = await WorkspaceModel.findById(workspaceId).populate('planId');
      if (!workspace) {
        // Sync on the fly or return default
        return res.json({ success: true, workspace: { billingStatus: 'active', planSlug: 'free' } });
      }
      res.json({ success: true, workspace: { ...workspace.toObject(), planSlug: (workspace.planId as any)?.slug || 'free' } });

    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getWallet(req: Request, res: Response) {

    try {
      const workspaceId = req.params.workspaceId as string;
      const wallet = await ledgerService.getWallet(workspaceId);
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async syncWallet(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { balancePaise } = req.body;
      const wallet = await ledgerService.syncLegacyBalance(workspaceId, Number(balancePaise));
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async createRechargeOrder(req: Request, res: Response) {
    try {
      const workspaceId: string = req.body?.workspaceId
        || req.params?.workspaceId
        || (req as any).workspace?._id?.toString()
        || (req as any).workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required' });
      }

      const { amount, amountPaise } = req.body;

      const finalPaise = amountPaise || (amount ? Math.round(amount * 100) : 0);

      if (!finalPaise || finalPaise < 10000) {
        return res.status(400).json({ success: false, message: "Minimum recharge amount is 100 INR (10000 paise)" });
      }

      const order = await RazorpayService.createRechargeOrder(finalPaise, workspaceId);
      billingMetrics.increment('payment_orders_created_total', 'Razorpay payment orders created', { type: 'recharge' });

      // Persist order metadata locally so verifyRecharge can look up the amount
      // without calling the Razorpay API (avoids FAILED_TO_FETCH_RAZORPAY_PAYMENT).
      await RazorpayOrderModel.create({
        orderId: order.id,
        workspaceId,
        amountPaise: Number(order.amount),
        currency: order.currency || 'INR',
        type: 'RECHARGE',
      });

      res.json({
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: config.razorpayKeyId
      });
    } catch (err: any) {
      return sendPaymentError(res, err);
    }
  }

  static async createPlanOrder(req: Request, res: Response) {
    try {
      const workspaceId: string = req.body?.workspaceId
        || req.params?.workspaceId
        || (req as any).workspace?._id?.toString()
        || (req as any).workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required' });
      }

      const { planId, planSlug, planName, monthlyBaseFeeCents, currency } = req.body;

      console.log(`[WalletController.createPlanOrder] workspaceId: ${workspaceId}, planId: ${planId}, planSlug: ${planSlug}, monthlyBaseFeeCents: ${monthlyBaseFeeCents}`);

      // Use the plan details passed from the main server instead of looking them up
      if (!planSlug) {
        return res.status(400).json({ success: false, message: "Plan slug is required" });
      }

      const amountPaise = monthlyBaseFeeCents || 0;

      // If amount is 0, this is a free plan activation
      if (amountPaise === 0) {
        await WorkspaceModel.findByIdAndUpdate(workspaceId, {
          planId: planId,
          billingStatus: 'active'
        });
        return res.json({
          success: true,
          requiresPayment: false,
          message: "Plan activated successfully",
          planSlug: planSlug
        });
      }

      const order = await RazorpayService.createPlanOrder(Number(amountPaise), workspaceId, planSlug);

      // Persist order locally for lookup at verify time
      await RazorpayOrderModel.create({
        orderId: order.id,
        workspaceId,
        amountPaise: Number(order.amount),
        currency: currency || 'INR',
        type: 'PLAN_UPGRADE',
        planSlug,
      });

      res.json({
        success: true,
        requiresPayment: true,
        orderId: order.id,
        amount: order.amount,
        currency: currency || 'INR',
        keyId: config.razorpayKeyId,
        planSlug: planSlug
      });
    } catch (err: any) {
      console.error(`[WalletController.createPlanOrder] Error:`, err);
      return sendPaymentError(res, err);
    }
  }

  static async getTransactions(req: Request, res: Response) {

    try {
      const workspaceId = req.params.workspaceId as string;
      const { limit = '50', offset = '0' } = req.query;

      const txs = await WalletTransactionModel.find({ workspaceId })
        .sort({ createdAt: -1 })
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();

      const txIds = txs.map(tx => tx._id.toString());
      const invoices = await invoiceService.getInvoicesForTransactions(txIds);
      const invoiceMap = new Map(invoices.map(inv => [inv.providerInvoiceId, inv.invoiceNumber]));

      const transactions = txs.map(tx => ({
        ...tx,
        _id: tx._id.toString(),
        amount: tx.amount || 0,
        invoiceNumber: invoiceMap.get(tx._id.toString()) || null
      }));

      res.json({ success: true, transactions });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async addFunds(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { amount, description, externalReferenceId } = req.body;
      const wallet = await ledgerService.credit(workspaceId, Number(amount), description as string, externalReferenceId as string);
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async deductFunds(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { amount, description, externalReferenceId, referenceType, referenceId } = req.body;
      const wallet = await ledgerService.deduct(
        workspaceId,
        Number(amount),
        description as string,
        referenceType as string | undefined,
        referenceId as string | undefined,
        externalReferenceId as string | undefined
      );
      res.json({ success: true, wallet });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async reserveCampaignBudget(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { amount, campaignId } = req.body;
      await ledgerService.reserveCampaignBudget(workspaceId, Number(amount), campaignId as string);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async settleCampaignBudget(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { campaignId, reservedAmount, actualSpend } = req.body;
      await ledgerService.settleCampaignBudget(workspaceId, campaignId as string, Number(reservedAmount), Number(actualSpend));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async verifyRecharge(req: AuthRequest, res: Response) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, workspaceDetails } = req.body;
      // Support both explicit workspaceId in body AND workspace-scoped routes (from JWT auth context)
      const workspaceId: string = req.body.workspaceId
        || req.workspace?._id?.toString()
        || req.workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required — ensure you are authenticated' });
      }

      // 1. Verify Razorpay signature (HMAC — no external API call needed)
      const isValid = RazorpayService.verifySignature(
        razorpay_order_id as string,
        razorpay_payment_id as string,
        razorpay_signature as string
      );
      if (!isValid) {
        billingMetrics.increment('payment_verification_failures_total', 'Payment verification failures', { type: 'recharge', reason: 'signature' });
        return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
      }

      // 2. Look up the order amount from our local cache (avoids calling Razorpay API)
      const localOrder = await RazorpayOrderModel.findOne({ orderId: razorpay_order_id });
      if (!localOrder) {
        return res.status(400).json({ success: false, message: 'Order not found. Please contact support.' });
      }
      if (localOrder.workspaceId !== workspaceId || localOrder.type !== 'RECHARGE') {
        billingMetrics.increment('billing_reconciliation_mismatches_total', 'Payment intent reconciliation mismatches', { type: 'recharge' });
        return res.status(403).json({ success: false, error: { code: 'PAYMENT_ORDER_MISMATCH', message: 'Payment order does not belong to this workspace or operation' } });
      }
      const amountPaise = localOrder.amountPaise;

      // 3. Credit the wallet (idempotent via externalReferenceId)
      const wallet = await ledgerService.credit(
        workspaceId,
        Number(amountPaise),
        `Razorpay Recharge: ${razorpay_payment_id}`,
        razorpay_payment_id as string
      );

      // 4. Generate invoice (best-effort — don't fail the recharge if invoice fails)
      try {
        const tx = await WalletTransactionModel.findOne({ externalReferenceId: razorpay_payment_id as string }).lean();
        if (tx) {
          await invoiceService.generateForTransaction(tx._id.toString(), {
            workspaceName: workspaceDetails?.workspaceName || workspaceDetails?.name || 'Workspace',
            ownerName: workspaceDetails?.ownerName || 'Admin',
            ownerEmail: workspaceDetails?.ownerEmail || 'support@example.com',
            country: workspaceDetails?.country,
            walletCurrency: workspaceDetails?.walletCurrency || localOrder.currency || 'INR'
          });
        }
      } catch (invoiceErr: any) {
        console.warn('[verifyRecharge] Invoice generation failed (non-fatal):', invoiceErr.message);
      }

      res.json({ success: true, message: 'Wallet recharged successfully', wallet });
    } catch (err: any) {
      console.error('[verifyRecharge] Error:', err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async verifyPlanUpgrade(req: AuthRequest, res: Response) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, workspaceDetails } = req.body;
      // Support both explicit workspaceId in body AND workspace-scoped routes (from JWT auth context)
      const workspaceId: string = req.body.workspaceId
        || req.workspace?._id?.toString()
        || req.workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required' });
      }

      // 1. Verify Razorpay signature (HMAC — no external API call needed)
      const isValid = RazorpayService.verifySignature(
        razorpay_order_id as string,
        razorpay_payment_id as string,
        razorpay_signature as string
      );
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
      }

      // 2. Look up order from local cache to get amount + planSlug
      const localOrder = await RazorpayOrderModel.findOne({ orderId: razorpay_order_id });
      if (!localOrder) {
        return res.status(400).json({ success: false, message: 'Order not found. Please contact support.' });
      }
      const amountPaise = localOrder.amountPaise;
      const planSlug = localOrder.planSlug;

      // 3. Record the plan purchase as a transaction (no wallet balance change)
      const wallet = await ledgerService.getWallet(workspaceId);
      const tx = new WalletTransactionModel({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        amount: Number(amountPaise),
        type: 'PLAN_PURCHASE',
        previousBalance: wallet.availableBalance,
        newBalance: wallet.availableBalance,
        description: `Plan Upgrade to ${planSlug}`,
        externalReferenceId: razorpay_payment_id as string,
        status: 'COMPLETED'
      });
      await tx.save();

      // 4. Activate the plan on the workspace
      const plan = await PlanModel.findOne({ slug: planSlug });
      if (!plan) {
        return res.status(400).json({ success: false, message: `Plan "${planSlug}" no longer exists` });
      }

      await Promise.all([
        WorkspaceModel.findByIdAndUpdate(workspaceId, {
          planId: plan._id,
          billingStatus: 'active'
        }, { upsert: true }),
        SubscriptionModel.findOneAndUpdate(
          { workspaceId },
          { $set: buildSubscriptionActivation(plan._id, plan.billingIntervalMonths) },
          { upsert: true, new: true }
        ),
      ]);

      const { publishBillingEvent } = await import('../lib/event-bus');
      await publishBillingEvent('plan_purchased', workspaceId, {
        planSlug: plan.slug,
        planName: plan.name,
        features: plan.features || [],
        limits: plan.limits || {},
        amount: amountPaise / 100,
        paymentId: razorpay_payment_id,
      });

      // 5. Generate invoice (best-effort)
      try {
        await invoiceService.generateForTransaction(tx._id.toString(), workspaceDetails);
      } catch (invoiceErr: any) {
        console.warn('[verifyPlanUpgrade] Invoice generation failed (non-fatal):', invoiceErr.message);
      }

      res.json({
        success: true,
        wallet,
        planSlug,
        plan: { name: plan.name, slug: plan.slug, features: plan.features || [], limits: plan.limits || {} },
      });
    } catch (err: any) {
      console.error('[verifyPlanUpgrade] Error:', err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  }

  static async getPricing(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { category } = req.query;
      const resolvedCategory = PricingService.resolveCategory(category as string);
      const cost = await PricingService.getCost(workspaceId, resolvedCategory);
      res.json({ success: true, cost, category: resolvedCategory });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // Full per-category price map (paise) for the authenticated workspace.
  static async getPricingMap(req: Request, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const map = await PricingService.getPricingMap(workspaceId);
      res.json({ success: true, data: map });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async downloadInvoice(req: AuthRequest, res: Response) {
    try {
      const invoiceNumber = req.params.invoiceNumber as string;
      // Resolve workspaceId from JWT auth context (workspace-scoped route)
      // or fall back to legacy query param for admin routes
      const workspaceId: string =
        req.workspace?._id?.toString() || req.workspace?.id || (req.query.workspaceId as string);

      if (!workspaceId) {
        return res.status(400).send('workspaceId is required');
      }

      const invoice = await invoiceService.getInvoiceByNumber(invoiceNumber, workspaceId);
      if (!invoice) return res.status(404).send('Invoice not found');

      const workspaceName = (invoice as any).customerDetails?.workspaceName || 'Workspace';
      const ownerName = (invoice as any).customerDetails?.ownerName || 'Admin';
      const ownerEmail = (invoice as any).customerDetails?.ownerEmail || 'support@example.com';
      const country = (invoice as any).customerDetails?.country || '';

      const formatCurrency = (cents: number) => {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: (invoice as any).currency || 'INR'
        }).format(cents / 100);
      };

      const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invoice ${invoice.invoiceNumber}</title>
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; }
            .container { max-width: 800px; margin: 0 auto; padding: 40px; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #eee; padding-bottom: 20px; margin-bottom: 40px; }
            .company-details h1 { margin: 0; color: #2563eb; }
            .invoice-details { text-align: right; }
            .invoice-details h2 { margin: 0; color: #64748b; font-weight: normal; text-transform: uppercase; letter-spacing: 2px; }
            .billing-info { display: flex; justify-content: space-between; margin-bottom: 40px; }
            .bill-to h3, .bill-from h3 { margin-bottom: 10px; color: #64748b; text-transform: uppercase; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 40px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
            th { background-color: #f8fafc; color: #64748b; font-weight: bold; text-transform: uppercase; font-size: 12px; }
            .text-right { text-align: right; }
            .totals { margin-left: auto; width: 300px; }
            .totals-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
            .totals-row.grand-total { font-weight: bold; font-size: 18px; border-bottom: none; border-top: 2px solid #333; }
            .footer { margin-top: 50px; text-align: center; color: #94a3b8; font-size: 12px; }
            @media print {
                body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
                .no-print { display: none !important; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="no-print" style="margin-bottom: 20px; text-align: right;">
                <button onclick="window.print()" style="padding: 10px 20px; background-color: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">
                    Print / Save PDF
                </button>
            </div>
            <div class="header">
                <div class="company-details">
                    <h1>wApi Platform</h1>
                    <p>Tech Corp Ltd.<br>123 Tech Park, Innovation Hub<br>support@wapi.example.com</p>
                </div>
                <div class="invoice-details">
                    <h2>Invoice</h2>
                    <p><strong>#${invoice.invoiceNumber}</strong><br>
                    Issued: ${new Date(invoice.issuedAt!).toLocaleDateString()}<br>
                    Status: <span style="color: #10b981; font-weight: bold;">PAID</span></p>
                </div>
            </div>

            <div class="billing-info">
                <div class="bill-to">
                    <h3>Bill To</h3>
                    <strong>Workspace: ${workspaceName}</strong><br>
                    Admin: ${ownerName}<br>
                    Email: ${ownerEmail}<br>
                    ${country || ''}
                </div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Description</th>
                        <th class="text-right">Qty</th>
                        <th class="text-right">Unit Price</th>
                        <th class="text-right">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${invoice.lineItems.map(item => `
                    <tr>
                        <td>${item.description || item.type}</td>
                        <td class="text-right">${item.units}</td>
                        <td class="text-right">${formatCurrency(item.unitPriceCents)}</td>
                        <td class="text-right">${formatCurrency(item.amountCents)}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>

            <div class="totals">
                <div class="totals-row">
                    <span>Subtotal</span>
                    <span>${formatCurrency(invoice.subtotalCents)}</span>
                </div>
                <div class="totals-row">
                    <span>Tax (18% GST)</span>
                    <span>${formatCurrency(invoice.taxCents)}</span>
                </div>
                <div class="totals-row grand-total">
                    <span>Total Paid</span>
                    <span>${formatCurrency(invoice.totalCents)}</span>
                </div>
            </div>

            <div class="footer">
                <p>This is a computer generated invoice and does not require a physical signature.</p>
                <p>Thank you for your business!</p>
            </div>
        </div>
    </body>
    </html>
    `;
      res.send(htmlContent);
    } catch (err: any) {
      res.status(500).send("Internal Server Error");
    }
  }

  static async verifyPaymentMethod(req: AuthRequest, res: Response) {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      // Resolve workspaceId from body or JWT auth context
      const workspaceId: string = req.body.workspaceId
        || req.workspace?._id?.toString()
        || req.workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required' });
      }

      const isValid = RazorpayService.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
      if (!isValid) throw new Error("INVALID_SIGNATURE");

      // Mark workspace as active
      await WorkspaceModel.findByIdAndUpdate(workspaceId, {
        $set: { billingStatus: 'active' }
      });

      res.json({ success: true, message: "Payment method verified" });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async createVerificationOrder(req: Request, res: Response) {
    try {
      const workspaceId: string = req.body?.workspaceId
        || req.params?.workspaceId
        || (req as any).workspace?._id?.toString()
        || (req as any).workspace?.id;

      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'workspaceId is required' });
      }

      // We are creating a ₹1 (100 paise) order for verifying the payment method
      const order = await RazorpayService.createRechargeOrder(100, workspaceId);

      await RazorpayOrderModel.create({
        orderId: order.id,
        workspaceId,
        amountPaise: Number(order.amount),
        currency: order.currency || 'INR',
        type: 'VERIFICATION',
      });

      res.json({
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: config.razorpayKeyId
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getBillingStats(req: Request, res: Response) {

    try {
      // 1. Calculate gross revenue
      const revenueResult = await WalletTransactionModel.aggregate([
        { $match: { type: { $in: ['RECHARGE', 'PLAN_PURCHASE'] }, status: 'COMPLETED' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const grossRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

      // 2. Count active subs
      const activeSubs = await WorkspaceModel.countDocuments({ billingStatus: 'active' });

      res.json({
        success: true,
        data: {
          grossRevenue,
          activeSubs,
          churnRate: 1.4,
          pendingPayouts: 0
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getAllInvoices(req: Request, res: Response) {

    try {
      const { limit = '50' } = req.query;
      const invoices = await invoiceService.getAllInvoices(Number(limit));
      res.json({ success: true, invoices });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async handleRazorpayWebhook(req: Request, res: Response) {
    const correlationId = req.headers['x-correlation-id'] || 'system';

    try {
      const signature = req.headers["x-razorpay-signature"] as string;
      const secret = config.razorpayWebhookSecret;

      if (!config.razorpayEnabled) {
        return res.status(503).json({ success: false, error: { code: 'FEATURE_DISABLED', message: 'Razorpay payments are disabled', requestId: correlationId } });
      }
      if (!secret) {
        return res.status(503).json({ success: false, error: { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', message: 'Razorpay webhook verification is not configured', requestId: correlationId } });
      } else {
        const rawBody = (req as any).rawBody;
        if (!rawBody) {
          console.error(`[Billing Webhook][${correlationId}] Raw body missing for signature verification.`);
          return res.status(400).json({ success: false, message: "Raw body missing" });
        }

        const expectedSignature = crypto
          .createHmac("sha256", secret)
          .update(rawBody)
          .digest("hex");

        // Constant-time compare so an attacker can't time-side-channel the
        // signature.
        const expectedBuf = Buffer.from(expectedSignature, 'utf8');
        const providedBuf = Buffer.from(String(signature || ''), 'utf8');
        if (
          expectedBuf.length !== providedBuf.length ||
          !crypto.timingSafeEqual(expectedBuf, providedBuf)
        ) {
          console.warn(`[Billing Webhook][${correlationId}] Invalid Razorpay signature detected.`);
          return res.status(400).json({ success: false, message: "Invalid signature" });
        }
      }

      const event = req.body;
      console.log(`[Billing Webhook][${correlationId}] Received Razorpay event: ${event.event}`);

      if (event.event === 'payment.captured') {
        const payment = event.payload?.payment?.entity;
        if (!payment?.id || !Number.isFinite(Number(payment.amount))) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_PAYMENT_WEBHOOK', message: 'Payment webhook payload is invalid', requestId: correlationId } });
        }
        const paymentId = payment.id;
        const amount = payment.amount;
        const workspaceId = payment.notes?.workspaceId || payment.notes?.workspace_id;

        if (!workspaceId) {
          console.warn(`[Billing Webhook][${correlationId}] No workspaceId in payment notes. Event: ${event.event}`);
          return res.status(400).json({ success: false, error: { code: 'INVALID_PAYMENT_WEBHOOK', message: 'Payment workspace context is missing', requestId: correlationId } });
        }

        // 1. Check for Idempotency
        const existingTx = await WalletTransactionModel.findOne({ externalReferenceId: paymentId });
        if (existingTx) {
          billingMetrics.increment('payment_webhook_duplicates_total', 'Duplicate payment webhooks', { event_type: event.event });
          console.log(`[Billing Webhook][${correlationId}] Transaction ${paymentId} already processed. Skipping.`);
          return res.status(200).json({ success: true, message: "Already processed" });
        }

        const type = payment.notes?.type || 'RECHARGE';

        const { publishBillingEvent } = await import("../lib/event-bus");

        if (type === 'PLAN_UPGRADE' || type === 'PLAN_PURCHASE') {
          const planSlug = payment.notes?.planSlug;
          console.log(`[Billing Webhook][${correlationId}] Processing Plan Upgrade: ${planSlug} for workspace ${workspaceId}`);

          const wallet = await ledgerService.getWallet(workspaceId);

          const tx = new WalletTransactionModel({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            amount: Number(amount),
            type: 'PLAN_PURCHASE',
            previousBalance: wallet.availableBalance,
            newBalance: wallet.availableBalance,
            description: `Plan Upgrade to ${planSlug} (Webhook)`,
            externalReferenceId: paymentId,
            status: 'COMPLETED'
          });
          await tx.save();

          const plan = await PlanModel.findOne({ slug: planSlug });
          if (plan) {
            await Promise.all([
              WorkspaceModel.findByIdAndUpdate(workspaceId, {
                planId: plan._id,
                billingStatus: 'active'
              }, { upsert: true }),
              SubscriptionModel.findOneAndUpdate(
                { workspaceId },
                { $set: buildSubscriptionActivation(plan._id, plan.billingIntervalMonths) },
                { upsert: true, new: true }
              ),
            ]);
          }

          await invoiceService.generateForTransaction(tx._id.toString(), {
            workspaceName: payment.notes?.workspaceName || "Workspace",
            ownerName: payment.notes?.ownerName || "Admin",
            ownerEmail: payment.notes?.ownerEmail || "support@example.com"
          });

          await publishBillingEvent('plan_purchased', workspaceId, {
            planSlug,
            planName: plan?.name,
            features: plan?.features || [],
            limits: plan?.limits || {},
            amount: amount / 100,
            paymentId
          });
        } else if (payment.notes?.type === 'commerce_order') {
          const orderId = payment.notes?.orderId || payment.notes?.order_id;
          if (orderId) {
            const order = await OrderModel.findById(orderId);
            if (order) {
              await order.markAsPaid(paymentId, 'razorpay');
              await order.save();
              console.log(`[Billing Webhook][${correlationId}] Commerce Order ${order.orderNumber} marked as PAID via webhook.`);

              await publishBillingEvent('order_paid', workspaceId, {
                orderId,
                orderNumber: order.orderNumber,
                amount: amount / 100
              });
            }
          }
        } else {
          console.log(`[Billing Webhook][${correlationId}] Crediting wallet for workspace ${workspaceId}: ${amount} paise`);
          await ledgerService.credit(workspaceId, amount, `Wallet Recharge (Webhook): ${paymentId}`, paymentId);
          const tx = await WalletTransactionModel.findOne({ externalReferenceId: paymentId }).lean();
          if (tx) {
            await invoiceService.generateForTransaction(tx._id.toString(), {
              workspaceName: payment.notes?.workspaceName || "Workspace",
              ownerName: payment.notes?.ownerName || "Admin",
              ownerEmail: payment.notes?.ownerEmail || "support@example.com"
            });
          }

          await publishBillingEvent('wallet_recharged', workspaceId, {
            amount: amount / 100,
            paymentId
          });
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      billingMetrics.increment('wallet_credit_failures_total', 'Wallet credit or payment webhook processing failures', { operation: 'razorpay_webhook' });
      console.error(`[Billing Webhook][${correlationId}] Fatal Error:`, err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // --- Plan CRUD Endpoints ---
  static async listPlans(req: Request, res: Response) {
    try {
      const activeOnly = req.query.activeOnly !== 'false';
      const query = activeOnly ? { isActive: true } : {};
      const plans = await PlanModel.find(query).sort({ monthlyBaseFeeCents: 1 });
      res.json({
        success: true,
        data: plans,
        paymentEnabled: config.razorpayEnabled,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getPlan(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { slug: id };
      const plan = await PlanModel.findOne(query);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, data: plan });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  static async createPlan(req: Request, res: Response) {
    try {
      const plan = await PlanModel.create(req.body);
      res.status(201).json({ success: true, data: plan });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async updatePlan(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const plan = await PlanModel.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, data: plan });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async deletePlan(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const plan = await PlanModel.findByIdAndDelete(id);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
      res.json({ success: true, message: 'Plan deleted successfully' });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  static async seedPlans(req: Request, res: Response) {
    const DEFAULT_PLANS = [
      {
        name: "Free Tier",
        slug: "free",
        monthlyBaseFeeCents: 0,
        yearlyBaseFeeCents: 0,
        currency: "INR",
        isActive: true,
        isDefault: true
      },
      {
        name: "Growth",
        slug: "growth",
        monthlyBaseFeeCents: 499900,
        yearlyBaseFeeCents: 4999000,
        currency: "INR",
        isActive: true
      },
      {
        name: "Enterprise",
        slug: "enterprise",
        monthlyBaseFeeCents: 1499900,
        yearlyBaseFeeCents: 14999000,
        currency: "INR",
        isActive: true
      }
    ];

    try {
      const results = [];
      for (const planData of DEFAULT_PLANS) {
        const plan = await PlanModel.findOneAndUpdate(
          { slug: planData.slug },
          { $set: planData },
          { upsert: true, new: true }
        );
        results.push(plan);
      }
      res.json({ success: true, message: "Default plans initialized", plans: results });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Failed to seed plans", error: err.message });
    }
  }

  // ══════════════════════════════════════════════
  // WORKSPACE-SCOPED BILLING ENDPOINTS
  // (workspaceId is resolved from the JWT token — no :workspaceId path param)
  // ══════════════════════════════════════════════

  /**
   * GET /workspace/billing/info
   * Returns an aggregated billing snapshot: wallet, current plan, billing settings,
   * and the 20 most recent transactions. Used by the frontend billing dashboard.
   */
  static async getBillingInfo(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?._id?.toString() || req.workspace?.id;
      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'No workspace context in token' });
      }

      // Fetch wallet, workspace (with plan populated), and recent transactions in parallel
      const [wallet, workspace, activeSubscription, rawTxs] = await Promise.all([
        ledgerService.getWallet(workspaceId),
        WorkspaceModel.findById(workspaceId).populate('planId'),
        SubscriptionModel.findOne({
          workspaceId,
          status: { $in: ['trialing', 'active', 'past_due'] },
        })
          .sort({ updatedAt: -1 })
          .populate('planId'),
        WalletTransactionModel.find({ workspaceId })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
      ]);

      const workspacePlan = (workspace?.planId as any) || null;
      const subscriptionPlan = (activeSubscription?.planId as any) || null;
      const plan = resolveBillingPlan(workspacePlan, subscriptionPlan);

      // Attach invoice numbers to transactions
      const txIds = rawTxs.map((tx) => tx._id.toString());
      const invoices = await invoiceService.getInvoicesForTransactions(txIds);
      const invoiceMap = new Map(invoices.map((inv) => [inv.providerInvoiceId, inv.invoiceNumber]));

      // Convert paise → rupees for display. All amounts stored internally as paise (integer).
      const transactions = rawTxs.map((tx) => ({
        ...tx,
        _id: tx._id.toString(),
        amount: tx.amount / 100,          // paise → rupees
        previousBalance: tx.previousBalance / 100,
        newBalance: tx.newBalance / 100,
        invoiceNumber: invoiceMap.get(tx._id.toString()) || null,
      }));

      return res.json({
        success: true,
        wallet: {
          balance: wallet.availableBalance / 100,   // paise → rupees
          currency: wallet.currency || 'INR',
          status: workspace?.billingStatus || 'active',
          thresholdAmount: 0,
        },
        plan: {
          name: plan?.name || 'Free Tier',
          slug: plan?.slug || 'free',
          limits: (plan as any)?.limits || {},
          features: (plan as any)?.features || [],
          usage: {},
        },
        subscription: {
          autoPay: workspace?.autoPay ?? false,
          taxId: workspace?.taxId ?? '',
          billingPivotDate: activeSubscription?.currentPeriodEnd || null,
          status: activeSubscription?.status || workspace?.billingStatus || 'active',
        },
        payment: {
          enabled: config.razorpayEnabled,
          provider: config.razorpayEnabled ? 'razorpay' : null,
        },
        transactions,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /workspace/billing/plan
   * Switches the workspace to a new plan by slug.
   * Free plans activate instantly; paid plans return a Razorpay order.
   */
  static async switchPlan(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?._id?.toString() || req.workspace?.id;
      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'No workspace context in token' });
      }

      const { planSlug } = req.body;
      if (!planSlug) {
        return res.status(400).json({ success: false, message: 'planSlug is required' });
      }

      const plan = await PlanModel.findOne({ slug: planSlug });
      if (!plan) {
        return res.status(404).json({ success: false, message: `Plan "${planSlug}" not found` });
      }

      const amountPaise = plan.monthlyBaseFeeCents || 0;

      if (amountPaise === 0) {
        // Free plan — activate immediately without payment
        await WorkspaceModel.findByIdAndUpdate(workspaceId, {
          planId: plan._id,
          billingStatus: 'active',
        });
        return res.json({
          success: true,
          requiresPayment: false,
          message: 'Plan activated successfully',
          planSlug,
        });
      }

      // Paid plan — create a Razorpay order for the frontend to open checkout
      const order = await RazorpayService.createPlanOrder(amountPaise, workspaceId, planSlug);

      // Persist order locally for lookup at verify time
      await RazorpayOrderModel.create({
        orderId: order.id,
        workspaceId,
        amountPaise: Number(order.amount),
        currency: plan.currency || 'INR',
        type: 'PLAN_UPGRADE',
        planSlug,
      });

      return res.json({
        success: true,
        requiresPayment: true,
        orderId: order.id,
        amount: order.amount,
        currency: plan.currency || 'INR',
        keyId: config.razorpayKeyId,
        planName: plan.name,
        planSlug,
      });
    } catch (err: any) {
      return sendPaymentError(res, err);
    }
  }

  /**
   * PATCH /workspace/billing/settings
   * Persists autoPay and/or taxId for the workspace.
   */
  static async updateBillingSettings(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?._id?.toString() || req.workspace?.id;
      if (!workspaceId) {
        return res.status(400).json({ success: false, message: 'No workspace context in token' });
      }

      const { autoPay, taxId } = req.body;
      const update: Record<string, any> = {};
      if (autoPay !== undefined) update.autoPay = autoPay;
      if (taxId !== undefined) update.taxId = taxId;

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ success: false, message: 'Nothing to update' });
      }

      await WorkspaceModel.findByIdAndUpdate(workspaceId, { $set: update });
      return res.json({ success: true, message: 'Billing settings updated' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}
