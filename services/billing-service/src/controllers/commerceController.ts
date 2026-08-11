import mongoose from 'mongoose';
import { Response } from 'express';
import { CommercePaymentService } from '../services/CommercePaymentService';
import { OrderModel } from '../models/Order';
import { AuthRequest } from '../middleware/auth';
import { ProductModel } from '../models/Product';
import { CommerceSettingsModel } from '../models/CommerceSettings';
import { encryptCommerceSecret } from '../services/commerce-secret-box';

const SENSITIVE_COMMERCE_FIELDS = new Set([
  'keySecret', 'secretKey', 'webhookSecret', 'clientSecret', 'apiKey',
]);

function copyAndTransformSecrets(value: any, transform: (secret: string) => string | undefined): any {
  if (Array.isArray(value)) return value.map((item) => copyAndTransformSecrets(item, transform));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (SENSITIVE_COMMERCE_FIELDS.has(key)) {
      if (typeof child !== 'string' || !child) return [];
      const transformed = transform(child);
      return transformed ? [[key, transformed]] : [];
    }
    return [[key, copyAndTransformSecrets(child, transform)]];
  }));
}

/** Keeps private credentials out of every customer-facing settings response. */
export function redactCommerceSettings(settings: Record<string, any>) {
  return copyAndTransformSecrets(settings, () => undefined);
}

function mergeCommerceSettings(previous: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
  const merged = { ...previous, ...incoming };
  const previousMethods = previous.paymentMethods || {};
  const incomingMethods = incoming.paymentMethods || {};
  merged.paymentMethods = { ...previousMethods, ...incomingMethods };

  for (const provider of Object.keys(merged.paymentMethods)) {
    const oldProvider = previousMethods[provider] || {};
    const newProvider = incomingMethods[provider] || {};
    const nextProvider = { ...oldProvider, ...newProvider };
    for (const field of SENSITIVE_COMMERCE_FIELDS) {
      if (newProvider[field] === '' || newProvider[field] === undefined || newProvider[field] === null) {
        if (oldProvider[field]) nextProvider[field] = oldProvider[field];
      }
    }
    merged.paymentMethods[provider] = nextProvider;
  }
  return merged;
}

function encryptCommerceSettings(settings: Record<string, any>) {
  return copyAndTransformSecrets(settings, (secret) => encryptCommerceSecret(secret));
}

function withoutPersistenceMetadata(settings: Record<string, any>): Record<string, any> {
  const { _id, __v, workspaceId, createdAt, updatedAt, ...values } = settings;
  return values;
}

