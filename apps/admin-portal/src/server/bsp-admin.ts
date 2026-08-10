import "server-only";
import axios, { type AxiosInstance } from "axios";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { config } from "@/config/env";
import { getConnection } from "@/server/db";
import { buildGupshupWebhookUrl } from "@/server/gupshup-webhook-url";

const DEFAULT_EVENTS = [
  "MESSAGE", "SENT", "DELIVERED", "READ", "FAILED", "TEMPLATE",
  "ACCOUNT", "BILLING", "PAYMENTS", "FLOWS_MESSAGE",
];

let cachedPartnerToken = "";
let cachedPartnerTokenUntil = 0;
const cachedAppTokens = new Map<string, { token: string; expiresAt: number }>();

function providerClient(): AxiosInstance {
  return axios.create({
    baseURL: config.gupshup.partnerBaseUrl,
    timeout: 25_000,
    headers: { Accept: "application/json" },
  });
}

async function partnerToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedPartnerToken && cachedPartnerTokenUntil > Date.now()) {
    return cachedPartnerToken;
  }

  if (config.gupshup.partnerToken && !forceRefresh) {
    return normalizeToken(config.gupshup.partnerToken);
  }

  if (!config.gupshup.partnerEmail || !config.gupshup.partnerSecret) {
    throw new Error("Gupshup partner credentials are not configured in admin-portal");
  }

  const form = new URLSearchParams({
    email: config.gupshup.partnerEmail,
    secret: config.gupshup.partnerSecret,
  });
  const response = await providerClient().post("/partner/account/login", form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });
  const candidate = response.data?.token || response.data?.accessToken || response.data?.jwt;
  const token = normalizeToken(candidate);
  if (!token) throw new Error(response.data?.message || "Gupshup login returned no token");

  cachedPartnerToken = token;
  cachedPartnerTokenUntil = Date.now() + 30_000;
  return token;
}

async function withPartnerAuth<T>(operation: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await partnerToken(attempt === 1);
    try {
      // Partner API documentation specifies the token itself in Authorization;
      // it does not use the Bearer scheme.
      return await operation({ Authorization: token, Accept: "application/json" });
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (attempt === 0 && (status === 401 || status === 403)) continue;
      throw providerError(error);
    }
  }
  throw new Error("Gupshup authorization failed");
}

/**
 * Subscription endpoints are authorized at the app level. A Partner token can
 * obtain the app token, but is not itself accepted for every subscription
 * operation (Gupshup returns 403 in that case).
 */
async function resolveAppToken(appId: string, forceRefresh = false): Promise<string> {
  const cached = cachedAppTokens.get(appId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const partner = normalizeToken(await partnerToken(forceRefresh));
  const headerVariants: Array<Record<string, string>> = [
    { Authorization: partner, token: partner, Accept: "application/json" },
    { Authorization: `Bearer ${partner}`, token: partner, Accept: "application/json" },
    { token: partner, Accept: "application/json" },
  ];

  let lastError: unknown;
  for (const headers of headerVariants) {
    try {
      const response = await providerClient().get(
        `/partner/app/${encodeURIComponent(appId)}/token`,
        { headers },
      );
      const candidate =
        response.data?.token?.token ||
        response.data?.data?.token?.token ||
        response.data?.result?.token?.token ||
        response.data?.token ||
        response.data?.accessToken;
      const token = normalizeToken(candidate);
      if (!token) throw new Error(response.data?.message || "Gupshup app token was not returned");

      cachedAppTokens.set(appId, { token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 });
      return token;
    } catch (error) {
      lastError = error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status !== 401 && status !== 403) throw providerError(error);
    }
  }

  throw providerError(lastError);
}

async function withAppAuth<T>(appId: string, operation: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const forceRefresh of [false, true]) {
    const token = await resolveAppToken(appId, forceRefresh);
    const headerVariants: Array<Record<string, string>> = [
      { Authorization: token, Accept: "application/json" },
      { token, Accept: "application/json" },
      { Authorization: `Bearer ${token}`, token, Accept: "application/json" },
    ];

    for (const headers of headerVariants) {
      try {
        return await operation(headers);
      } catch (error) {
        lastError = error;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== 401 && status !== 403) throw providerError(error);
      }
    }
  }

  throw providerError(lastError);
}

export async function listBspApps(workspaceId?: string) {
  const db = await bspDb();
  return db.collection("bsp_apps")
    .find(workspaceId ? { workspaceId } : {})
    .project({ whatsappAccessToken: 0, whatsappVerifyToken: 0, accessToken: 0, "gupshupIdentity.appApiKey": 0 })
    .sort({ updatedAt: -1 })
    .limit(200)
    .toArray();
}

