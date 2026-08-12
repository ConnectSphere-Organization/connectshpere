import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { Integration } from '../models';
import { GoogleSheetsService } from '../services/integrations/google-sheets-service';
import { PetpoojaService } from '../services/integrations/petpooja-service';
import { MetaAdsService } from '../services/integrations/meta-ads-service';
import mongoose from 'mongoose';

function getApiOrigin(req: AuthRequest) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0];
  const proto = forwardedProto || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function getCustomerPortalOrigin(req: AuthRequest) {
  return (
    process.env.CUSTOMER_PORTAL_URL ||
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    (typeof req.headers.origin === 'string' ? req.headers.origin : '') ||
    (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : getApiOrigin(req))
  ).replace(/\/$/, '');
}

function getReturnTo(req: AuthRequest) {
  const origin = getCustomerPortalOrigin(req);
  return `${origin}/integrations?google=connected`;
}

function getMetaAdsReturnTo(req: AuthRequest, status = 'connected') {
  const origin = getCustomerPortalOrigin(req);
  return `${origin}/integrations?meta_ads=${status}`;
}

function getMetaAdsRedirectUri(req: AuthRequest) {
  return process.env.META_ADS_REDIRECT_URI || `${getApiOrigin(req)}/api/v1/integrations/meta-ads/callback`;
}

