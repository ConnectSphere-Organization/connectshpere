import mongoose, { Types } from 'mongoose';
import { CheckoutCart } from '../models/CheckoutCart.js';
import { Product } from '../models/Product.js';
import { Contact, Deal, Pipeline, Message } from '../models/index.js';

export class CheckoutBotService {
  /**
   * Process inbound message and advance checkout state
   */
  static async processMessage(
    workspaceId: string | Types.ObjectId,
    contactId: string | Types.ObjectId,
    conversationId: string | Types.ObjectId,
    text: string
  ): Promise<{ handled: boolean; state?: string } | null> {
    try {
      const lowerText = text.toLowerCase().trim();
      const wsId = workspaceId.toString();

      // 1. Fetch Commerce Configuration from businesses collection
      const db = mongoose.connection.db;
      const business = await db?.collection('businesses').findOne({
        workspace: new mongoose.Types.ObjectId(wsId)
      });
      const settings = business?.commerceSettings || {};
      if (!settings.checkoutBotEnabled) return null; // Commerce/Bot disabled

      // 2. Find or Initialize Cart
      let cart = await CheckoutCart.findOne({
        workspaceId: new mongoose.Types.ObjectId(wsId),
        contactId: new mongoose.Types.ObjectId(contactId.toString()),
        state: { $ne: 'order_completed' }
      });

      if (!cart) {
        if (!this.isCommerceIntent(lowerText, settings)) return null;
        cart = await this.init(workspaceId, contactId, conversationId);
      }

      const cartDoc = cart as any;
      if (!cartDoc) return null;

      if (cartDoc.isExpired) {
        await this.reply(cartDoc, "🕒 Your previous session expired. Let's start a fresh one!");
        cartDoc.state = 'welcome';
        await cartDoc.save();
      }

      // 3. State Machine
      switch (cartDoc.state) {
        case 'welcome':
        case 'product_selection':
          return await this.handleProductSelection(cartDoc, lowerText);
        case 'quantity_selection':
          return await this.handleQuantitySelection(cartDoc, lowerText, settings);
        case 'address_capture':
          return await this.handleAddressCapture(cartDoc, text);
        case 'payment_pending':
          return await this.handlePaymentConfirmation(cartDoc, lowerText, settings);
        default:
          return { handled: false };
      }
    } catch (err: any) {
      console.error("[CheckoutBot Exception]:", err.message);
      return { handled: false };
    }
  }

  private static isCommerceIntent(text: string, settings: any): boolean {
    const triggerKeyword = String(settings.checkoutBotTriggerKeyword || '').trim().toLowerCase();
    if (triggerKeyword && text === triggerKeyword) return true;
    return /(buy|shop|order|catalog|product|price|checkout|cart|purchase|available|menu)/i.test(text);
  }

