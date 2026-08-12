import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { extractInternalIdentityToken, verifyInternalIdentity } from '@wapi/contracts';

const JWT_SECRET = config.jwtSecret;
const INTERNAL_SECRET = config.internalServiceSecret;

function safeEqualSecret(provided: string | undefined): boolean {
  if (!provided || !INTERNAL_SECRET) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(INTERNAL_SECRET, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The startup check is handled by the config module, but we double-check here
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required for billing-service.');
  process.exit(1);
}

export interface AuthRequest extends Request {
  user?: any;
  workspace?: any;
  role?: string;
  permissions?: string[];
  isImpersonating?: boolean;
}

function parseGatewayPermissions(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

/**
 * Middleware to handle authentication.
 * Supports both Gateway Headers and Direct JWT.
 */
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const internalToken = extractInternalIdentityToken(req.header('x-internal-auth'));
  if (internalToken) {
    try {
      const claims = verifyInternalIdentity(internalToken, INTERNAL_SECRET, 'billing');
      req.user = { id: claims.sub, _id: claims.sub, role: claims.systemRole };
      req.workspace = { id: claims.workspaceId, _id: claims.workspaceId };
      req.role = claims.workspaceRole;
      req.permissions = claims.permissions;
      req.isImpersonating = !!claims.impersonating;
      return next();
    } catch {
      return res.status(401).json({ success: false, error: { code: 'INVALID_INTERNAL_IDENTITY', message: 'Gateway identity assertion is invalid' } });
    }
  }
  // 1. Check for Gateway Headers (Standard for Microservices - secured with internal secret signature verification)
  const gatewayUserId = req.header('x-user-id');
  const gatewayWorkspaceId = req.header('x-workspace-id');
  const gatewayRole = req.header('x-user-role');
  const gatewaySystemRole = req.header('x-user-system-role');
  const gatewayPermissions = parseGatewayPermissions(req.header('x-permissions') || undefined);
  const internalSecret = req.header('x-internal-service-secret');

  if (gatewayUserId && safeEqualSecret(internalSecret)) {
    req.user = {
      id: gatewayUserId,
      _id: gatewayUserId,
      role: gatewaySystemRole || gatewayRole || 'user'
    };
    req.role = gatewayRole || 'agent';
    req.permissions = gatewayPermissions;
    req.isImpersonating = req.header('x-impersonating') === 'true';

    if (gatewayWorkspaceId) {
      req.workspace = {
        id: gatewayWorkspaceId,
        _id: gatewayWorkspaceId
      };
    }
    return next();
  }


  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DIRECT_SERVICE_JWT !== 'true') {
    return res.status(401).json({ success: false, error: { code: 'GATEWAY_IDENTITY_REQUIRED', message: 'Production requests must pass through the API gateway' } });
  }

  // 2. Development-only Authorization Bearer fallback
  const authHeader = req.header('Authorization');
  let token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

  // 3. Fallback: read auth_token from Cookie header (browser sends cookies via withCredentials)
  if (!token) {
    const cookieHeader = req.header('cookie') || '';
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
    if (match) token = match.slice('auth_token='.length);
  }

  if (!token) {
    return res.status(401).json({ message: 'Authorization denied: No token or headers provided' });
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = {
      id: decoded.id,
      _id: decoded.id,
      role: decoded.role || 'agent'
    };
    req.role = decoded.role || 'agent';
    req.permissions = [];

    if (decoded.workspaceId) {
      req.workspace = {
        id: decoded.workspaceId,
        _id: decoded.workspaceId
      };
    }
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

/**
 * Middleware for secure inter-service communication. Uses constant-time
 * compare so the secret can't be probed via timing.
 */
export const internalAuth = (req: Request, res: Response, next: NextFunction) => {
  const provided = req.header('x-internal-service-secret');
  if (!safeEqualSecret(provided)) {
    console.warn(`[Billing InternalAuth] Rejecting ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ message: 'Unauthorized: Internal service secret missing or invalid' });
  }
  next();
};

/**
 * Middleware for endpoints that are used by both the gateway and internal services.
 */
export const authenticateOrInternal = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (safeEqualSecret(req.header('x-internal-service-secret'))) {
    req.user = { id: 'internal-service', _id: 'internal-service', role: 'system' };
    req.role = 'system';
    const workspaceParam = req.params.workspaceId;
    const workspaceId = (Array.isArray(workspaceParam) ? workspaceParam[0] : workspaceParam) || req.header('x-workspace-id');
    if (workspaceId) {
      req.workspace = { id: workspaceId, _id: workspaceId };
    }
    return next();
  }

  return authenticate(req, res, next);
};

/**
 * Middleware to restrict access by role.
 */
export const authorize = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === 'super_admin' || (req.role && roles.includes(req.role))) {
      return next();
    }
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'Permission denied: You do not have the required role'
      });
    }
    next();
  };
};

export const requirePermission = (permission: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === 'super_admin' || req.role === 'owner' || req.permissions?.includes(permission)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: `Forbidden: Missing required permission: ${permission}`,
      errorCode: 'INSUFFICIENT_PERMISSIONS'
    });
  };
};