function sanitizeRedirectUrl(targetUrl: string, fallback: string = '/'): string {
  if (!targetUrl || typeof targetUrl !== 'string') return fallback;
  if (targetUrl.startsWith('/') && !targetUrl.startsWith('//')) {
    return targetUrl;
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return targetUrl;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function sendMetaAdsError(res: Response, err: any) {
  const message = err?.response?.data?.error?.message || err?.message || 'Meta Ads request failed';
  const notConfigured = message.includes('META_ADS_CLIENT_ID') || message.includes('META_ADS_CLIENT_SECRET') || message.includes('not configured');
  return res.status(notConfigured ? 409 : 500).json({
    success: false,
    code: notConfigured ? 'META_ADS_NOT_CONFIGURED' : 'META_ADS_ERROR',
    message,
  });
}

async function getMetaAdsTokenForWorkspace(workspaceId: any) {
  const integration = await (Integration as any).findOne({
    workspace: workspaceId,
    type: 'meta_ads'
  }).select('+config');

  if (!integration || integration.status !== 'connected') {
    const error = new Error('Meta Ads is not connected.');
    (error as any).statusCode = 404;
    throw error;
  }

  const storedConfig = integration.getDecryptedConfig?.() || {};
  const accessToken = storedConfig?.tokens?.accessToken;
  if (!accessToken) {
    const error = new Error('Meta Ads token is missing. Reconnect Meta Ads.');
    (error as any).statusCode = 400;
    throw error;
  }

  return { integration, storedConfig, accessToken };
}

function getWorkspaceId(req: AuthRequest) {
  return req.workspace?.id || req.workspace?._id;
}

function paginationQuery(query: any) {
  return {
    limit: query.limit,
    after: query.after,
    before: query.before,
    since: query.since,
    until: query.until,
  };
}

function routeParam(value: unknown) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export const integrationController = {
  /**
   * List all integrations
   */
  async listIntegrations(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integrations = await (Integration as any).find({ workspace: workspaceId }).select('+config');
      res.json({
        success: true,
        integrations: integrations.map((integration: any) =>
          integration.toSafeJSON ? integration.toSafeJSON() : integration
        )
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Server Error" });
    }
  },

  /**
   * Connect/create integration
   */
  async connect(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const type = req.params.type || req.body.type;
      const { config, isActive } = req.body;

      let integration = await (Integration as any).findOne({ workspace: workspaceId, type }).select('+config');
      if (!integration) {
        integration = new (Integration as any)({
          workspace: workspaceId,
          type,
          name: type === 'google_sheets' ? 'Google Sheets' : type === 'petpooja' ? 'Petpooja POS' : type,
          status: 'connected',
          createdBy: req.user?._id || req.user?.id
        });
      }

      if (config) {
        (integration as any).setEncryptedConfig(config);
      }
      integration.status = 'connected';
      integration.updatedBy = req.user?._id || req.user?.id;
      await integration.save();

      res.json({ success: true, integration });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Server Error" });
    }
  },

  /**
   * Disconnect/remove integration
   */
  async disconnect(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const id = req.params.id as string;
      const query: any = { workspace: workspaceId, $or: [{ type: id }] };
      if (mongoose.Types.ObjectId.isValid(id)) {
        query.$or.push({ _id: id });
      }

      await (Integration as any).findOneAndDelete(query);
      res.json({ success: true, message: "Integration removed" });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Server Error" });
    }
  },

  async syncIntegration(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const { type } = req.params;
      let syncResult: any = null;

      if (type === 'google_sheets') {
        syncResult = await GoogleSheetsService.syncRows(String(workspaceId));
      } else if (type === 'petpooja') {
        syncResult = await PetpoojaService.syncOrders(String(workspaceId));
      } else {
        const integration = await (Integration as any).findOne({ workspace: workspaceId, type }).select('+config');
        if (integration?.markSynced) {
          await integration.markSynced(0);
          syncResult = integration.toSafeJSON?.() || integration;
        }
      }

      res.json({
        success: true,
        message: `${type} sync completed`,
        data: syncResult
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * Google Sheets - List Spreadsheets
   */
  async listGoogleSpreadsheets(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'google_sheets'
      }).select('+config');

      if (!integration) return res.json({ files: [] });

      const files = await GoogleSheetsService.listSpreadsheets(integration);
      res.json({ files });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async getGoogleStatus(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'google_sheets'
      });

      res.json({
        connected: integration?.status === 'connected',
        status: integration?.status || 'disconnected',
        integration: integration ? ((integration as any).toSafeJSON ? (integration as any).toSafeJSON() : integration) : null
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async getGoogleConfig(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'google_sheets'
      }).select('+config');

      res.json({
        success: true,
        config: integration?.configMetadata || {},
        connected: integration?.status === 'connected'
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async saveGoogleConfig(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      let integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'google_sheets'
      }).select('+config');

      if (!integration) {
        integration = new (Integration as any)({
          workspace: workspaceId,
          type: 'google_sheets',
          name: 'Google Sheets',
          status: 'pending',
          syncDirection: 'pull',
          syncInterval: 15,
          createdBy: req.user?._id || req.user?.id
        });
        (integration as any).setEncryptedConfig({});
      }

      const { spreadsheetId, sheetName, syncExisting = false } = req.body || {};
      if (!spreadsheetId || !sheetName) {
        return res.status(400).json({ message: 'Spreadsheet and sheet are required' });
      }

      const columns = await GoogleSheetsService.getColumns(String(workspaceId), spreadsheetId, sheetName);
      const rows = await GoogleSheetsService.fetchAllRows(String(workspaceId), spreadsheetId, sheetName);
      const currentLastRow = rows.length ? rows[rows.length - 1].__rowNumber : 1;

      integration.status = 'connected';
      integration.configMetadata = {
        ...(integration.configMetadata || {}),
        spreadsheetId,
        sheetName,
        columns,
        lastProcessedRow: syncExisting ? 1 : currentLastRow,
        syncExisting: Boolean(syncExisting),
        configuredAt: new Date()
      };
      integration.updatedBy = req.user?._id || req.user?.id;
      await integration.save();

      res.json({ success: true, config: integration.configMetadata });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async listGoogleSheets(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const spreadsheetId = (req.params.id as string) || (req.query.spreadsheetId as string);
      if (!spreadsheetId) return res.status(400).json({ message: 'Spreadsheet ID is required' });

      const sheets = await GoogleSheetsService.listSheets(String(workspaceId), spreadsheetId);
      res.json({ sheets });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async listGoogleColumns(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const columns = await GoogleSheetsService.getColumns(
        workspaceId.toString(),
        req.params.id as string,
        (req.query.sheetName as string) || ''
      ).catch(() => []);


      res.json({ columns });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async googleCallback(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const { code, state } = req.query;
      if (!code) return res.status(400).json({ message: 'Missing Google authorization code' });

      const parsedState = GoogleSheetsService.parseState(state);
      if (parsedState.workspaceId && String(parsedState.workspaceId) !== String(workspaceId)) {
        return res.status(403).json({ message: 'Google authorization state does not match this workspace' });
      }

      const redirectUri = parsedState.redirectUri || process.env.GOOGLE_REDIRECT_URI || `${getApiOrigin(req)}/api/v1/integrations/google/callback`;
      const tokens = await GoogleSheetsService.exchangeCode(String(code), redirectUri);

      let integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'google_sheets'
      }).select('+config');

      if (!integration) {
        integration = new (Integration as any)({
          workspace: workspaceId,
          type: 'google_sheets',
          name: 'Google Sheets',
          syncDirection: 'pull',
          syncInterval: 15,
          createdBy: req.user?._id || req.user?.id
        });
      }

      integration.status = 'connected';
      integration.configMetadata = {
        ...(integration.configMetadata || {}),
        connectedAt: new Date(),
        googleScope: tokens.scope,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined
      };
      integration.credentials = {
        isExpiring: Boolean(tokens.expiry_date),
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        needsReauth: !tokens.refresh_token,
      };
      (integration as any).setEncryptedConfig({ tokens, connectedAt: new Date().toISOString() });
      await integration.save();

      const safeReturnTo = sanitizeRedirectUrl(parsedState.returnTo || getReturnTo(req));
      res.redirect(safeReturnTo);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  /**
   * Google Auth URL
   */
  async getGoogleAuthUrl(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${getApiOrigin(req)}/api/v1/integrations/google/callback`;
      const url = GoogleSheetsService.generateAuthUrl({
        workspaceId: String(workspaceId),
        userId: req.user?._id || req.user?.id,
        redirectUri,
        returnTo: getReturnTo(req),
      });

      res.json({ url });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async getMetaAdsStatus(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'meta_ads'
      });

      const safe = integration ? ((integration as any).toSafeJSON ? (integration as any).toSafeJSON() : integration) : null;
      res.json({
        connected: integration?.status === 'connected',
        configured: Boolean(integration?.configMetadata?.selected?.adAccountId),
        status: integration?.status || 'disconnected',
        integration: safe,
        scopes: MetaAdsService.getScopes(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  },

  async getMetaAdsAuthUrl(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const redirectUri = getMetaAdsRedirectUri(req);
      const url = MetaAdsService.generateAuthUrl({
        workspaceId: String(workspaceId),
        userId: req.user?._id || req.user?.id,
        redirectUri,
        returnTo: getMetaAdsReturnTo(req),
        forceReauth: req.query.force === '1',
      });

      res.json({ url, scopes: MetaAdsService.getScopes() });
    } catch (err: any) {
      return sendMetaAdsError(res, err);
    }
  },

  async metaAdsCallback(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const { code, state, error, error_description } = req.query;
      const parsedState = MetaAdsService.parseState(state);
      const returnTo = parsedState.returnTo || getMetaAdsReturnTo(req);

      if (error) {
        const dest = `${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(String(error_description || error))}`;
        return res.redirect(sanitizeRedirectUrl(dest));
      }

      if (!code) return res.status(400).json({ message: 'Missing Meta authorization code' });
      if (parsedState.workspaceId && String(parsedState.workspaceId) !== String(workspaceId)) {
        return res.status(403).json({ message: 'Meta Ads authorization state does not match this workspace' });
      }

      const redirectUri = parsedState.redirectUri || getMetaAdsRedirectUri(req);
      const shortLivedToken = await MetaAdsService.exchangeCode(String(code).replace(/#_$/, ''), redirectUri);
      const longLivedToken = await MetaAdsService.exchangeForLongLivedToken(shortLivedToken.accessToken);
      const discovered = await MetaAdsService.discoverAssets(longLivedToken.accessToken);

      let integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'meta_ads'
      }).select('+config');

      if (!integration) {
        integration = new (Integration as any)({
          workspace: workspaceId,
          type: 'meta_ads',
          name: 'Meta Ads',
          syncDirection: 'pull',
          syncInterval: 60,
          createdBy: req.user?._id || req.user?.id
        });
      }

      const tokenExpiresAt = longLivedToken.expiresAt;
      const existingConfig = integration.getDecryptedConfig?.() || {};
      integration.status = 'connected';
      integration.configMetadata = {
        ...(integration.configMetadata || {}),
        connectedAt: new Date(),
        metaUser: discovered.profile ? {
          id: discovered.profile.id,
          name: discovered.profile.name,
          email: discovered.profile.email,
        } : undefined,
        tokenExpiresAt,
        requestedScopes: MetaAdsService.getScopes(),
        grantedScopes: discovered.debugToken?.scopes || discovered.debugToken?.granular_scopes,
        assets: MetaAdsService.toSafeAssets(discovered),
        selected: integration.configMetadata?.selected || {},
      };
      integration.credentials = {
        isExpiring: Boolean(tokenExpiresAt),
        expiresAt: tokenExpiresAt,
        needsReauth: false,
      };
      integration.updatedBy = req.user?._id || req.user?.id;
      integration.lastError = undefined;
      (integration as any).setEncryptedConfig({
        ...existingConfig,
        tokens: {
          accessToken: longLivedToken.accessToken,
          tokenType: longLivedToken.tokenType,
          expiresIn: longLivedToken.expiresIn,
          expiresAt: tokenExpiresAt?.toISOString(),
        },
        assets: discovered,
        selected: existingConfig.selected || {},
        connectedAt: new Date().toISOString(),
      });
      await integration.save();

      const successDest = `${returnTo.replace(/meta_ads=connected/g, 'meta_ads=connected')}`;
      res.redirect(sanitizeRedirectUrl(successDest));
    } catch (err: any) {
      res.status(500).json({ message: err?.response?.data?.error?.message || err.message });
    }
  },

  async refreshMetaAdsAssets(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'meta_ads'
      }).select('+config');

      if (!integration) return res.status(404).json({ message: 'Meta Ads is not connected.' });
      const storedConfig = integration.getDecryptedConfig?.() || {};
      const accessToken = storedConfig?.tokens?.accessToken;
      if (!accessToken) return res.status(400).json({ message: 'Meta Ads token is missing. Reconnect Meta Ads.' });

      const discovered = await MetaAdsService.discoverAssets(accessToken);
      integration.configMetadata = {
        ...(integration.configMetadata || {}),
        assets: MetaAdsService.toSafeAssets(discovered),
        lastAssetRefreshAt: new Date(),
      };
      (integration as any).setEncryptedConfig({
        ...storedConfig,
        assets: discovered,
      });
      await integration.markSynced(0);

      res.json({ success: true, integration: integration.toSafeJSON?.() || integration });
    } catch (err: any) {
      res.status(500).json({ message: err?.response?.data?.error?.message || err.message });
    }
  },

  async saveMetaAdsConfig(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'meta_ads'
      }).select('+config');

      if (!integration) return res.status(404).json({ message: 'Connect Meta Ads before configuring assets.' });

      const selected = MetaAdsService.normalizeSelectedConfig(req.body || {});
      if (!selected.adAccountId) return res.status(400).json({ message: 'Ad account is required.' });
      if (!selected.pageId) return res.status(400).json({ message: 'Facebook Page is required.' });
      if (!selected.whatsappPhoneNumberId && !selected.whatsappPhoneNumber) {
        return res.status(400).json({ message: 'WhatsApp phone number is required.' });
      }

      const assets = integration.configMetadata?.assets || {};
      const matchingAccount = (assets.adAccounts || []).find((account: any) =>
        account.id === selected.adAccountId || `act_${account.account_id}` === selected.adAccountId
      );
      const matchingPage = (assets.pages || []).find((page: any) => page.id === selected.pageId);
      const matchingPhone = selected.whatsappPhoneNumberId
        ? (assets.whatsappPhoneNumbers || []).find((phone: any) => phone.id === selected.whatsappPhoneNumberId)
        : undefined;
      const matchingCatalog = selected.productCatalogId
        ? (assets.productCatalogs || []).find((catalog: any) => catalog.id === selected.productCatalogId)
        : undefined;
      const matchingProductSet = selected.productSetId
        ? (assets.productSets || []).find((productSet: any) => productSet.id === selected.productSetId)
        : undefined;

      if (selected.productSetId && !selected.productCatalogId) {
        return res.status(400).json({ message: 'Choose a product catalog before choosing a product set.' });
      }
      if (selected.productSetId && matchingProductSet?.productCatalogId && matchingProductSet.productCatalogId !== selected.productCatalogId) {
        return res.status(400).json({ message: 'Selected product set does not belong to the selected catalog.' });
      }

      const storedConfig = integration.getDecryptedConfig?.() || {};
      integration.configMetadata = {
        ...(integration.configMetadata || {}),
        selected: {
          ...selected,
          adAccountName: matchingAccount?.name,
          pageName: matchingPage?.name,
          whatsappDisplayPhoneNumber: matchingPhone?.display_phone_number,
          productCatalogName: matchingCatalog?.name,
          productSetName: matchingProductSet?.name,
          configuredAt: new Date(),
        },
      };
      integration.status = 'connected';
      integration.updatedBy = req.user?._id || req.user?.id;
      (integration as any).setEncryptedConfig({
        ...storedConfig,
        selected,
      });
      await integration.save();

      res.json({ success: true, integration: integration.toSafeJSON?.() || integration });
    } catch (err: any) {
      res.status(400).json({ message: err?.response?.data?.error?.message || err.message });
    }
  },

  async listMetaCatalogProducts(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const catalogId = String(req.params.catalogId || req.query.catalogId || '').trim();
      if (!catalogId) return res.status(400).json({ message: 'Product catalog is required.' });

      const { accessToken } = await getMetaAdsTokenForWorkspace(workspaceId);
      const result = await MetaAdsService.listCatalogProducts(accessToken, catalogId, Number(req.query.limit || 50));
      res.json({ success: true, data: result.data?.data || [], paging: result.data?.paging, metaRequestId: result.metaRequestId });
    } catch (err: any) {
      res.status(err?.statusCode || 500).json({ message: err?.response?.data?.error?.message || err.message });
    }
  },

  async syncMetaCatalogProduct(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const catalogId = String(req.params.catalogId || req.body?.catalogId || '').trim();
      if (!catalogId) return res.status(400).json({ message: 'Product catalog is required.' });

      const { accessToken } = await getMetaAdsTokenForWorkspace(workspaceId);
      const result = await MetaAdsService.syncCatalogProduct(accessToken, catalogId, req.body?.product || req.body || {});
      res.json({
        success: true,
        action: result.action,
        retailerId: result.retailerId,
        data: result.data,
        metaRequestId: result.metaRequestId,
      });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({
        message: err?.response?.data?.error?.message || err.message,
        error: err?.response?.data?.error,
      });
    }
  },

  async createMetaProductSet(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const catalogId = String(req.params.catalogId || req.body?.catalogId || '').trim();
      if (!catalogId) return res.status(400).json({ message: 'Product catalog is required.' });

      const { accessToken } = await getMetaAdsTokenForWorkspace(workspaceId);
      const result = await MetaAdsService.createProductSet(accessToken, catalogId, {
        name: String(req.body?.name || '').trim(),
        filter: req.body?.filter,
      });
      res.json({ success: true, data: result.data, metaRequestId: result.metaRequestId });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({
        message: err?.response?.data?.error?.message || err.message,
        error: err?.response?.data?.error,
      });
    }
  },

  async getInternalMetaAdsConfig(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.params.workspaceId;
      const integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'meta_ads'
      }).select('+config');

      if (!integration || integration.status !== 'connected') {
        return res.status(404).json({ success: false, message: 'Meta Ads is not connected for this workspace.' });
      }

      const storedConfig = integration.getDecryptedConfig?.() || {};
      const selected = storedConfig.selected || integration.configMetadata?.selected || {};
      if (!storedConfig?.tokens?.accessToken || !selected?.adAccountId) {
        return res.status(409).json({ success: false, message: 'Meta Ads is connected but not configured.' });
      }

      res.json({
        success: true,
        data: {
          accessToken: storedConfig.tokens.accessToken,
          tokenExpiresAt: storedConfig.tokens.expiresAt,
          selected,
          metadata: integration.configMetadata || {},
        }
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * Petpooja Connect
   */
  async connectPetpooja(req: AuthRequest, res: Response) {
    try {
      const workspaceId = req.workspace?.id || req.workspace?._id;
      const credentials = PetpoojaService.normalizeCredentials(req.body || {});

      const isValid = await PetpoojaService.validateCredentials(credentials);
      if (!isValid) return res.status(400).json({ message: 'Invalid Petpooja credentials' });

      let integration = await (Integration as any).findOne({
        workspace: workspaceId,
        type: 'petpooja'
      });

      if (!integration) {
        integration = new (Integration as any)({
          workspace: workspaceId,
          type: 'petpooja',
          name: 'Petpooja POS',
          syncDirection: 'pull',
          syncInterval: 5,
          createdBy: req.user?._id || req.user?.id
        });
      }

      (integration as any).setEncryptedConfig(credentials);
      integration.configMetadata = {
        credentialMode: credentials.appKey ? 'official' : 'legacy',
        restId: credentials.restId,
        vendorId: credentials.vendorId,
        connectedAt: new Date()
      };
      integration.status = 'connected';
      integration.updatedBy = req.user?._id || req.user?.id;
      await integration.save();

      res.json({ success: true, message: 'Petpooja connected successfully', integration: integration.toSafeJSON?.() || integration });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  }
};
