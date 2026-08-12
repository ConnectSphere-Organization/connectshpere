import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { extractInternalIdentityToken, verifyInternalIdentity } from '@wapi/contracts';

const JWT_SECRET = config.jwtSecret;
const INTERNAL_SECRET = config.internalServiceSecret;

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
 * Supports both direct JWT verification and Header-based Auth (from Gateway).
 */
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const internalToken = extractInternalIdentityToken(req.header('x-internal-auth'));
  if (internalToken) {
    try {
      const claims = verifyInternalIdentity(internalToken, INTERNAL_SECRET, 'campaign');
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

  if (gatewayUserId && internalSecret === INTERNAL_SECRET) {
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

  // 2. Development-only fallback: Direct JWT Verification
  const authHeader = req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

  if (!token) {
    return res.status(401).json({ message: 'Authorization denied: No token or headers provided' });
  }

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET as string, { algorithms: ['HS256'] });
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

/**
 * Middleware for secure inter-service communication.
 */
export const internalAuth = (req: Request, res: Response, next: NextFunction) => {
  const secret = req.header('x-internal-service-secret');

  if (!secret) {
    console.warn(`[Campaign InternalAuth] Missing secret for ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ message: 'Unauthorized: Internal service secret missing or invalid' });
  }

  if (secret !== INTERNAL_SECRET) {
    console.warn(`[Campaign InternalAuth] Invalid secret for ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ message: 'Unauthorized: Internal service secret missing or invalid' });
  }

  next();
};
