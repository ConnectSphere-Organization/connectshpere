import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { config } from '../../../../config';
import { RedisService } from '../../../../common/redis.service';
import { ProviderApp } from '../../../../models/provider-app.schema';
import { encryptSecretCBC, decryptSecretCBC } from '../../../../common/secret-box';

@Injectable()
export class GupshupClientService {
  public readonly partnerClient: AxiosInstance;

  constructor(
    private readonly redis: RedisService,
    @InjectModel(ProviderApp.name) private readonly appModel: Model<ProviderApp>,
  ) {
    this.partnerClient = axios.create({
      baseURL: config.gupshup.partnerBaseUrl,
      timeout: 25000,
    });
  }

  private cachedPartnerToken: string | null = null;
  private cachedPartnerTokenExpiresAt = 0;

  async getPartnerToken(forceRefresh = false): Promise<string> {
    const PARTNER_TOKEN_CACHE_KEY = 'cache:gupshup:partner-token';
    const PARTNER_TOKEN_LOCK_KEY = 'lock:gupshup:partner-token';
    const DEFAULT_PARTNER_TOKEN_TTL_SECONDS = 23 * 60 * 60;
    const REFRESH_SKEW_MS = 15 * 60 * 1000;
    const MEMORY_CACHE_TTL_MS = 30 * 1000;

    if (forceRefresh) {
      this.cachedPartnerToken = null;
      this.cachedPartnerTokenExpiresAt = 0;
      await this.redis.del(PARTNER_TOKEN_CACHE_KEY);
    }

    // 1. Check process-level in-memory cache
    if (!forceRefresh && this.cachedPartnerToken && this.cachedPartnerTokenExpiresAt > Date.now()) {
      return this.cachedPartnerToken;
    }

    // 2. Check Redis Cache
    const cached = await this.redis.getJson<{ token: string; expiresAt: string; refreshedAt: string }>(PARTNER_TOKEN_CACHE_KEY);

    // Prevent hammering forced refresh if it happened in last 30s
    const lastRefreshed = cached?.refreshedAt ? new Date(cached.refreshedAt).getTime() : 0;
    const isTooSoonForForce = Date.now() - lastRefreshed < 30000;

    if (forceRefresh && isTooSoonForForce && cached?.token) {
      console.log('[Gupshup API Auth Debug] Forced refresh ignored - already refreshed in last 30s');
      return cached.token;
    }

    // Helper to verify if expiring soon
    const isExpiringSoon = (expiry?: string | null) => {
      if (!expiry) return true;
      const time = new Date(expiry).getTime();
      return isNaN(time) || time <= Date.now() + REFRESH_SKEW_MS;
    };

    if (!forceRefresh && cached?.token && !isExpiringSoon(cached.expiresAt)) {
      this.cachedPartnerToken = cached.token;
      this.cachedPartnerTokenExpiresAt = Date.now() + MEMORY_CACHE_TTL_MS;
      return cached.token;
    }

    // Static token fallback
    const envToken = config.gupshup.partnerToken ? String(config.gupshup.partnerToken).replace(/^Bearer\s+/i, '').trim() : '';
    const hasLoginCredentials = Boolean(
      config.gupshup.partnerEmail &&
      (config.gupshup.partnerPassword || config.gupshup.partnerClientSecret)
    );

    if (envToken && (!forceRefresh || !hasLoginCredentials)) {
      return envToken;
    }

    // Acquire lock for refresh
    const lockAcquired = await this.redis.acquireLock(PARTNER_TOKEN_LOCK_KEY);
    if (!lockAcquired) {
      // Retry progressive backoff
      for (const delayMs of [150, 300, 600]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const retryCached = await this.redis.getJson<{ token: string; expiresAt: string }>(PARTNER_TOKEN_CACHE_KEY);
        if (retryCached?.token && !isExpiringSoon(retryCached.expiresAt)) {
          return retryCached.token;
        }
      }
    }

    try {
      if (hasLoginCredentials) {
        const email = config.gupshup.partnerEmail?.trim() || '';
        const password = config.gupshup.partnerPassword?.trim() || '';
        const clientSecret = config.gupshup.partnerClientSecret?.trim() || '';

        console.log('[Gupshup API Auth] Requesting Partner token', {
          partnerBaseUrl: config.gupshup.partnerBaseUrl,
          hasPassword: Boolean(password),
          hasClientSecret: Boolean(clientSecret),
        });

        const params = new URLSearchParams();
        params.append('email', email);
        if (password) params.append('password', password);
        if (clientSecret) params.append('clientSecret', clientSecret);

        const response = await this.partnerClient.post(
          '/partner/account/login',
          params.toString(),
          {
            headers: {
              'accept': 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 15000,
          }
        );

        const tokenCandidate = response.data?.token || response.data?.accessToken || response.data?.jwt;
        const freshToken = tokenCandidate ? String(tokenCandidate).replace(/^Bearer\s+/i, '').trim() : '';

        if (freshToken) {
          const expiresAtStr = new Date(Date.now() + DEFAULT_PARTNER_TOKEN_TTL_SECONDS * 1000).toISOString();
          const record = {
            token: freshToken,
            expiresAt: expiresAtStr,
            refreshedAt: new Date().toISOString(),
          };
          await this.redis.setJson(PARTNER_TOKEN_CACHE_KEY, record, DEFAULT_PARTNER_TOKEN_TTL_SECONDS);

          this.cachedPartnerToken = freshToken;
          this.cachedPartnerTokenExpiresAt = Date.now() + MEMORY_CACHE_TTL_MS;
          return freshToken;
        } else {
          throw new Error(response.data?.message || 'Login failed - no token returned');
        }
      }

      if (envToken) {
        return envToken;
      }

      throw new Error('Gupshup partner credentials are not configured');
    } catch (error: any) {
      const errMsg = error.response?.data?.message || error.message;
      throw new Error(`Failed to authenticate with Gupshup Partner API: ${errMsg}`);
    } finally {
      await this.redis.releaseLock(PARTNER_TOKEN_LOCK_KEY);
    }
  }

  async resolveAppToken(appId: string, forceRefresh = false): Promise<string> {
    const APP_TOKEN_CACHE_PREFIX = 'cache:gupshup:app-token:';
    const APP_TOKEN_LOCK_PREFIX = 'lock:gupshup:app-token:';
    const DEFAULT_APP_TOKEN_TTL_SECONDS = 23 * 60 * 60;
    const REFRESH_SKEW_MS = 15 * 60 * 1000;

    const cacheKey = `${APP_TOKEN_CACHE_PREFIX}${appId}`;
    const lockKey = `${APP_TOKEN_LOCK_PREFIX}${appId}`;

    if (forceRefresh) {
      await this.redis.del(cacheKey);
    }

    // Proactive refresh check helper
    const isExpiringSoon = (expiry?: Date | string | null) => {
      if (!expiry) return true;
      const time = new Date(expiry).getTime();
      return isNaN(time) || time <= Date.now() + REFRESH_SKEW_MS;
    };

    // 1. Check Redis Cache
    if (!forceRefresh) {
      const cached = await this.redis.getJson<{ token: string; expiresAt: string }>(cacheKey);
      if (cached?.token && !isExpiringSoon(cached.expiresAt)) {
        return cached.token;
      }
    }

    // 2. Check Database Storage (Decrypted)
    if (!forceRefresh) {
      const app = await this.appModel.findOne({ appId }).exec();
      const encryptedKey = app?.gupshupIdentity?.appApiKey || app?.accessToken;
      const expiresAt = app?.gupshupIdentity?.appApiKeyExpiresAt || app?.tokenExpiresAt;

      if (encryptedKey && expiresAt && !isExpiringSoon(expiresAt)) {
        const decrypted = decryptSecretCBC(encryptedKey);
        if (decrypted) {
          // Backfill cache
          await this.redis.setJson(cacheKey, {
            token: decrypted,
            expiresAt: expiresAt.toISOString(),
          }, 3600);
          return decrypted;
        }
      }
    }

    // Acquire Lock
    const lockAcquired = await this.redis.acquireLock(lockKey);
    if (!lockAcquired) {
      for (const delayMs of [150, 300, 600]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const retryCached = await this.redis.getJson<{ token: string; expiresAt: string }>(cacheKey);
        if (retryCached?.token && !isExpiringSoon(retryCached.expiresAt)) {
          return retryCached.token;
        }
      }
    }

    try {
      let partnerToken = await this.getPartnerToken(forceRefresh);
      let freshTokenRecord: any = null;

      const fetchTokenFromGupshup = async (pToken: string) => {
        const url = `/partner/app/${appId}/token`;
        const normalized = pToken.replace(/^Bearer\s+/i, '').trim();

        // Gupshup header variations for compatibility
        const headerVariants = [
          { Authorization: normalized, token: normalized, Accept: 'application/json' },
          { Authorization: `Bearer ${normalized}`, token: normalized, Accept: 'application/json' },
          { token: normalized, Accept: 'application/json' }
        ];

        let lastError = null;
        for (const headers of headerVariants) {
          try {
            const response = await this.partnerClient.get(url, { headers, timeout: 15000 });
            return response.data;
          } catch (error: any) {
            lastError = error;
            const status = error.response?.status;
            if (status !== 401 && status !== 403) throw error;
          }
        }
        throw lastError;
      };

      try {
        freshTokenRecord = await fetchTokenFromGupshup(partnerToken);
      } catch (error: any) {
        const status = Number(error?.response?.status || 0);
        if (!forceRefresh && (status === 401 || status === 403)) {
          // Retry with fresh partner token
          partnerToken = await this.getPartnerToken(true);
          freshTokenRecord = await fetchTokenFromGupshup(partnerToken);
        } else {
          throw error;
        }
      }

      const tokenCandidate =
        freshTokenRecord?.token?.token ??
        freshTokenRecord?.data?.token?.token ??
        freshTokenRecord?.result?.token?.token ??
        freshTokenRecord?.token ??
        freshTokenRecord?.accessToken ??
        freshTokenRecord?.data?.token ??
        freshTokenRecord?.result?.token;

      const appToken = tokenCandidate ? String(tokenCandidate).replace(/^Bearer\s+/i, '').trim() : '';
      if (!appToken) {
        throw new Error(`No app token found in Gupshup response for app ${appId}`);
      }

      const expiryCandidate =
        freshTokenRecord?.expiresAt ||
        freshTokenRecord?.expiry ||
        freshTokenRecord?.data?.expiresAt ||
        freshTokenRecord?.result?.expiresAt;

      const expiresAt = expiryCandidate ? new Date(expiryCandidate) : new Date(Date.now() + DEFAULT_APP_TOKEN_TTL_SECONDS * 1000);
      const encryptedValue = encryptSecretCBC(appToken);

      // Persist in Mongoose models securely
      await this.appModel.findOneAndUpdate(
        { appId },
        {
          $set: {
            accessToken: encryptedValue || undefined,
            tokenExpiresAt: expiresAt,
            'gupshupIdentity.appApiKey': encryptedValue || undefined,
            'gupshupIdentity.appApiKeyExpiresAt': expiresAt,
            'gupshupIdentity.appApiKeyRefreshedAt': new Date(),
          }
        },
        { new: true }
      );

      // Cache in Redis
      await this.redis.setJson(cacheKey, {
        token: appToken,
        expiresAt: expiresAt.toISOString(),
      }, Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));

      return appToken;
    } finally {
      await this.redis.releaseLock(lockKey);
    }
  }

