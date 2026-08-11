import Razorpay from 'razorpay';
import { OrderModel } from '../models/Order';
import { CommerceSettingsModel } from '../models/CommerceSettings';
import { Types } from 'mongoose';
import { decryptCommerceSecret } from './commerce-secret-box';

export class CommercePaymentService {
  /**
   * Generate a Razorpay Payment Link for an order
   */
  static async generateRazorpayLink(workspaceId: string | Types.ObjectId, orderId: string | Types.ObjectId): Promise<string | null> {
    try {
      const settings = await CommerceSettingsModel.findOne({ workspaceId }).lean();
      const order = await OrderModel.findById(orderId);

      if (!order || !settings?.paymentMethods?.razorpay?.enabled) {
        console.warn(`[CommercePaymentService] Skipping Razorpay: Order found? ${!!order}, Razorpay enabled? ${!!settings?.paymentMethods?.razorpay?.enabled}`);
        return null;
      }

      const { keyId } = settings.paymentMethods.razorpay;
      const keySecret = decryptCommerceSecret(settings.paymentMethods.razorpay.keySecret);
      if (!keyId || !keySecret) {
        console.warn(`[CommercePaymentService] Razorpay keys missing for workspace ${workspaceId}`);
        return null;
      }

      const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
      });

      // Create Payment Link
      const amountInPaise = Math.round(order.total * 100);

      const link = await razorpay.paymentLink.create({
        amount: amountInPaise,
        currency: (order as any).currency || 'INR',
        accept_partial: false,
        description: `Order ${(order as any).orderNumber}`,
        customer: {
          name: (order as any).address?.name || 'Customer',
          email: 'customer@example.com', // In a real app, you'd get this from the contact/order
          contact: (order as any).address?.phone
        },
        notify: {
          whatsapp: true
        },
        reminder_enable: true,
        notes: {
          order_id: order._id.toString(),
          workspace_id: workspaceId.toString(),
          type: 'commerce_order'
        },
        // Callback is served through the API gateway for frontend/provider compatibility.
        callback_url: `${process.env.API_GATEWAY_URL || process.env.PUBLIC_API_URL || 'http://localhost:3000'}/api/payments/callback`,
        callback_method: 'get'
      });

      order.paymentId = link.id;
      order.paymentStatus = 'initiated';
      order.status = 'payment_initiated';
      await order.save();

      return link.short_url;
    } catch (err: any) {
      console.error("[CommercePaymentService Error]:", err.message);
      return null;
    }
  }
}
