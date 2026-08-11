import mongoose, { Document, Schema, Model, Types } from 'mongoose';

export interface ICommerceSettings {
  workspaceId: Types.ObjectId;
  enabled: boolean;
  checkoutBotEnabled?: boolean;
  checkoutBotTriggerKeyword?: string;
  catalogEnabled?: boolean;
  currency: string;
  taxPercentage: number;
  paymentMethods: {
    cashOnDelivery: { enabled: boolean; instructions?: string };
    razorpay: { enabled: boolean; keyId?: string; keySecret?: string; webhookSecret?: string };
    stripe: { enabled: boolean; publicKey?: string; secretKey?: string; webhookSecret?: string };
    paypal: { enabled: boolean; clientId?: string; clientSecret?: string; mode?: 'sandbox' | 'live' };
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ICommerceSettingsDocument extends ICommerceSettings, Document {}

const CommerceSettingsSchema = new Schema<ICommerceSettingsDocument>({
  workspaceId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  checkoutBotEnabled: { type: Boolean, default: false },
  checkoutBotTriggerKeyword: { type: String, default: 'SHOP' },
  catalogEnabled: { type: Boolean, default: false },
  currency: { type: String, default: 'INR' },
  taxPercentage: { type: Number, default: 0 },
  paymentMethods: {
    cashOnDelivery: { enabled: { type: Boolean, default: true }, instructions: { type: String } },
    razorpay: { enabled: { type: Boolean, default: false }, keyId: { type: String }, keySecret: { type: String }, webhookSecret: { type: String } },
    stripe: { enabled: { type: Boolean, default: false }, publicKey: { type: String }, secretKey: { type: String }, webhookSecret: { type: String } },
    paypal: { enabled: { type: Boolean, default: false }, clientId: { type: String }, clientSecret: { type: String }, mode: { type: String, enum: ['sandbox', 'live'], default: 'sandbox' } }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

CommerceSettingsSchema.pre<ICommerceSettingsDocument>('save', function() {
  this.updatedAt = new Date();
});

export const CommerceSettingsModel = mongoose.model<ICommerceSettingsDocument>('CommerceSettings', CommerceSettingsSchema);