  private async findPartnerAppByName(name: string, token: string): Promise<string | null> {
    try {
      const response = await this.partnerClient.get(
        `/partner/app/list?search=${encodeURIComponent(name)}`,
        {
          headers: {
            token,
            Accept: 'application/json',
          },
        }
      );
      const apps = response.data?.partnerAppsList || response.data?.data || response.data?.apps || [];
      if (Array.isArray(apps)) {
        const found = apps.find(app => String(app.name || app.appName || '').toLowerCase() === name.toLowerCase());
        return found?.id || found?.appId || null;
      }
      return null;
    } catch (err: any) {
      console.warn('[Gupshup App Lookup Warning]', err.message);
      return null;
    }
  }

  private sanitizeAppName(workspaceId: string, businessId?: string, variant = ''): string {
    const workspacePart = String(workspaceId)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(-10);
    const businessPart = String(businessId || '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(0, 12);
    const variantPart = String(variant || '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(0, 4);
    const bodyLimit = Math.max(0, 32 - 4 - variantPart.length);
    const body = `${workspacePart}${businessPart}`.slice(0, bodyLimit);
    return `waba${body}${variantPart}`.substring(0, 32);
  }

  async createEmbeddedOnboardingLink(input: {
    workspaceId: string;
    businessId: string;
    callbackUrl: string;
    state: string;
    metadata?: Record<string, unknown>;
    lang?: string;
    user?: string;
    regenerate?: boolean;
  }) {
    const token = await this.getPartnerToken();
    const baseName = this.sanitizeAppName(input.workspaceId, input.businessId);

    let appId: string;
    let createAppRes: any;

    const callCreateApp = async (name: string) => {
      const bodyParams = new URLSearchParams();
      bodyParams.append('name', name);
      bodyParams.append('templateMessaging', 'true');
      bodyParams.append('disableOptinPrefUrl', 'false');

      return this.partnerClient.post(
        '/partner/app',
        bodyParams.toString(),
        {
          headers: {
            token: token,
            Authorization: token,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        }
      );
    };

    const callCreateOrReclaimApp = async (name: string) => {
      try {
        const res = await callCreateApp(name);
        return res;
      } catch (error: any) {
        const isConflict = error.response?.status === 409 || error.response?.data?.message?.includes('Already Exists');
        if (isConflict) {
          console.log(`[Gupshup App Creation] Bot "${name}" already exists on Gupshup. Attempting to reclaim...`);
          const existingId = await this.findPartnerAppByName(name, token);
          if (existingId) {
            console.log('[Gupshup App Reclaim] Reclaimed existing app ID:', existingId);
            return {
              data: {
                status: 'success',
                appId: existingId,
                app: { appId: existingId, name, status: 'DRAFT' }
              }
            };
          }
        }
        throw error;
      }
    };

    try {
      // Step 1: Programmatically create a WABA app on Gupshup partner portal
      try {
        createAppRes = await callCreateOrReclaimApp(baseName);
      } catch (error: any) {
        if (error.response?.status === 400) {
          console.warn('[Gupshup App Creation] Primary name 400 Bad Request, trying retry variant...');
          const retryName = this.sanitizeAppName(input.workspaceId, input.businessId, 'ret');
          createAppRes = await callCreateOrReclaimApp(retryName);
        } else {
          throw error;
        }
      }

      const createdAppId = createAppRes.data?.appId || createAppRes.data?.id || createAppRes.data?.data?.appId || createAppRes.data?.app?.appId;
      if (createdAppId) {
        appId = createdAppId;
      } else {
        throw new Error(createAppRes.data?.message || 'Create app failed - no appId in response');
      }
    } catch (error: any) {
      console.error('[Gupshup App Creation Error Detailed Response]', {
        status: error.response?.status,
        headers: error.response?.headers,
        data: error.response?.data,
      });
      const errMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      throw new Error(`Failed to create WABA application on Gupshup: ${errMsg}`);
    }

    try {
      // Step 2: Generate the embed onboarding signed link for the created app
      const fetchOnboardingLink = async (regenerateLink?: boolean) => {
        const query = new URLSearchParams();
        query.append('user', input.user || config.gupshup.partnerEmail || 'system');
        query.append('lang', input.lang || 'en');
        if (typeof regenerateLink === 'boolean') {
          query.append('regenerate', String(regenerateLink));
        } else if (typeof input.regenerate === 'boolean') {
          query.append('regenerate', String(input.regenerate));
        }

        return this.partnerClient.get(
          `/partner/app/${appId}/onboarding/embed/link?${query.toString()}`,
          {
            headers: {
              token: token,
              Accept: 'application/json',
            },
          }
        );
      };

      let getLinkRes: any;
      try {
        getLinkRes = await fetchOnboardingLink();
      } catch (linkError: any) {
        const isRegen = linkError.response?.data?.message?.includes('regenerate') || linkError.message?.includes('regenerate');
        if (isRegen && !input.regenerate) {
          console.log(`[Gupshup Embed Link] Primary link request failed with regenerate requirement. Triggering signed link refresh...`);
          getLinkRes = await fetchOnboardingLink(true);
        } else {
          throw linkError;
        }
      }

      if (getLinkRes.data?.status === 'success' && getLinkRes.data?.link) {
        return {
          appId,
          url: getLinkRes.data.link,
          providerResponse: {
            mode: 'live',
            provider: 'gupshup',
            app: createAppRes.data?.app || createAppRes.data,
            embedLinkResponse: getLinkRes.data,
          },
        };
      } else {
        throw new Error(getLinkRes.data?.message || 'Generate embed link failed');
      }
    } catch (error: any) {
      console.error('[Gupshup Embed Link Error Detailed Response]', {
        status: error.response?.status,
        headers: error.response?.headers,
        data: error.response?.data,
      });
      const errMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      throw new Error(`Failed to generate Meta Embedded Onboarding link for App ID ${appId}: ${errMsg}`);
    }
  }

  async refreshAppToken(appId: string) {
    const token = await this.resolveAppToken(appId, true);
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000);
    return {
      appId,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async sendMessage(input: { appId: string; payload: Record<string, unknown> }) {
    const isMock = String(input.appId).startsWith('mock_') || input.appId === 'default';
    const hasCredentials = Boolean(
      config.gupshup.partnerToken ||
      (config.gupshup.partnerEmail && (config.gupshup.partnerPassword || config.gupshup.partnerClientSecret))
    );

    if (isMock || !hasCredentials) {
      const mockMsgId = `wamid.simulated_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      console.log(`[GupshupClient] Simulated message send for app ${input.appId}: ${mockMsgId}`);
      return {
        id: mockMsgId,
        messageId: mockMsgId,
        appId: input.appId,
        payload: input.payload,
        data: { status: 'submitted', messages: [{ id: mockMsgId }] },
      };
    }

    const appToken = await this.resolveAppToken(input.appId);
    const rawApp = this.normalizeToken(appToken);
    const url = `/partner/app/${input.appId}/v3/message`;
    const headerVariants = [
      { token: rawApp, Accept: 'application/json' },
      { Authorization: rawApp, Accept: 'application/json' },
      { Authorization: `Bearer ${rawApp}`, Accept: 'application/json' },
    ];

    let lastError: any;
    for (const headers of headerVariants) {
      try {
        const response = await this.partnerClient.post(
          url,
          input.payload,
          {
            headers,
            timeout: 25000,
          }
        );

        const resData = response.data;
        const messageId = resData?.messages?.[0]?.id || resData?.message?.id || resData?.messageId || resData?.id || undefined;

        if (!messageId) {
          throw new Error('Gupshup did not return a message ID: ' + JSON.stringify(resData));
        }

        return {
          id: resData?.id || resData?.messageId || messageId,
          messageId,
          appId: input.appId,
          payload: input.payload,
          data: resData,
        };
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.response?.status || 0);
        if (status !== 401 && status !== 403) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async markMessageRead(input: { appId: string; messageId: string }) {
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: input.messageId,
    };

    return this.withDualAuth(input.appId, async (headers) => {
      const attempts = [
        { url: `/partner/app/${input.appId}/v3/message/action`, body: payload },
        { url: `/partner/app/${input.appId}/v3/message`, body: payload },
        {
          url: `/partner/app/${input.appId}/v1/event`,
          body: { type: 'message', message: { id: input.messageId, status: 'read' } },
        },
        {
          url: `/partner/app/${input.appId}/v1/event`,
          body: { type: 'read', message: { id: input.messageId } },
        },
      ];

      let lastError: any = null;
      for (const attempt of attempts) {
        try {
          const response = await this.partnerClient.post(attempt.url, attempt.body, {
            headers: {
              ...headers,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          });
          return response.data;
        } catch (error: any) {
          lastError = error;
          const status = Number(error?.response?.status || 0);
          if ([401, 403, 404, 405, 422].includes(status)) continue;
          const providerMessage = error?.response?.data?.message || error?.response?.data?.error;
          if (status === 400 && providerMessage) continue;
          throw error;
        }
      }

      throw lastError;
    });
  }

  async listTemplates(input: { appId: string; status?: string }) {
    const appToken = await this.resolveAppToken(input.appId);
    const rawApp = this.normalizeToken(appToken);
    const statusQuery = input.status ? `?status=${encodeURIComponent(input.status)}` : '';
    const url = `/partner/app/${input.appId}/templates${statusQuery}`;

    const headerVariants = [
      { token: rawApp, Accept: 'application/json' },
      { Authorization: rawApp, Accept: 'application/json' },
      { Authorization: `Bearer ${rawApp}`, Accept: 'application/json' },
    ];

    let lastError: any;
    for (const headers of headerVariants) {
      try {
        const response = await this.partnerClient.get(url, { headers, timeout: 25000 });
        const templates = response.data?.templates || response.data?.data || [];
        return Array.isArray(templates) ? templates : [];
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.response?.status || 0);
        if (status !== 401 && status !== 403) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async submitTemplate(input: { appId: string; template: Record<string, unknown> }) {
    const appToken = await this.resolveAppToken(input.appId);
    const rawApp = this.normalizeToken(appToken);
    const url = `/partner/app/${input.appId}/templates`;
    const headerVariants = [
      { token: rawApp, Accept: 'application/json' },
      { Authorization: rawApp, Accept: 'application/json' },
      { Authorization: `Bearer ${rawApp}`, Accept: 'application/json' },
    ];

    let lastError: any;
    for (const headers of headerVariants) {
      try {
        const response = await this.partnerClient.post(url, input.template, {
          headers: { ...headers, 'Content-Type': 'application/json' },
          timeout: 25000,
        });
        const data = response.data?.data || response.data;
        const providerTemplateId = data?.id || data?.templateId || data?.externalId || data?.template?.id;
        if (!providerTemplateId) throw new Error('Gupshup template submission did not return a template ID');
        return { providerTemplateId: String(providerTemplateId), status: String(data?.status || 'PENDING'), data };
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.response?.status || 0);
        if (status !== 401 && status !== 403) break;
      }
    }

    const providerMessage = lastError?.response?.data?.message || lastError?.response?.data?.error || lastError?.message;
    throw Object.assign(new Error(providerMessage || 'Template submission failed'), {
      code: 'PROVIDER_TEMPLATE_SUBMISSION_FAILED',
      status: lastError?.response?.status || 502,
    });
  }

  async getApp(appId: string) {
    throw new Error(`PROVIDER_OPERATION_NOT_IMPLEMENTED: getApp(${appId})`);
  }

  async providerAction(input: { appId?: string; action: string; payload: Record<string, unknown> }) {
    throw new Error(`PROVIDER_OPERATION_NOT_IMPLEMENTED: ${input.action}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ACTIVE GUPSHUP PARTNER AND APP API INTEGRATIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  private normalizeToken(token?: string): string {
    return String(token || '').replace(/^Bearer\s+/i, '').trim();
  }

  private resolveSecureWebhookUrl(inputUrl: string): string {
    if (inputUrl.startsWith('https://')) return inputUrl;

    const isLocal = inputUrl.includes('localhost') || inputUrl.includes('127.0.0.1');
    if (isLocal) {
      const publicBase = process.env.APP_URL || process.env.WHATSAPP_WEBHOOK_URL;
      if (publicBase && publicBase.startsWith('https://')) {
        try {
          const urlObj = new URL(inputUrl);
          const publicObj = new URL(publicBase);
          return `${publicObj.origin}${urlObj.pathname}${urlObj.search}`;
        } catch {
          // ignore parsing error
        }
      }
    }

    return inputUrl;
  }

  private generateUniqueTag(appId: string, url: string): string {
    const combined = `${appId}:${url}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      hash = ((hash << 5) - hash) + combined.charCodeAt(i);
      hash |= 0;
    }
    return `WAPI-V3-${Math.abs(hash).toString(36).toUpperCase()}`;
  }

  private generateNonceTag(appId: string, url: string): string {
    return this.generateUniqueTag(appId, `${url}:${Date.now()}:${Math.random().toString(36).slice(2)}`);
  }

  private providerSubscriptionId(subscription: any): string {
    return String(
      subscription?.id ||
      subscription?.subscriptionId ||
      subscription?.subscription_id ||
      subscription?.providerSubscriptionId ||
      ''
    ).trim();
  }

  private providerSubscriptionUrl(subscription: any): string {
    return String(subscription?.url || subscription?.callbackUrl || subscription?.callback_url || '').trim();
  }

  private providerSubscriptionTag(subscription: any): string {
    return String(subscription?.tag || subscription?.componentTag || subscription?.component_tag || '').trim();
  }

  private normalizeWebhookUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  private sameWebhookUrl(a: string, b: string): boolean {
    return this.normalizeWebhookUrl(a) === this.normalizeWebhookUrl(b);
  }

  private isDuplicateComponentTagError(error: any): boolean {
    const message = String(
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      ''
    ).toLowerCase();
    return message.includes('duplicate component tag') || message.includes('duplicate tag');
  }

  async withPartnerAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      const token = await this.getPartnerToken();
      return await fn(token);
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      if (status === 401) {
        const freshToken = await this.getPartnerToken(true);
        return fn(freshToken);
      }
      throw error;
    }
  }

  async withDualAuth<T>(appId: string, fn: (headers: any) => Promise<T>): Promise<T> {
    try {
      const token = await this.getPartnerToken();
      const raw = this.normalizeToken(token);
      return await fn({
        Authorization: `Bearer ${raw}`,
        Accept: 'application/json',
      });
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      if (status !== 401 && status !== 403) {
        throw error;
      }
    }

    const runWithAppToken = async (forceRefresh = false) => {
      const appToken = await this.resolveAppToken(appId, forceRefresh);
      const rawApp = this.normalizeToken(appToken);
      const appHeaderVariants = [
        { Authorization: rawApp, Accept: 'application/json' },
        { token: rawApp, Accept: 'application/json' },
        { Authorization: `Bearer ${rawApp}`, token: rawApp, Accept: 'application/json' },
      ];

      let lastError: any = null;
      for (const headers of appHeaderVariants) {
        try {
          return await fn(headers);
        } catch (error: any) {
          lastError = error;
          const status = Number(error?.response?.status || 0);
          if (status !== 401 && status !== 403) throw error;
        }
      }
      throw lastError;
    };

    try {
      return await runWithAppToken(false);
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      if (status !== 401 && status !== 403) throw error;
      return runWithAppToken(true);
    }
  }

  async registerPhoneForApp(input: { appId: string; region?: string; phoneNumber: string }) {
    const appToken = await this.resolveAppToken(input.appId);
    const raw = this.normalizeToken(appToken);

    const response = await this.partnerClient.post(
      `/partner/app/${input.appId}/register/phone`,
      {
        phoneNumber: input.phoneNumber,
        region: input.region || 'IN',
      },
      {
        headers: {
          Authorization: raw,
          Accept: 'application/json',
        },
      }
    );
    return response.data;
  }

  async listSubscriptions(appId: string) {
    return this.withDualAuth(appId, async (headers) => {
      const response = await this.withRateLimitRetry(() =>
        this.partnerClient.get(`/partner/app/${appId}/subscription`, {
          headers,
        }),
      );
      const rawSubs = response.data?.subscriptions || response.data?.data || [];
      return Array.isArray(rawSubs) ? rawSubs.map((s: any) => ({
        ...s,
        id: this.providerSubscriptionId(s) || s.id,
        subscriptionId: this.providerSubscriptionId(s) || s.subscriptionId,
        url: this.providerSubscriptionUrl(s) || s.url,
        callbackUrl: this.providerSubscriptionUrl(s) || s.callbackUrl,
        tag: this.providerSubscriptionTag(s) || s.tag,
        events: s.modes || s.events || [],
      })) : [];
    });
  }

  async setSubscription(input: {
    appId: string;
    url: string;
    events?: string[];
    strategy?: 'update' | 'add' | 'replace';
  }) {
    let targetUrl = input.url;
    if (targetUrl && !targetUrl.includes('/api/webhooks/')) {
      const separator = targetUrl.endsWith('/') ? '' : '/';
      targetUrl = `${targetUrl}${separator}api/webhooks/whatsapp`;
    }

    const secureUrl = this.resolveSecureWebhookUrl(targetUrl);
    const strategy = input.strategy || 'update';

    if (!secureUrl.startsWith('https://')) {
      throw new Error(`Invalid webhook URL: "${secureUrl}". Gupshup V3 strictly requires an HTTPS callback URL.`);
    }

    return this.withDualAuth(input.appId, async (headers) => {
      const existing = await this.listSubscriptions(input.appId).catch(() => []);
      const normalizedEvents = (input.events && input.events.length > 0)
        ? input.events.map(e => e.toUpperCase())
        : ['MESSAGE', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'TEMPLATE', 'ACCOUNT', 'BILLING', 'PAYMENTS', 'FLOWS_MESSAGE'];

      if (strategy === 'replace' && existing.length > 0) {
        for (const sub of existing) {
          const subscriptionId = this.providerSubscriptionId(sub);
          if (subscriptionId) {
            await this.deleteSubscription(input.appId, subscriptionId).catch(e =>
              console.warn(`[GupshupClientService] Failed to delete sub ${subscriptionId}:`, e.message)
            );
          }
        }
      }

      const stableTag = this.generateUniqueTag(input.appId, secureUrl);
      if (strategy === 'update') {
        const existingSub = existing.find((s: any) => this.sameWebhookUrl(this.providerSubscriptionUrl(s), secureUrl));
        const existingSubId = this.providerSubscriptionId(existingSub);
        if (existingSubId) {
          return this.updateSubscription({
            appId: input.appId,
            subscriptionId: existingSubId,
            url: secureUrl,
            events: normalizedEvents,
            tag: this.providerSubscriptionTag(existingSub) || stableTag,
          });
        }

        const existingTagSub = existing.find((s: any) => this.providerSubscriptionTag(s) === stableTag);
        const existingTagSubId = this.providerSubscriptionId(existingTagSub);
        if (existingTagSubId) {
          return this.updateSubscription({
            appId: input.appId,
            subscriptionId: existingTagSubId,
            url: secureUrl,
            events: normalizedEvents,
            tag: stableTag,
          });
        }
      }

      const existingTags = new Set(existing.map((s: any) => this.providerSubscriptionTag(s)).filter(Boolean));
      const requestedTag = strategy === 'add' && existingTags.has(stableTag)
        ? this.generateNonceTag(input.appId, secureUrl)
        : stableTag;

      const buildParams = (tag: string) => {
        const params = new URLSearchParams();
        params.append('url', secureUrl);
        params.append('version', '3');
        params.append('tag', tag);

        const uniqueModes = new Set<string>();
        normalizedEvents.forEach((e: any) => {
          const upper = String(e).toUpperCase().replace(/-EVENT/i, '').replace(/_/g, '_');
          if (['USER', 'SYSTEM', 'OTHERS'].includes(upper)) {
            uniqueModes.add('OTHERS');
          } else if (['BILLING_EVENT', 'BILLING'].includes(upper)) {
            uniqueModes.add('BILLING');
          } else if (['ACCOUNT_EVENT', 'ACCOUNT'].includes(upper)) {
            uniqueModes.add('ACCOUNT');
          } else if (['TEMPLATE_EVENT', 'TEMPLATE'].includes(upper)) {
            uniqueModes.add('TEMPLATE');
          } else {
            uniqueModes.add(upper);
          }
        });
        params.append('modes', Array.from(uniqueModes).join(','));
        params.append('showOnUI', 'true');
        return params;
      };

      const createSubscription = async (tag: string) => {
        const params = buildParams(tag);
        const response = await this.partnerClient.post(
          `/partner/app/${input.appId}/subscription?v=v3`,
          params.toString(),
          {
            headers: {
              ...headers,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );

        return {
          ...response.data,
          registeredUrl: secureUrl,
        };
      };

      try {
        return await createSubscription(requestedTag);
      } catch (error: any) {
        if (!this.isDuplicateComponentTagError(error)) {
          throw error;
        }

        const latest = await this.listSubscriptions(input.appId).catch(() => []);
        const duplicate = latest.find((s: any) => this.providerSubscriptionTag(s) === requestedTag);
        const duplicateId = this.providerSubscriptionId(duplicate);
        if (strategy === 'update' && duplicateId) {
          return this.updateSubscription({
            appId: input.appId,
            subscriptionId: duplicateId,
            url: secureUrl,
            events: normalizedEvents,
            tag: requestedTag,
          });
        }

        return createSubscription(this.generateNonceTag(input.appId, secureUrl));
      }
    });
  }

  private async withRateLimitRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: any = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.response?.status || 0);
        if (status !== 429 || attempt >= retries) throw error;

        const retryAfterSeconds = Number(error?.response?.headers?.['x-rate-limit-retry-after-seconds'] || 0);
        const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1000, 10_000)
          : 1500 * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  async updateSubscription(input: {
    appId: string;
    subscriptionId: string;
    url: string;
    events: string[];
    tag?: string;
  }) {
    const secureUrl = this.resolveSecureWebhookUrl(input.url);
    if (!secureUrl.startsWith('https://')) {
      throw new Error(`HTTPS required for V3 updates. URL: ${secureUrl}`);
    }

    return this.withDualAuth(input.appId, async (headers) => {
      const params = new URLSearchParams();
      params.append('url', secureUrl);
      params.append('version', '3');
      params.append('tag', input.tag || this.generateUniqueTag(input.appId, secureUrl));

      const uniqueModes = new Set<string>();
      input.events.forEach((e: any) => {
        const upper = String(e).toUpperCase().replace(/-EVENT/i, '').replace(/_/g, '_');
        if (['USER', 'SYSTEM', 'OTHERS'].includes(upper)) {
          uniqueModes.add('OTHERS');
        } else if (['BILLING_EVENT', 'BILLING'].includes(upper)) {
          uniqueModes.add('BILLING');
        } else if (['ACCOUNT_EVENT', 'ACCOUNT'].includes(upper)) {
          uniqueModes.add('ACCOUNT');
        } else if (['TEMPLATE_EVENT', 'TEMPLATE'].includes(upper)) {
          uniqueModes.add('TEMPLATE');
        } else {
          uniqueModes.add(upper);
        }
      });
      params.append('modes', Array.from(uniqueModes).join(','));
      params.append('showOnUI', 'true');

      const response = await this.partnerClient.put(
        `/partner/app/${input.appId}/subscription/${input.subscriptionId}?v=v3`,
        params.toString(),
        {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return {
        ...response.data,
        registeredUrl: secureUrl,
      };
    });
  }

  async deleteSubscription(appId: string, subscriptionId: string) {
    return this.withDualAuth(appId, async (headers) => {
      const response = await this.partnerClient.delete(
        `/partner/app/${appId}/subscription/${subscriptionId}`,
        { headers }
      );
      return response.data;
    });
  }

  async whitelistWaba(appId: string, wabaId: string) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const response = await this.partnerClient.post(
        `/partner/app/${appId}/oboToEmbed/whitelist`,
        { wabaId },
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
          },
        }
      );
      return response.data;
    });
  }

  async verifyCreditLine(appId: string) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const response = await this.partnerClient.get(
        `/partner/app/${appId}/oboToEmbed/verify`,
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
          },
        }
      );
      return response.data;
    });
  }

  async getWabaInfo(appId: string) {
    return this.withDualAuth(appId, async (headers) => {
      const response = await this.partnerClient.get(
        `/partner/app/${appId}/wabaInfo`,
        { headers }
      );
      return response.data;
    });
  }

  async getHealth(appId: string) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const response = await this.partnerClient.get(
        `/partner/app/${appId}/health`,
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
          },
        }
      );
      return response.data;
    });
  }

  async getWalletBalance(appId: string) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const response = await this.partnerClient.get(
        `/partner/app/${appId}/wallet/balance`,
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
          },
        }
      );
      return response.data;
    });
  }

  async getRatings(appId: string) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const response = await this.partnerClient.get(
        `/partner/app/${appId}/ratings`,
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
          },
        }
      );
      return response.data;
    });
  }

  async updateOnboardingContact(input: {
    appId: string;
    contactName: string;
    contactEmail?: string;
    contactNumber?: string;
  }) {
    return this.withPartnerAuth(async (token) => {
      const raw = this.normalizeToken(token);
      const body = new URLSearchParams();
      body.append('contactEmail', input.contactEmail || '');
      body.append('contactName', input.contactName);
      body.append('contactNumber', input.contactNumber || '0000000000');

      const response = await this.partnerClient.put(
        `/partner/app/${input.appId}/onboarding/contact`,
        body.toString(),
        {
          headers: {
            Authorization: `Bearer ${raw}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
      return response.data;
    });
  }

  /**
   * Get templates from Meta Library
   * GET /partner/app/{appId}/template/metalibrary
   */
  async getMetaLibraryTemplates(appId: string, vertical?: string) {
    return this.withDualAuth(appId, async (headers) => {
      const query = new URLSearchParams();
      query.append('v', 'v3');
      if (vertical) query.append('vertical', vertical);

      const response = await this.partnerClient.get(`/partner/app/${appId}/template/metalibrary?${query.toString()}`, {
        headers,
        timeout: 15000,
      });
      return response.data?.templates || response.data?.data || [];
    });
  }

  /**
   * Create template from Meta Library
   * POST /partner/app/{appId}/template/metalibrary
   */
  async cloneMetaLibraryTemplate(appId: string, payload: {
    elementName: string;
    languageCode: string;
    category: string;
    components: any[];
  }) {
    return this.withDualAuth(appId, async (headers) => {
      const response = await this.partnerClient.post(`/partner/app/${appId}/template/metalibrary?v=v3`, payload, {
        headers,
        timeout: 15000,
      });
      return response.data;
    });
  }

  /**
   * Update Business Profile details
   * PUT/POST /partner/app/{appId}/business/profile
   */
  async updateBusinessProfile(appId: string, profile: any) {
    return this.withDualAuth(appId, async (headers) => {
      const sanitizedPayload = {
        ...profile,
        address: profile.address || 'Not Available',
        description: profile.description || 'WhatsApp Business Account',
        websites: Array.isArray(profile.websites) ? profile.websites.filter(Boolean) : profile.websites,
      };

      try {
        const response = await this.partnerClient.put(
          `/partner/app/${appId}/business/profile`,
          sanitizedPayload,
          {
            headers,
            timeout: 15000,
          }
        );
        return response.data;
      } catch (error: any) {
        const status = error.response?.status;
        if (status === 405 || status === 400) {
          console.log(`[GupshupProfile] PUT failed with ${status}. Falling back to POST...`);
          const response = await this.partnerClient.post(
            `/partner/app/${appId}/business/profile`,
            sanitizedPayload,
            {
              headers,
              timeout: 15000,
            }
          );
          return response.data;
        }
        throw error;
      }
    });
  }
}