/**
 * Partner-account inventory. This deliberately reads from Gupshup rather than
 * our local mapping collection so super admins can see unassigned apps too.
 */
export async function listPartnerApps(): Promise<Record<string, unknown>[]> {
  return withPartnerAuth(async (headers) => {
    const response = await providerClient().get("/partner/account/api/partnerApps", { headers });
    const payload = response.data;
    // The current Partner API returns `partnerAppsList`; retain the older
    // aliases because Gupshup has used those shapes in prior API revisions.
    const apps = payload?.partnerAppsList || payload?.partnerApps || payload?.apps || payload?.data || payload;
    if (!Array.isArray(apps)) throw new Error("Gupshup returned an invalid partner app inventory");
    return apps;
  });
}

/** Link an existing Gupshup app to this partner account. The API key is never persisted. */
export async function linkPartnerApp(input: { apiKey: unknown; appName: unknown }) {
  const apiKey = normalizeId(input.apiKey);
  const appName = normalizeId(input.appName);
  if (!apiKey || !appName) throw new Error("apiKey and appName are required");

  return withPartnerAuth(async (headers) => {
    const form = new URLSearchParams({ apiKey, appName });
    const response = await providerClient().post("/partner/account/api/appLink", form.toString(), {
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.data;
  });
}

/**
 * Gupshup exposes deletion only for sandbox apps. Re-fetching the provider
 * inventory before the destructive call prevents a stale UI from deleting a
 * live application if its mode changes after the page was loaded.
 */
export async function deleteSandboxPartnerApp(appIdValue: unknown, commentValue: unknown) {
  const appId = normalizeId(appIdValue);
  const comment = normalizeId(commentValue) || "Deleted from ConnectSphere super admin";
  if (!appId) throw new Error("appId is required");

  const apps = await listPartnerApps();
  const app = apps.find((candidate) => providerAppId(candidate) === appId);
  if (!app) throw new Error("Gupshup app was not found in this partner account");
  if (!isSandboxPartnerApp(app)) {
    throw new Error("Only Gupshup sandbox apps can be deleted from this console");
  }

  return withPartnerAuth(async (headers) => {
    const response = await providerClient().delete(`/partner/app/${encodeURIComponent(appId)}`, {
      headers,
      params: { comment },
    });
    return response.data;
  });
}

export async function reconcileBspApps(workspaceId?: string) {
  const apps = await listBspApps(workspaceId);
  const result = { total: apps.length, processed: 0, failed: 0, skipped: 0, details: [] as Record<string, unknown>[] };

  for (const app of apps) {
    const appId = providerAppId(app);
    if (isPlaceholderAppId(appId)) {
      result.skipped += 1;
      result.details.push({ workspaceId: app.workspaceId, appId, status: "skipped" });
      continue;
    }
    try {
      const subscriptions = await listProviderSubscriptions(appId);
      result.processed += 1;
      result.details.push({ workspaceId: app.workspaceId, appId, status: "reconciled", subscriptions: subscriptions.length });
    } catch (error) {
      result.failed += 1;
      result.details.push({ workspaceId: app.workspaceId, appId, status: "failed", error: errorMessage(error) });
    }
  }
  return result;
}

export async function syncAppSubscriptions(appId: string, workspaceId?: string) {
  const db = await bspDb();
  const app = await db.collection("bsp_apps").findOne({
    $or: [{ appId }, { gupshupAppId: appId }, { "gupshupIdentity.partnerAppId": appId }],
  });
  const resolvedWorkspaceId = String(app?.workspaceId || workspaceId || "");
  if (!resolvedWorkspaceId) throw new Error(`No workspace mapping found for Gupshup app ${appId}`);

  const providerId = app ? providerAppId(app) : appId;
  const subscriptions = await listProviderSubscriptions(providerId);
  const syncedAt = new Date();
  const returnedUrls = new Set<string>();

  for (const subscription of subscriptions) {
    const callbackUrl = subscriptionUrl(subscription);
    if (!callbackUrl) continue;
    returnedUrls.add(callbackUrl);
    await db.collection("bsp_subscriptions").updateOne(
      { workspaceId: resolvedWorkspaceId, provider: "gupshup", appId: providerId, callbackUrl },
      { $set: subscriptionDocument(subscription, resolvedWorkspaceId, providerId, callbackUrl, syncedAt, "admin_subscription_sync") },
      { upsert: true },
    );
  }

  const stale = await db.collection("bsp_subscriptions").updateMany(
    {
      workspaceId: resolvedWorkspaceId,
      provider: "gupshup",
      appId: providerId,
      status: { $ne: "deleted" },
      ...(returnedUrls.size ? { callbackUrl: { $nin: [...returnedUrls] } } : {}),
    },
    { $set: { status: "disabled", "providerData.syncedAt": syncedAt, "providerData.staleReason": "missing_from_provider" } },
  );

  return { appId: providerId, workspaceId: resolvedWorkspaceId, synced: subscriptions.length, disabled: stale.modifiedCount, subscriptions };
}

export async function syncWebhook(appId: string, input: Record<string, unknown>) {
  const db = await bspDb();
  const app = await db.collection("bsp_apps").findOne({
    $or: [{ appId }, { gupshupAppId: appId }, { "gupshupIdentity.partnerAppId": appId }],
  });
  const workspaceId = String(app?.workspaceId || input.workspaceId || "");
  if (!workspaceId) throw new Error(`No workspace mapping found for Gupshup app ${appId}`);

  const providerId = app ? providerAppId(app) : appId;
  const callbackUrl = secureWebhookUrl(String(input.url || config.gupshup.webhookUrl || ""));
  const events = normalizeEvents(input.modes);
  const strategy = normalizeStrategy(input.strategy);
  const existing = await listProviderSubscriptions(providerId);

  if (strategy === "replace") {
    for (const subscription of existing) {
      const id = subscriptionId(subscription);
      if (id) await deleteProviderSubscription(providerId, id);
    }
  }

  const sameUrl = existing.find((subscription) => normalizeUrl(subscriptionUrl(subscription)) === normalizeUrl(callbackUrl));
  const sameUrlId = subscriptionId(sameUrl);
  const response = sameUrlId && strategy === "update"
    ? await updateProviderSubscription(providerId, sameUrlId, callbackUrl, events)
    : await createProviderSubscription(providerId, callbackUrl, events);

  await db.collection("bsp_subscriptions").updateOne(
    { workspaceId, provider: "gupshup", appId: providerId, callbackUrl },
    { $set: subscriptionDocument(response, workspaceId, providerId, callbackUrl, new Date(), "admin_webhook_sync", events) },
    { upsert: true },
  );
  return { synced: true, appId: providerId, workspaceId, callbackUrl, response };
}

export async function syncAllWebhooks(input: Record<string, unknown>) {
  const apps = await listBspApps();
  const result = { total: apps.length, synced: 0, failed: 0, skipped: 0, details: [] as Record<string, unknown>[] };
  for (const app of apps) {
    const appId = providerAppId(app);
    if (isPlaceholderAppId(appId)) {
      result.skipped += 1;
      continue;
    }
    try {
      await syncWebhook(appId, { ...input, workspaceId: app.workspaceId });
      result.synced += 1;
      result.details.push({ workspaceId: app.workspaceId, appId, status: "synced" });
    } catch (error) {
      result.failed += 1;
      result.details.push({ workspaceId: app.workspaceId, appId, status: "failed", error: errorMessage(error) });
    }
  }
  return result;
}

export async function deleteBspSubscription(appId: string, subscriptionIdValue: string) {
  const db = await bspDb();
  const subscription = await db.collection("bsp_subscriptions").findOne({ _id: toObjectId(subscriptionIdValue) });
  const providerSubscriptionId = String(subscription?.providerData?.providerSubscriptionId || subscriptionIdValue);
  await deleteProviderSubscription(appId, providerSubscriptionId);
  await db.collection("bsp_subscriptions").updateOne(
    { _id: subscription?._id || toObjectId(subscriptionIdValue) },
    { $set: { status: "deleted", updatedAt: new Date(), "providerData.deletedAt": new Date(), "providerData.source": "admin_portal" } },
  );
  return { deleted: true, appId, subscriptionId: subscriptionIdValue };
}

export async function resolveBspAppIdDirect(explicitAppId: unknown, workspaceIdValue: unknown): Promise<string> {
  const explicit = normalizeId(explicitAppId);
  if (explicit && !isPlaceholderAppId(explicit)) return explicit;
  const workspaceId = normalizeId(workspaceIdValue);
  if (!workspaceId) return "";
  const apps = await listBspApps(workspaceId);
  return apps.map(providerAppId).find((id) => !isPlaceholderAppId(id)) || "";
}

async function listProviderSubscriptions(appId: string): Promise<Record<string, unknown>[]> {
  return withAppAuth(appId, async (headers) => {
    const response = await providerClient().get(`/partner/app/${encodeURIComponent(appId)}/subscription`, { headers });
    const subscriptions = response.data?.subscriptions || response.data?.data || [];
    return Array.isArray(subscriptions) ? subscriptions : [];
  });
}

async function createProviderSubscription(appId: string, url: string, events: string[]) {
  return withAppAuth(appId, async (headers) => {
    const form = subscriptionForm(appId, url, events);
    const response = await providerClient().post(`/partner/app/${encodeURIComponent(appId)}/subscription?v=v3`, form.toString(), {
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    });
    return { ...response.data, registeredUrl: url };
  });
}

async function updateProviderSubscription(appId: string, subscriptionIdValue: string, url: string, events: string[]) {
  return withAppAuth(appId, async (headers) => {
    const form = subscriptionForm(appId, url, events);
    const response = await providerClient().put(
      `/partner/app/${encodeURIComponent(appId)}/subscription/${encodeURIComponent(subscriptionIdValue)}?v=v3`,
      form.toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return { ...response.data, registeredUrl: url, id: subscriptionIdValue };
  });
}

async function deleteProviderSubscription(appId: string, subscriptionIdValue: string) {
  return withAppAuth(appId, async (headers) => {
    const response = await providerClient().delete(
      `/partner/app/${encodeURIComponent(appId)}/subscription/${encodeURIComponent(subscriptionIdValue)}`,
      { headers },
    );
    return response.data;
  });
}

function subscriptionForm(appId: string, url: string, events: string[]) {
  return new URLSearchParams({
    url,
    version: "3",
    tag: `connectsphere-${crypto.createHash("sha256").update(`${appId}:${url}`).digest("hex").slice(0, 16)}`,
    modes: events.join(","),
    showOnUI: "true",
  });
}

function subscriptionDocument(
  subscription: Record<string, unknown>, workspaceId: string, appId: string, callbackUrl: string,
  syncedAt: Date, source: string, eventOverride?: string[],
) {
  const events = eventOverride || (Array.isArray(subscription.modes) ? subscription.modes : Array.isArray(subscription.events) ? subscription.events : []);
  return {
    workspaceId,
    provider: "gupshup",
    appId,
    callbackUrl,
    events,
    status: subscription.active === false ? "disabled" : "active",
    providerData: { gupshupResponse: subscription, providerSubscriptionId: subscriptionId(subscription) || undefined, source, syncedAt },
    updatedAt: syncedAt,
  };
}

async function bspDb() {
  const connection = await getConnection("bsp");
  if (!connection.db) throw new Error("BSP database handle unavailable");
  return connection.db;
}

function providerAppId(record: Record<string, unknown>): string {
  const identity = record.gupshupIdentity as Record<string, unknown> | undefined;
  return normalizeId(record.gupshupAppId) || normalizeId(identity?.partnerAppId) || normalizeId(record.appId);
}

function subscriptionId(value?: Record<string, unknown>) {
  return normalizeId(value?.id) || normalizeId(value?.subscriptionId) || normalizeId((value?.providerData as Record<string, unknown> | undefined)?.providerSubscriptionId);
}

function subscriptionUrl(value?: Record<string, unknown>) {
  return normalizeId(value?.url) || normalizeId(value?.callbackUrl);
}

function normalizeToken(value: unknown) {
  return String(value || "").replace(/^Bearer\s+/i, "").trim();
}

function normalizeId(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isPlaceholderAppId(value: string) {
  return !value || value.startsWith("mock_") || value.startsWith("pending_");
}

function isSandboxPartnerApp(app: Record<string, unknown>) {
  const fields = [app.status, app.mode, app.environment, app.appMode, app.type, app.category]
    .map((value) => normalizeId(value).toLowerCase());
  return fields.some((value) => value === "sandbox" || value.includes("sandbox"));
}

function secureWebhookUrl(value: string) {
  return buildGupshupWebhookUrl(value);
}

function normalizeEvents(value: unknown): string[] {
  const events = Array.isArray(value) && value.length ? value : DEFAULT_EVENTS;
  return [...new Set(events.map((event) => String(event).toUpperCase()))];
}

function normalizeStrategy(value: unknown): "update" | "add" | "replace" {
  return value === "add" || value === "replace" ? value : "update";
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function toObjectId(value: string) {
  // Mongoose's connection driver accepts string IDs only for string fields;
  // use its BSON ObjectId constructor for `_id` lookups.
  return new mongoose.Types.ObjectId(value);
}

function providerError(error: unknown): Error {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error : new Error("Provider operation failed");
  const data = error.response?.data;
  const message = data?.message || data?.error || error.message;
  return new Error(error.response?.status ? `Gupshup returned ${error.response.status}: ${message}` : String(message));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Provider operation failed";
}