export const commerceController = {
  /**
   * Initialize payment for an order
   */
  async initializePayment(req: AuthRequest, res: Response) {
    try {
      const { orderId } = req.params;
      const workspaceId = req.headers['x-workspace-id'] as string;

      if (!orderId || !workspaceId) {
        return res.status(400).json({ error: 'Order ID and Workspace ID are required' });
      }

      const paymentLink = await CommercePaymentService.generateRazorpayLink(workspaceId, orderId as any);

      if (!paymentLink) {
        return res.status(400).json({ error: 'Failed to generate payment link' });
      }

      res.json({ success: true, paymentLink });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Fetch a single order (management / internal / logistics)
   */
  async getOrderById(req: AuthRequest, res: Response) {
    try {
      const { orderId } = req.params;
      const workspaceId = req.headers['x-workspace-id'] as string;

      if (!orderId || !workspaceId) {
        return res.status(400).json({ error: 'Order ID and x-workspace-id are required' });
      }

      const order = await OrderModel.findOne({
        _id: orderId,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      }).lean();
      if (!order) return res.status(404).json({ error: 'Order not found' });

      res.json({ success: true, data: order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Get order status
   */
  async getOrderStatus(req: AuthRequest, res: Response) {
    try {
      const { orderId } = req.params;
      const workspaceId = req.headers['x-workspace-id'] as string;

      const order = await OrderModel.findOne({ _id: orderId, workspaceId });
      if (!order) return res.status(404).json({ error: 'Order not found' });

      res.json({ success: true, order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * List orders for a workspace
   */
  async listOrders(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page = '1', limit = '10', status, search } = req.query;

      const query: any = { workspaceId: new mongoose.Types.ObjectId(workspaceId) };
      if (status && status !== 'all') query.status = status;
      if (search) {
        query.$or = [
          { orderNumber: { $regex: search, $options: 'i' } },
          { 'address.name': { $regex: search, $options: 'i' } },
          { 'address.phone': { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);
      const [orders, total] = await Promise.all([
        OrderModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        OrderModel.countDocuments(query)
      ]);

      res.json({
        success: true,
        data: orders,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit))
        }
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Create a new order
   */
  async createOrder(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.params.workspaceId as string;
      const isInternal = req.role === 'system';
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      const orderNumber =
        isInternal &&
        typeof (body as { orderNumber?: string }).orderNumber === 'string' &&
        (body as { orderNumber: string }).orderNumber.length > 0
          ? (body as { orderNumber: string }).orderNumber
          : OrderModel.generateOrderNumber(workspaceId);

      const orderData: Record<string, unknown> = {
        ...body,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        orderNumber,
      };

      if (isInternal && (body as { _id?: string })._id) {
        orderData._id = new mongoose.Types.ObjectId((body as { _id: string })._id);
      }

      const order = new OrderModel(orderData);
      await order.save();
      res.status(201).json({ success: true, data: order });
    } catch (error: any) {
      if (error?.code === 11000) {
        return res.status(409).json({ error: 'Duplicate order', message: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * Update an order
   */
  async updateOrder(req: AuthRequest, res: Response) {
    try {
      const { orderId } = req.params;
      const workspaceId = req.headers['x-workspace-id'] as string;

      const order = await OrderModel.findOne({ _id: orderId, workspaceId });
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Apply updates from body
      if (req.body.status) {
        try {
          order.updateStatus(req.body.status);
        } catch (e: any) {
          return res.status(400).json({ error: e.message });
        }
      }

      if (req.body.trackingNumber) order.trackingNumber = req.body.trackingNumber;
      if (req.body.adminNotes) order.adminNotes = req.body.adminNotes;
      if (req.body.paymentStatus) order.paymentStatus = req.body.paymentStatus;

      await order.save();
      res.json({ success: true, data: order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  /**
   * List Catalogs (Stub for FB/Gupshup commerce)
   */
  async listCatalogs(req: AuthRequest, res: Response) {
    try {
      res.json({ 
        success: true, 
        data: [
          { _id: 'default', name: 'Default Catalog', isDefault: true }
        ]
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * List Products
   */
  async listProducts(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const page = parseInt(req.query.page as string || '1', 10);
      const limit = parseInt(req.query.limit as string || '50', 10);
      const category = req.query.category as string;
      const search = req.query.search as string;
      const getStats = req.query.stats === 'true';

      if (getStats) {
        const stats = await ProductModel.aggregate([
          { $match: { workspace: new mongoose.Types.ObjectId(String(workspaceId)), isDeleted: false } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: ['$isActive', 1, 0] } },
              lowStock: { $sum: { $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', 10] }] }, 1, 0] } },
              outOfStock: { $sum: { $cond: [{ $eq: ['$stock', 0] }, 1, 0] } }
            }
          }
        ]);
        return res.json({ success: true, data: stats[0] || { total: 0, active: 0, lowStock: 0, outOfStock: 0 } });
      }

      const query: any = { 
        workspace: new mongoose.Types.ObjectId(String(workspaceId)), 
        isDeleted: false 
      };

      if (category) query.category = category;
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }

      const [products, total] = await Promise.all([
        ProductModel.find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        ProductModel.countDocuments(query)
      ]);
      
      res.json({ 
        success: true, 
        data: products,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Create Product
   */
  async createProduct(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      const userId = req.headers['x-user-id'] || req.user?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const product = await ProductModel.create({
        ...req.body,
        workspace: new mongoose.Types.ObjectId(String(workspaceId)),
        createdBy: userId ? new mongoose.Types.ObjectId(String(userId)) : undefined
      });
      res.status(201).json({ success: true, data: product });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Update Product
   */
  async updateProduct(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      const userId = req.headers['x-user-id'] || req.user?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const product = await ProductModel.findOneAndUpdate(
        { _id: req.params.id, workspace: new mongoose.Types.ObjectId(String(workspaceId)), isDeleted: false },
        { 
          $set: { 
            ...req.body, 
            updatedBy: userId ? new mongoose.Types.ObjectId(String(userId)) : undefined 
          } 
        },
        { new: true, runValidators: true }
      );

      if (!product) return res.status(404).json({ success: false, message: "Product not found" });
      res.json({ success: true, data: product });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Delete Product
   */
  async deleteProduct(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      const userId = req.headers['x-user-id'] || req.user?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const product = await ProductModel.findOneAndUpdate(
        { _id: req.params.id, workspace: new mongoose.Types.ObjectId(String(workspaceId)), isDeleted: false },
        { 
          $set: { 
            isDeleted: true, 
            isActive: false, 
            deletedAt: new Date(), 
            updatedBy: userId ? new mongoose.Types.ObjectId(String(userId)) : undefined 
          } 
        },
        { new: true }
      );

      if (!product) return res.status(404).json({ success: false, message: "Product not found" });
      res.json({ success: true, message: "Product deleted", data: product });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Get Commerce Stats
   */
  async getStats(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const [productStats, orderStats] = await Promise.all([
        ProductModel.aggregate([
          { $match: { workspace: new mongoose.Types.ObjectId(String(workspaceId)), isDeleted: false } },
          {
            $group: {
              _id: null,
              totalProducts: { $sum: 1 },
              activeProducts: { $sum: { $cond: ['$isActive', 1, 0] } },
              lowStock: { $sum: { $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', 10] }] }, 1, 0] } },
              outOfStock: { $sum: { $cond: [{ $eq: ['$stock', 0] }, 1, 0] } }
            }
          }
        ]),
        OrderModel.aggregate([
          { $match: { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) } },
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'PAID'] }, '$totalAmount', 0] } },
              pendingOrders: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } }
            }
          }
        ])
      ]);

      res.json({
        success: true,
        data: {
          totalProducts: productStats[0]?.totalProducts || 0,
          activeProducts: productStats[0]?.activeProducts || 0,
          lowStock: productStats[0]?.lowStock || 0,
          outOfStock: productStats[0]?.outOfStock || 0,
          totalOrders: orderStats[0]?.totalOrders || 0,
          revenue: orderStats[0]?.revenue || 0,
          pendingOrders: orderStats[0]?.pendingOrders || 0
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Get Settings
   */
  async getSettings(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const db = mongoose.connection.db;
      if (!db) {
        return res.status(500).json({ error: 'Database connection not initialized' });
      }

      const business = await db.collection('businesses').findOne({
        workspace: new mongoose.Types.ObjectId(String(workspaceId))
      });

      const persistedSettings = await CommerceSettingsModel.findOne({ workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) }).lean();
      const cs = (persistedSettings || business?.commerceSettings || {}) as Record<string, any>;
      const safeSettings = redactCommerceSettings(cs);

      res.json({
        success: true,
        data: {
          ...safeSettings,
          currency: safeSettings.currency || 'INR',
          checkoutBotEnabled: !!safeSettings.checkoutBotEnabled,
          razorpayEnabled: Boolean(safeSettings.paymentMethods?.razorpay?.enabled && safeSettings.paymentMethods?.razorpay?.keyId),
          catalogEnabled: !!safeSettings.catalogEnabled,
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * Update Settings
   */
  async updateSettings(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;
      const userId = req.headers['x-user-id'] || req.user?._id;
      if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace context is required' });
      }

      const db = mongoose.connection.db;
      if (!db) {
        return res.status(500).json({ error: 'Database connection not initialized' });
      }

      const query = { workspace: new mongoose.Types.ObjectId(String(workspaceId)) };
      const business = await db.collection('businesses').findOne(query);

      const persistedSettings = await CommerceSettingsModel.findOne({ workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) }).lean();
      const prev = withoutPersistenceMetadata((persistedSettings || business?.commerceSettings || {}) as Record<string, any>);
      const incoming = req.body || {};
      const newSettings = mergeCommerceSettings(prev, incoming);
      const encryptedSettings = encryptCommerceSettings(newSettings);

      const updateData: any = {
        $set: {
          commerceSettings: encryptedSettings
        }
      };

      if (incoming.razorpayKeyId !== undefined) {
        updateData.$set.razorpayKeyId = incoming.razorpayKeyId;
      }

      if (business) {
        await db.collection('businesses').updateOne(query, updateData);
      } else {
        await db.collection('businesses').insertOne({
          workspace: new mongoose.Types.ObjectId(String(workspaceId)),
          owner: userId ? new mongoose.Types.ObjectId(String(userId)) : undefined,
          name: 'Business',
          address: {},
          commerceSettings: encryptedSettings,
          razorpayKeyId: incoming.razorpayKeyId
        });
      }

      await CommerceSettingsModel.findOneAndUpdate(
        { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) },
        { $set: { ...encryptedSettings, workspaceId: new mongoose.Types.ObjectId(String(workspaceId)), updatedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      const safeSettings = redactCommerceSettings(encryptedSettings);

      res.json({
        success: true,
        data: {
          ...safeSettings,
          currency: safeSettings.currency || 'INR',
          checkoutBotEnabled: !!safeSettings.checkoutBotEnabled,
          razorpayEnabled: Boolean(safeSettings.paymentMethods?.razorpay?.enabled && safeSettings.paymentMethods?.razorpay?.keyId),
          catalogEnabled: !!safeSettings.catalogEnabled,
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async getCheckoutBotStats(req: AuthRequest, res: Response) {
    try {
      const stats = {
        ordersClosed: 0,
        totalRevenue: '₹0',
        abandonmentRate: '0%',
        activeSessions: 0,
        subtext: { 
          orders: 'No data', 
          revenue: 'No data',
          abandonment: 'No data',
          sessions: 'No active sessions'
        }
      };
      res.json({ success: true, data: stats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async updateOrderStatus(req: AuthRequest, res: Response) {
    try {
      const orderId = req.params.orderId || req.body.orderId || req.body.id;
      const { status } = req.body;
      const workspaceId = req.headers['x-workspace-id'] || req.workspace?._id;

      if (!orderId || !workspaceId) {
        return res.status(400).json({ error: 'Order ID and Workspace ID are required' });
      }

      const order = await OrderModel.findOneAndUpdate(
        { _id: orderId, workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) },
        { $set: { status } },
        { new: true }
      );

      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json({ success: true, data: order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
};
