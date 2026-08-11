import "server-only";
import { Types } from "mongoose";
import { coreModels } from "./models";
import { getConnection, type DbName } from "./db";

/**
 * Self-contained config/plan/settings writes — direct Mongo, no gateway.
 * These are plain document writes in core-server with no BullMQ side-effects.
 */

/* ── System settings (singleton) ──────────────────────────────────────── */

export async function updateSystemSettings(patch: Record<string, unknown>) {
  const { SystemSettings } = await coreModels();
  const allowed = ["maintenanceMode", "maintenanceMessage", "allowNewSignups", "systemNotice"];
  const set: Record<string, unknown> = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];

  // Merge `features` per-key (dot notation) so writing one flag (compliance
  // overrides, emergency-lockdown, a broadcast) never clobbers the others
  // (aiEnabled, billingEnforced, …) the live platform relies on.
  if (patch.features && typeof patch.features === "object") {
    for (const [k, v] of Object.entries(patch.features as Record<string, unknown>)) {
      set[`features.${k}`] = v;
    }
  }

  const doc = await SystemSettings.findOneAndUpdate({}, { $set: set }, { new: true, upsert: true }).lean();
  return doc;
}

export async function updateServiceControl(serviceId: string, patch: Record<string, unknown>) {
  const { SystemSettings } = await coreModels();
  const allowed = ["published", "customerVisible", "maintenance", "message"];
  const set: Record<string, unknown> = {};

  for (const key of allowed) {
    if (key in patch) {
      set[`features.serviceControls.${serviceId}.${key}`] = patch[key];
    }
  }

  set[`features.serviceControls.${serviceId}.updatedAt`] = new Date();

  const doc = await SystemSettings.findOneAndUpdate({}, { $set: set }, { new: true, upsert: true }).lean();
  return doc;
}

/* ── Plans CRUD ───────────────────────────────────────────────────────── */

/**
 * The core database retains plan ids used by existing workspace documents,
 * while billing-service serves its catalogue from the billing database. Keep
 * the plan document in both places until workspace plan references are fully
 * owned by billing.
 */
async function billingPlansCollection() {
  const conn = await getConnection("billing");
  if (!conn.db) throw new Error("billing DB unavailable");
  return conn.db.collection("plans");
}

function planDocument(plan: Record<string, unknown>): Record<string, any> {
  const document = { ...plan };
  delete document.__v;
  return document;
}

export async function syncPlanCatalogToBilling() {
  const { Plan } = await coreModels();
  const [corePlans, billingPlans] = await Promise.all([
    Plan.find({}).lean(),
    billingPlansCollection(),
  ]);

  if (!corePlans.length) return { synchronized: 0 };

  const now = new Date();
  await billingPlans.bulkWrite(
    corePlans.map((plan) => {
      const document = planDocument(plan as unknown as Record<string, unknown>);
      return {
        updateOne: {
          filter: { _id: document._id },
          update: { $set: { ...document, updatedAt: now } },
          upsert: true,
        },
      };
    }),
  );

  return { synchronized: corePlans.length };
}

export async function createPlan(data: Record<string, unknown>) {
  const { Plan } = await coreModels();
  const plan = await Plan.create(data);
  const document = planDocument(plan.toObject() as unknown as Record<string, unknown>);
  const billingPlans = await billingPlansCollection();
  await billingPlans.updateOne(
    { _id: document._id },
    { $set: document },
    { upsert: true },
  );
  return document;
}

export async function updatePlan(planId: string, data: Record<string, unknown>) {
  const { Plan } = await coreModels();
  const clean = { ...data };
  delete clean.planId;
  delete clean._id;
  const plan = await Plan.findByIdAndUpdate(planId, { $set: clean }, { new: true }).lean();
  if (!plan) throw new Error("Plan not found");
  const document = planDocument(plan as unknown as Record<string, unknown>);
  const billingPlans = await billingPlansCollection();
  await billingPlans.updateOne(
    { _id: document._id },
    { $set: document },
    { upsert: true },
  );
  return document;
}

