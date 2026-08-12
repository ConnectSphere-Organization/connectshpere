import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthRequest extends Request {
  workspace?: { _id: string; [key: string]: unknown };
  user?: { _id: string; [key: string]: unknown };
  role?: string;
}

@Injectable()
export class WorkspaceAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();

    // 1. Check for internal service credentials bypass
    const secret = request.headers['x-internal-secret'] || request.headers['x-internal-service-secret'];
    const service = request.headers['x-internal-service'];

    if (service && secret === config.internalServiceSecret) {
      const workspaceId = request.headers['x-workspace-id'] as string;
      const userId = request.headers['x-user-id'] as string;
      const role = request.headers['x-user-role'] as string;

      if (!workspaceId) {
        throw new UnauthorizedException('x-workspace-id header required for internal bypass');
      }

      request.user = userId ? { _id: userId } : undefined;
      request.workspace = { _id: workspaceId };
      request.role = role;
      return true;
    }

    const jwtSecret = config.jwtSecret;

    try {
      const token = this.extractToken(request);
      if (!token) {
        throw new UnauthorizedException('No token provided');
      }

      const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as any;

      if (!decoded.id && !decoded.workspaceId && !decoded.userId) {
        throw new UnauthorizedException('Invalid token payload');
      }

      // Attach to request for downstream handlers
      const userId = decoded.id || decoded.userId;
      request.user = { _id: userId };

      let workspaceId = decoded.workspaceId;
      if (!workspaceId && userId) {
        const authContext = await this.resolveAuthContext(token);
        workspaceId = authContext.workspace?._id || authContext.workspace?.id;
        request.user = authContext.user?._id ? { ...authContext.user, _id: String(authContext.user._id) } : request.user;
        request.role = authContext.role;
      }

      request.workspace = { _id: workspaceId };
      request.role = request.role || decoded.role;

      return true;
    } catch (error: any) {
      throw new UnauthorizedException(`Authentication failed: ${error.message}`);
    }
  }

  private extractToken(request: AuthRequest): string | null {
    // Try Bearer token first
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // Try cookie header manually to avoid requiring cookie-parser middleware
    const cookieHeader = request.headers.cookie || '';
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
    if (match) {
      return match.slice('auth_token='.length);
    }

    // Try cookie
    const cookies = request.cookies || {};
    if (cookies.auth_token) {
      return cookies.auth_token;
    }

    return null;
  }

  private async resolveAuthContext(token: string) {
    const baseUrl = (process.env.AUTH_SERVICE_URL || config.mainServiceUrl || 'http://localhost:5001').replace(/\/$/, '');
    const verifyUrl = baseUrl.includes('5001')
      ? `${baseUrl}/api/v1/auth/internal/v1/auth/verify-session`
      : `${baseUrl}/internal/v1/auth/verify-session`;

    const response = await axios.post(
      verifyUrl,
      { token },
      { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.data?.success || !response.data?.workspace?._id) {
      throw new Error('Unable to resolve workspace context');
    }

    return response.data;
  }
}
