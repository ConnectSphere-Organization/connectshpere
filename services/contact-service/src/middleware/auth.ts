import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { extractInternalIdentityToken, verifyInternalIdentity } from '@wapi/contracts';

const JWT_SECRET = config.jwtSecret;

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
 * Middleware to authenticate requests.
 * Supports:
 * 1. Gateway headers (x-user-id, x-workspace-id, x-user-role)
 * 2. Shared database cookie lookup (auth_token) or Authorization header
 */
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const internalToken = extractInternalIdentityToken(req.header('x-internal-auth'));
    if (internalToken) {
      try {
        const claims = verifyInternalIdentity(internalToken, config.internalServiceSecret, 'contact');
        req.user = { id: claims.sub, _id: new mongoose.Types.ObjectId(claims.sub), role: claims.systemRole };
        req.workspace = { id: claims.workspaceId, _id: new mongoose.Types.ObjectId(claims.workspaceId) };
        req.role = claims.workspaceRole;
        req.permissions = claims.permissions;
        req.isImpersonating = !!claims.impersonating;
        return next();
      } catch {
        return res.status(401).json({ success: false, error: { code: 'INVALID_INTERNAL_IDENTITY', message: 'Gateway identity assertion is invalid' } });
      }
    }
    // 1. Gateway Headers (Priority - secured with internal secret signature verification)
    const gatewayUserId = req.header('x-user-id');
    const gatewayWorkspaceId = req.header('x-workspace-id');
    const gatewayRole = req.header('x-user-role');
    const gatewaySystemRole = req.header('x-user-system-role');
    const gatewayPermissions = parseGatewayPermissions(req.header('x-permissions') || undefined);
    const internalSecret = req.header('x-internal-service-secret');
    const expectedSecret = config.internalServiceSecret;

    if (gatewayUserId && internalSecret === expectedSecret) {
      req.user = {
        id: gatewayUserId,
        _id: new mongoose.Types.ObjectId(gatewayUserId),
        role: gatewaySystemRole || gatewayRole || 'user'
      };
      req.role = gatewayRole || 'agent';
      req.permissions = gatewayPermissions;
      req.isImpersonating = req.header('x-impersonating') === 'true';

      if (gatewayWorkspaceId) {
        req.workspace = {
          id: gatewayWorkspaceId,
          _id: new mongoose.Types.ObjectId(gatewayWorkspaceId)
        };
      }
      return next();
    }


    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DIRECT_SERVICE_JWT !== 'true') {
      return res.status(401).json({ success: false, error: { code: 'GATEWAY_IDENTITY_REQUIRED', message: 'Production requests must pass through the API gateway' } });
    }

    // 2. Development-only direct JWT fallback
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authorization denied: No token or gateway headers provided'
      });
    }

    // Decode JWT token
    const decoded: any = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const userId = decoded.id;

    const db = mongoose.connection.db;
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database connection not initialized' });
    }

    // Direct MongoDB connection query to resolve current active workspace
    const user = await db.collection('users').findOne({
      _id: new mongoose.Types.ObjectId(userId)
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'User session not found' });
    }

    const workspaceId = user.activeWorkspace || user.workspace;

    req.user = {
      id: userId,
      _id: new mongoose.Types.ObjectId(userId),
      role: user.role || decoded.role || 'agent'
    };
    req.role = user.role || decoded.role || 'agent';
    req.permissions = [];

    if (workspaceId) {
      req.workspace = {
        id: String(workspaceId),
        _id: new mongoose.Types.ObjectId(workspaceId)
      };
    }
    next();
  } catch (err: any) {
    return res.status(401).json({
      success: false,
      message: 'Authentication failed',
      error: err.message
    });
  }
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
