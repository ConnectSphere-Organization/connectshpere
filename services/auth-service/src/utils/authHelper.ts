import express from 'express';
import jwt from 'jsonwebtoken';
import http from 'http';
import config from '../config/index.js';
import { User, Workspace, Permission, SystemSettings } from '../models/index.js';
import { deriveNextStep } from '../services/auth-next-step.js';

export const sanitizeUser = (user: any) => {
  const obj = user?.toObject ? user.toObject() : user;
  if (!obj) return null;
  const { passwordHash, ...rest } = obj;
  return rest;
};

export const normalizeEmail = (email: string) => String(email).toLowerCase().trim();

export const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

export const createAuthToken = (user: any) =>
  jwt.sign({
    id: String(user._id),
    email: user.email,
    role: user.role || 'owner',
    workspaceId: user.activeWorkspace
      ? String(user.activeWorkspace)
      : user.workspace
        ? String(user.workspace)
        : undefined,
  }, config.jwtSecret, { expiresIn: config.authTokenTtl as any });

export const setAuthCookie = (res: express.Response, token: string) => {
  const isProd = config.env === 'production' || process.env.NODE_ENV === 'production';
  res.cookie(config.authCookieName, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: config.authCookieMaxAgeMs,
  });
};

export const clearAuthCookie = (res: express.Response) => {
  res.clearCookie(config.authCookieName, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: config.env === 'production' ? 'none' : 'lax',
    path: '/',
  });
};

export const extractToken = (req: express.Request): string | null => {
  const cookieToken = req.cookies?.[config.authCookieName];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
};

export async function ensureWorkspaceMembership(user: any) {
  let workspaceId = user.activeWorkspace || user.workspace;

  if (workspaceId) {
    return workspaceId;
  }

  const workspaceName = user.name ? `${user.name}'s Workspace` : 'My Workspace';
  const workspace = await Workspace.create({
    name: workspaceName,
    owner: user._id,
  });

  await Permission.create({
    workspace: workspace._id,
    user: user._id,
    role: 'owner',
    permissions: (Permission as any).getDefaultPermissions('owner'),
    isActive: true,
  });

  user.workspace = workspace._id;
  user.activeWorkspace = workspace._id;
  await user.save();

  return workspace._id;
}

export async function buildSessionPayload(user: any) {
  const workspaceId = await ensureWorkspaceMembership(user);
  const workspace: any = await Workspace.findById(workspaceId).populate('plan');
  const permission: any = await Permission.findOne({
    workspace: workspaceId,
    user: user._id,
    isActive: { $ne: false },
  });

  const systemSettings = await (SystemSettings as any).getSettings();

  const normalizeWorkspaceWallet = (wallet: any) => {
    const rawBalance = Number(wallet?.availableBalance ?? wallet?.balance ?? 0);
    const balance = wallet?.availableBalance !== undefined || Number.isInteger(rawBalance) && Math.abs(rawBalance) >= 10000
      ? rawBalance / 100
      : rawBalance;

    return {
      ...(wallet || {}),
      balance,
      thresholdAmount: wallet?.thresholdAmount || 500,
      currency: wallet?.currency || 'INR',
      isServiceDown: false,
    };
  };

  // Fetch live wallet balance from billing-service (non-blocking, falls back on error)
  let liveWallet = normalizeWorkspaceWallet(workspace?.wallet);
  try {
    const billingServiceUrl = (config as any).billingServiceUrl || 'http://localhost:3003';
    const response = await fetch(`${billingServiceUrl}/api/billing/wallets/${workspaceId}`, {
      headers: { 'x-internal-service-secret': (config as any).internalServiceSecret || '' },
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const walletData: any = await response.json();
      if (walletData?.wallet) {
        liveWallet = {
          balance: walletData.wallet.availableBalance / 100,  // paise → rupees
          thresholdAmount: workspace?.wallet?.thresholdAmount || 500,
          currency: walletData.wallet.currency || 'INR',
          isServiceDown: false,
        };
      }
    } else {
      console.warn(`[AuthHelper] Billing service returned HTTP ${response.status} for workspace ${workspaceId}. Falling back to workspace.wallet.`);
    }
  } catch (err: any) {
    console.warn(`[AuthHelper] Live wallet fetch from billing-service failed (${(config as any).billingServiceUrl || 'http://localhost:3003'}): ${err.message}. Falling back to workspace.wallet.`);
  }

  const stage1Complete = !!(
    (workspace?.bspWabaId &&
      (workspace?.bspPhoneNumberId || workspace?.phoneNumberId) &&
      workspace?.bspPhoneStatus === 'CONNECTED') ||
    workspace?.whatsappConnected ||
    workspace?.onboarding?.wabaConnectionCompleted ||
    workspace?.onboarding?.completed ||
    workspace?.onboardingStatus === 'completed'
  );


  const nextStep = deriveNextStep(user, workspace);
  // A workspace-level feature list is an explicit Super Admin override. When
  // it is absent, the workspace inherits the selected plan's feature list.
  // Always return the complete plan to the customer portal so its feature
  // gates can evaluate the effective entitlement rather than falling back to
  // the generic starter plan.
  const planData = workspace?.plan?.toObject?.() || workspace?.plan;
  const planLimits = workspace?.planLimits || workspace?.limits || {};
  const overriddenFeatures = Array.isArray(planLimits?.features) ? planLimits.features : null;
  const effectivePlan = planData && typeof planData === 'object'
    ? {
      ...planData,
      slug: planData.slug || planData.code || String(planData.name || 'free').toLowerCase(),
      features: overriddenFeatures || (Array.isArray(planData.features) ? planData.features : []),
    }
    : planData || 'free';

  return {
    authenticated: true,
    user: {
      id: user._id,
      name: user.name,
      email: user.email || null,
      phone: user.phone || null,
      role: user.role,
      team: user.team || null,
      emailVerified: !!user.emailVerified,
      phoneVerified: !!user.phoneVerified,
      authProvider: user.authProvider || 'local',
      accountStatus: user.accountStatus || 'AWAITING_EMAIL_VERIFICATION',
      createdAt: user.createdAt
    },
    workspace: workspace ? {
      id: workspace._id,
      _id: workspace._id,
      name: workspace.name,
      plan: effectivePlan,
      billingStatus: workspace.billingStatus || 'trialing',
      whatsappConnected: workspace.whatsappConnected || stage1Complete,
      stage1: {
        complete: stage1Complete,
        phoneStatus: workspace.bspPhoneStatus || (workspace.whatsappConnected ? 'CONNECTED' : 'NOT_CONNECTED')
      },
      address: workspace.address,
      city: workspace.city,
      state: workspace.state,
      country: workspace.country,
      zipCode: workspace.zipCode,
      industry: workspace.industry,
      website: workspace.website,
      business: workspace.business,
      businessDocuments: workspace.businessDocuments,
      businessVerification: workspace.businessVerification,
      wallet: liveWallet,
      role: permission?.role || user.role || 'owner'
    } : null,
    phone: {
      number: user.phone,
      verified: !!user.phoneVerified
    },
    role: permission?.role || user.role || 'owner',
    permissions: permission?.permissions || null,
    nextStep,
    accessRestriction: null,
    systemStatus: {
      maintenanceMode: !!systemSettings?.maintenanceMode,
      systemNotice: systemSettings?.systemNotice || null,
      features: systemSettings?.features || {}
    },
    isImpersonating: false,
  };
}

export async function resolveUserFromToken(token: string) {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
  if (!decoded?.id) return null;
  return User.findById(decoded.id);
}