  private static async init(workspaceId: any, contactId: any, conversationId: any) {
    return await CheckoutCart.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId.toString()),
      contactId: new mongoose.Types.ObjectId(contactId.toString()),
      conversationId: new mongoose.Types.ObjectId(conversationId.toString()),
      state: 'welcome',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
  }

  private static async handleProductSelection(cart: any, text: string) {
    const products = await Product.find({
      workspace: cart.workspaceId,
      isActive: true,
      isDeleted: false,
      stock: { $gt: 0 }
    }).limit(10).lean();

    if (!products.length) {
      await this.reply(cart, "🛍️ Our catalog is currently being updated. Please check back later!");
      return { handled: true };
    }

    // Check if user picked a number or name
    const choice = parseInt(text, 10);
    let selected = null;
    if (!isNaN(choice) && choice >= 1 && choice <= products.length) {
      selected = products[choice - 1];
    } else {
      selected = products.find(p => p.name.toLowerCase().includes(text));
    }

    if (selected) {
      cart.state = 'quantity_selection';
      cart.currentContext = {
        selectedProductId: selected._id as Types.ObjectId,
        selectedProductName: selected.name,
        selectedProductPrice: selected.price
      };
      await cart.save();
      await this.reply(cart, `📦 Choice: *${selected.name}*\nPrice: ₹${selected.price}\n\nHow many would you like to order? (Available: ${selected.stock})`);
      return { handled: true, state: cart.state };
    }

    // Show catalog if no valid selection
    const catalog = products.map((p, i) => `*${i + 1}*. ${p.name} - ₹${p.price}`).join('\n');
    const message = `👋 Welcome to our Store!\n\nHere are our available items:\n\n${catalog}\n\n*Reply with a number or name to select.*`;

    await this.reply(cart, message);
    cart.state = 'product_selection';
    await cart.save();
    return { handled: true, state: cart.state };
  }

  private static async handleQuantitySelection(cart: any, text: string, settings: any) {
    const match = text.match(/\d+/);
    const qty = parseInt(match ? match[0] : '', 10);
    if (isNaN(qty) || qty <= 0) {
      await this.reply(cart, "❌ Invalid quantity. Please reply with a number (e.g., 1, 2, 5).");
      return { handled: true };
    }

    const productId = cart.currentContext?.selectedProductId;
    const product = await Product.findById(productId);

    if (!product || product.stock < qty) {
      await this.reply(cart, `⚠️ Sorry, we only have ${product?.stock || 0} in stock. Please enter a lower quantity.`);
      return { handled: true };
    }

    cart.addItem(product, qty);

    // Apply Global Settings
    const shippingCost = settings.shipping?.enabled && settings.shipping?.flatRate?.enabled
      ? settings.shipping.flatRate.amount
      : 0;

    // Check for free shipping threshold
    const finalShipping = settings.shipping?.freeShippingAbove?.enabled && cart.subtotal >= settings.shipping.freeShippingAbove.amount
      ? 0
      : shippingCost;

    cart.calculateTotals(settings.taxPercentage || 0, finalShipping);
    cart.state = 'address_capture';
    await cart.save();

    const summary = `🛒 *Cart Updated*\nItems: ${qty} x ${product.name}\nSubtotal: ₹${cart.subtotal}\nTax: ₹${cart.tax}\nShipping: ₹${cart.shipping}\n*Total: ₹${cart.total}*\n\n📍 Please share your *Delivery Address*:\nFormat: *Name, Phone, Street, City, Pincode*`;

    await this.reply(cart, summary);
    return { handled: true, state: cart.state };
  }

  private static async handleAddressCapture(cart: any, text: string) {
    const parts = text.split(/,|\n/).map(p => p.trim()).filter(Boolean);

    if (parts.length < 4) {
      await this.reply(cart, "📝 *Address Required*\nWe need your details to deliver. Please reply in this format:\n\n*Name, Phone, Street, City, Pincode*");
      return { handled: true };
    }

    cart.address = {
      name: parts[0],
      phone: parts[1],
      street: parts[2],
      city: parts[3],
      pincode: parts[4] || '000000',
      country: 'India',
      isComplete: true
    };

    cart.state = 'payment_pending';
    await cart.save();

    await this.reply(cart, `✅ *Address Set*\n\nDest: ${cart.address.street}, ${cart.address.city}\n\nHow would you like to pay?\n1. *Cash on Delivery (COD)*\n2. *Online Payment*`);
    return { handled: true, state: cart.state };
  }

  private static async handlePaymentConfirmation(cart: any, text: string, settings: any) {
    if (text.includes('1') || text.toLowerCase().includes('cod')) {
      if (settings.paymentMethods?.cashOnDelivery?.enabled === false) {
        await this.reply(cart, "⚠️ COD is currently disabled for this store. Please select another method.");
        return { handled: true };
      }

      // Finalize Order (COD)
      const orderResult = await this.finalizeOrder(cart, 'cod');

      const instructions = settings.paymentMethods?.cashOnDelivery?.instructions || "Please keep exact change ready.";
      await this.reply(cart, `📦 *Order Confirmed!*\n\nOrder No: *${orderResult.orderNumber}*\nTotal: *₹${cart.total}*\n\nYour order has been placed successfully. We'll notify you when it's out for delivery.\n\n*Instructions:* ${instructions}`);
      return { handled: true, state: cart.state };
    }

    if (text.includes('2') || text.toLowerCase().includes('online')) {
      const activeGateways: string[] = [];
      if (settings.paymentMethods?.razorpay?.enabled !== false) activeGateways.push('Razorpay'); // Razorpay active default

      if (!activeGateways.length) {
        await this.reply(cart, "⚠️ Online payments are being set up. Please use COD for now.");
        return { handled: true };
      }

      // Finalize Order (Online - Pending)
      const orderResult = await this.finalizeOrder(cart, activeGateways[0].toLowerCase() as any);

      // Generate Payment Link by calling billing service via HTTP POST
      let paymentLink = null;
      try {
        const billingUrl = process.env.BILLING_SERVICE_URL || 'http://localhost:3003';
        const payRes = await fetch(`${billingUrl}/api/billing/commerce/${orderResult.id}/pay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
            'x-workspace-id': cart.workspaceId.toString(),
          }
        });
        if (payRes.ok) {
          const payData = await payRes.json() as any;
          paymentLink = payData.paymentLink;
        }
      } catch (err: any) {
        console.error('[CheckoutBot PaymentLink Error]:', err.message);
      }

      if (!paymentLink) {
        await this.reply(cart, "⚠️ We couldn't generate a secure payment link right now. No payment was taken. Please try again shortly or choose COD.");
        return { handled: true, state: cart.state };
      }

      await this.reply(cart, `🔗 *Payment Link Generated*\n\nPlease click the link below to pay ₹${cart.total} via ${activeGateways[0]}:\n\n${paymentLink}`);
      return { handled: true };
    }

    await this.reply(cart, "❓ Please choose *1* for COD or *2* for Online Payment.");
    return { handled: true };
  }

  private static async finalizeOrder(cart: any, paymentMethod: 'cod' | 'razorpay' | 'stripe') {
    const addr = cart.address;
    const address = {
      name: addr.name || 'Customer',
      phone: addr.phone || '',
      street: addr.street || '',
      city: addr.city || '',
      state: addr.state,
      pincode: addr.pincode || '',
      country: addr.country || 'India',
    };

    const items = cart.items.map((it: any) => ({
      productId: it.productId,
      productName: it.productName,
      price: it.price,
      quantity: it.quantity,
      subtotal: it.subtotal,
      ...(it.image ? { image: it.image } : {}),
    }));

    const wsId = cart.workspaceId.toString();

    const orderPayload = {
      contactId: cart.contactId,
      conversationId: cart.conversationId,
      checkoutCartId: cart._id,
      items,
      subtotal: cart.subtotal,
      tax: cart.tax,
      taxPercentage: cart.taxPercentage || 0,
      shippingCost: cart.shipping,
      discount: 0,
      total: cart.total,
      address,
      paymentMethod,
      paymentStatus: paymentMethod === 'cod' ? 'pending' : 'initiated',
      status: (paymentMethod === 'cod' ? 'confirmed' : 'pending') as 'confirmed' | 'pending',
      ...(paymentMethod === 'cod' ? { confirmedAt: new Date() } : {}),
      source: 'whatsapp_checkout_bot' as const,
    };

    // Forward to billing service via native fetch HTTP request
    const billingUrl = process.env.BILLING_SERVICE_URL || 'http://localhost:3003';
    const response = await fetch(`${billingUrl}/api/billing/commerce/wallets/${wsId}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-secret': process.env.INTERNAL_SERVICE_SECRET!,
        'x-workspace-id': wsId,
        'x-user-role': 'system' // Grant internal access
      },
      body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
      const errBody = await response.json() as any;
      throw new Error(errBody?.error || errBody?.message || 'Failed to create order in billing service');
    }

    const resJson = await response.json() as any;
    const order = resJson.data || resJson;

    if (!order?._id || !order?.orderNumber) {
      throw new Error('Billing service returned an invalid order payload');
    }

    // 3. Deduct Stock
    for (const item of cart.items) {
      if (item.productId) {
        await Product.findByIdAndUpdate(item.productId, {
          $inc: { stock: -item.quantity }
        });
      }
    }

    // 4. Create CRM Deal (Parity with Intrakt Sales Pipeline)
    try {
      const pipeline = await Pipeline.findOne({ workspace: cart.workspaceId, isDefault: true }) ||
        await Pipeline.findOne({ workspace: cart.workspaceId });

      if (pipeline && pipeline.stages.length > 0) {
        const firstStage = pipeline.stages[0].id;
        await Deal.create({
          workspace: cart.workspaceId,
          contact: cart.contactId,
          pipeline: pipeline._id,
          title: `WhatsApp Order: ${order.orderNumber}`,
          value: cart.total,
          stage: firstStage,
          status: 'active',
          priority: 'medium',
          source: 'whatsapp_checkout_bot',
          sourceId: order._id as Types.ObjectId,
          description: `Automatically created from WhatsApp Checkout Bot order ${order.orderNumber}. Address: ${address.city}`
        });
      }
    } catch (crmErr) {
      console.error("[CRM-Sync-Error]:", crmErr);
    }

    // 5. Update Cart State
    cart.state = 'order_completed';
    await cart.save();

    return { orderNumber: order.orderNumber, id: order._id };
  }

  private static async reply(cart: any, text: string) {
    const contact: any = await Contact.findById(cart.contactId).lean();
    if (!contact) return;

    // Send a message internally by calling the chat service controller sendMessageInternal directly or sending text
    try {
      // Call BSP service to send WhatsApp message via HTTP
      const db = mongoose.connection.db;
      const workspaceDoc = await db?.collection('workspaces').findOne({ _id: cart.workspaceId });
      const appId = workspaceDoc?.gupshupAppId;
      if (!appId || String(appId).startsWith('mock_')) {
        throw new Error('PROVIDER_NOT_CONFIGURED');
      }

      const bspUrl = process.env.BSP_SERVICE_URL || 'http://localhost:3004';
      const response = await fetch(`${bspUrl}/internal/v1/bsp/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET!,
          'x-internal-service': 'chat-service'
        },
        body: JSON.stringify({
          workspaceId: cart.workspaceId.toString(),
          appId,
          to: contact.phone,
          type: 'text',
          payload: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: contact.phone,
            type: 'text',
            text: { body: text }
          }
        })
      });
      if (!response.ok) {
        throw new Error(`BSP_MESSAGE_DISPATCH_FAILED:${response.status}`);
      }
      const payload = await response.json() as any;
      const providerMessageId = payload?.data?.providerMessageId || payload?.providerMessageId;
      if (!providerMessageId) {
        throw new Error('INVALID_PROVIDER_RESPONSE');
      }

      await Message.create({
        workspace: cart.workspaceId,
        conversation: cart.conversationId,
        direction: 'outbound',
        type: 'text',
        text,
        messageId: providerMessageId,
        status: 'sent',
      });
    } catch (err: any) {
      console.error('[CheckoutBot Outbound Reply Error]:', err.message);
    }
  }
}