export async function deletePlan(planId: string) {
  const { Plan } = await coreModels();
  const res = await Plan.findByIdAndDelete(planId).lean();
  if (!res) throw new Error("Plan not found");
  const billingPlans = await billingPlansCollection();
  await billingPlans.deleteOne({ _id: res._id });
}

export async function seedDefaultPlans() {
  const conn = await getConnection("billing");
  const db = conn.db;
  if (!db) throw new Error("billing DB unavailable");
  const plans = db.collection("plans");
  const defaults = [
    { name: "Free Tier", slug: "free", monthlyBaseFeeCents: 0, yearlyBaseFeeCents: 0, currency: "INR", isActive: true, isDefault: true },
    { name: "Growth", slug: "growth", monthlyBaseFeeCents: 499900, yearlyBaseFeeCents: 4999000, currency: "INR", isActive: true, isDefault: false },
    { name: "Enterprise", slug: "enterprise", monthlyBaseFeeCents: 1499900, yearlyBaseFeeCents: 14999000, currency: "INR", isActive: true, isDefault: false },
  ];
  const now = new Date();
  const items = [];
  for (const plan of defaults) {
    items.push(await plans.findOneAndUpdate(
      { slug: plan.slug },
      { $set: { ...plan, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    ));
  }
  return { initialized: items.length, plans: items };
}

export async function reconcileBilling() {
  const conn = await getConnection("billing");
  const db = conn.db;
  if (!db) throw new Error("billing DB unavailable");
  const [wallets, subscriptions, invoices, pendingTransactions] = await Promise.all([
    db.collection("wallets").estimatedDocumentCount(),
    db.collection("subscriptions").estimatedDocumentCount(),
    db.collection("invoices").estimatedDocumentCount(),
    db.collection("wallettransactions").countDocuments({ status: { $in: ["pending", "processing"] } }),
  ]);
  return { reconciled: true, wallets, subscriptions, invoices, pendingTransactions, checkedAt: new Date() };
}

/* ── User invite ──────────────────────────────────────────────────────── */

export async function inviteUser(input: { email: string; name?: string; role?: string }) {
  if (!input.email) throw new Error("email is required");
  const { User } = await coreModels();

  const existing = await User.findOne({ email: input.email.toLowerCase().trim() }).lean();
  if (existing) throw new Error("A user with that email already exists");

  const invitationToken = randomToken();
  const user = await User.create({
    email: input.email.toLowerCase().trim(),
    name: input.name || input.email.split("@")[0],
    role: input.role || "member",
    status: "invited",
    invitedAt: new Date(),
    invitationToken,
  });
  return { id: String((user as { _id: unknown })._id), invitationToken };
}

/* ── Gupshup webhook policy upsert ────────────────────────────────────── */

export async function saveWebhookPolicy(input: Record<string, unknown>) {
  const { WebhookPolicy } = await coreModels();
  const { id, ...data } = input;
  if (id) {
    const updated = await WebhookPolicy.findByIdAndUpdate(String(id), data, { new: true }).lean();
    if (!updated) throw new Error("Webhook policy not found");
    return updated;
  }
  const created = await WebhookPolicy.create(data);
  return created.toObject();
}

/* ── Data explorer single-document update ─────────────────────────────── */

export async function updateDocument(database: DbName, collection: string, id: string, update: Record<string, unknown>) {
  const conn = await getConnection(database);
  const db = conn.db;
  if (!db) throw new Error(`${database} DB unavailable`);

  // Guard against dangerous operators in the update payload.
  const json = JSON.stringify(update);
  if (/\$where|\$function|\$accumulator|\$expr/.test(json)) {
    throw new Error("Update contains prohibited operators");
  }

  let _id: Types.ObjectId | string = id;
  try {
    _id = new Types.ObjectId(id);
  } catch {
    /* leave as string if not a valid ObjectId */
  }

  const res = await db.collection(collection).updateOne({ _id } as Record<string, unknown>, { $set: update });
  return { matched: res.matchedCount, modified: res.modifiedCount };
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  (globalThis.crypto || require("crypto").webcrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
