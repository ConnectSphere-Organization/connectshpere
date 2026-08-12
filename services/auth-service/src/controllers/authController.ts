import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  User,
  Workspace,
  Permission,
  SystemSettings,
  WorkspaceInvitation,
  Team,
  Role,
  Notification,
  Business
} from '../models/index.js';
import {
  loginWithPassword,
  sendAuthOtp,
  verifyAuthOtp
} from '../services/auth-flow-service.js';
import { createOwnerAccount } from '../services/account-service.js';
import { createAndSendOtp, verifyOtp } from '../services/otp-service.js';
import { getGoogleAuthUrl, getGoogleUser } from '../services/google-auth-service.js';
import { AccountDeletionService } from '../services/account-deletion-service.js';
import { MailService } from '../services/mail-service.js';
import {
  createAuthToken,
  setAuthCookie,
  clearAuthCookie,
  extractToken,
  resolveUserFromToken,
  buildSessionPayload,
  normalizeEmail,
  sanitizeUser
} from '../utils/authHelper.js';
import { AuthRequest } from '../middleware/businessAuth.js';
import config from '../config/index.js';
import { isAdminRole } from '@wapi/contracts';
import { adminGoogleSignupAllowed } from '../config/admin-google-signup-policy.js';

async function getUserFromCookie(req: express.Request) {
  const token = extractToken(req);
  if (!token) return null;
  try {
    return await resolveUserFromToken(token);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Signup / Login                              */
/* -------------------------------------------------------------------------- */

export const signup = async (req: express.Request, res: express.Response) => {
  try {
    const { name, email, password } = req.body || {};
    const result = await sendAuthOtp({
      purpose: 'signup_email',
      identifier: email,
      name,
      password,
      requestIp: req.ip
    });
    return res.status(200).json({ success: true, message: 'OTP sent successfully', ...result });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Signup failed', code: error.code });
  }
};

export const verifySignupOtp = async (req: express.Request, res: express.Response) => {
  try {
    const { email, otp } = req.body || {};
    const result = await verifyAuthOtp({
      purpose: 'signup_email',
      identifier: email,
      otp,
      currentUser: undefined
    });

    if (result.token) setAuthCookie(res, result.token);

    const fullUser = await User.findById(result.user.id);
    const session = await buildSessionPayload(fullUser);

    return res.status(200).json({
      success: true,
      token: result.token,
      ...session,
      message: 'OTP verified successfully'
    });
  } catch (error: any) {
    const status = error.status || 400;
    return res.status(status).json({ success: false, message: error.message || 'OTP verification failed', code: error.code });
  }
};

export const login = async (req: express.Request, res: express.Response) => {
  try {
    const { email, password } = req.body || {};
    const result = await loginWithPassword(email, password);

    setAuthCookie(res, result.token);

    const fullUser = await User.findById(result.user.id);
    const session = await buildSessionPayload(fullUser);

    return res.status(200).json({
      success: true,
      token: result.token,
      ...session
    });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Login failed', code: error.code });
  }
};

export const logout = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (token) {
      const { invalidateCache } = await import('../utils/redis.js');
      await invalidateCache(`session:${token}`);
    }
  } catch (err: any) {
    console.error('[logout] Failed to invalidate session cache:', err.message);
  }
  clearAuthCookie(res);
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
};

/* -------------------------------------------------------------------------- */
/*                             Generic OTP endpoints                          */
/* -------------------------------------------------------------------------- */

export const sendOtp = async (req: express.Request, res: express.Response) => {
  try {
    const { email, name, password, purpose, identifier } = req.body || {};
    const currentUser = await getUserFromCookie(req);
    const result = await sendAuthOtp({
      purpose: purpose || 'signup_email',
      identifier: identifier || email,
      name,
      password,
      requestIp: req.ip,
      currentUser
    });
    return res.status(200).json({ success: true, message: 'OTP sent successfully', ...result });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Failed to send OTP', code: error.code });
  }
};

export const verifyOtpEndpoint = async (req: express.Request, res: express.Response) => {
  try {
    const { otp, email, purpose, identifier } = req.body || {};
    const currentUser = await getUserFromCookie(req);
    const result = await verifyAuthOtp({
      purpose: purpose || 'signup_email',
      identifier: identifier || email,
      otp,
      currentUser
    });

    if (result.token) setAuthCookie(res, result.token);

    const fullUser = await User.findById(result.user.id);
    const session = await buildSessionPayload(fullUser);

    return res.status(200).json({ success: true, token: result.token, ...session });
  } catch (error: any) {
    const status = error.status || 400;
    return res.status(status).json({ success: false, message: error.message || 'OTP verification failed', code: error.code });
  }
};

/* -------------------------------------------------------------------------- */
/*                                 Session                                    */
/* -------------------------------------------------------------------------- */

export const session = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(200).json({ authenticated: false });

    const user = await resolveUserFromToken(token);
    if (!user) {
      clearAuthCookie(res);
      return res.status(200).json({ authenticated: false });
    }

    const sessionPayload = await buildSessionPayload(user);
    return res.status(200).json({ ...sessionPayload, token });
  } catch (error) {
    clearAuthCookie(res);
    return res.status(200).json({ authenticated: false });
  }
};

export const me = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await resolveUserFromToken(token);
    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const sessionPayload = await buildSessionPayload(user);
    return res.status(200).json({ success: true, ...sessionPayload, token });
  } catch (error) {
    clearAuthCookie(res);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
};

export const updateMe = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { name, phone, timezone } = req.body || {};
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: { name, phone, timezone } },
      { new: true }
    ).select('-passwordHash');

    return res.status(200).json({ success: true, user: sanitizeUser(updatedUser) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update profile' });
  }
};

/* -------------------------------------------------------------------------- */
/*                               Google / Facebook                            */
/* -------------------------------------------------------------------------- */

export const googleUrl = async (req: express.Request, res: express.Response) => {
  try {
    const type = String((req.query as any).type || 'login');
    const redirectUri = typeof (req.query as any).redirectUri === 'string' ? (req.query as any).redirectUri : undefined;
    const url = getGoogleAuthUrl(type, redirectUri);
    return res.status(200).json({ success: true, url, authUrl: url });
  } catch (error: any) {
    return res.status(error.status || 500).json({
      success: false,
      error: {
        code: error.code || 'GOOGLE_AUTH_URL_FAILED',
        message: error.message || 'Failed to build Google auth URL',
        requestId: req.headers['x-correlation-id'] || null,
      },
    });
  }
};

export const googleCallback = async (req: express.Request, res: express.Response) => {
  try {
    const code = (req.body?.code || (req.query as any)?.code) as string | undefined;
    const redirectUri = (req.body?.redirectUri || (req.query as any)?.redirectUri) as string | undefined;
    if (!code) return res.status(400).json({ success: false, message: 'Missing Google authorization code' });

    const googleUser = await getGoogleUser(code, redirectUri);
    if (!googleUser?.email) {
      return res.status(400).json({ success: false, message: 'Failed to retrieve email from Google' });
    }

    const email = googleUser.email.toLowerCase().trim();

    let user: any = await User.findOne({
      $or: [{ googleId: googleUser.id }, { email }]
    });

    if (!user) {
      const created = await createOwnerAccount({
        name: googleUser.name || email.split('@')[0],
        email,
        googleId: googleUser.id,
        profilePicture: googleUser.picture,
        authProvider: 'google',
        emailVerified: true,
        phoneVerified: false
      });
      user = created.user;
    } else {
      let needsSave = false;
      if (!user.googleId) { user.googleId = googleUser.id; needsSave = true; }
      if (user.authProvider !== 'google') { user.authProvider = 'google'; needsSave = true; }
      if (!user.emailVerified) { user.emailVerified = true; needsSave = true; }
      if (!user.profilePicture && googleUser.picture) { user.profilePicture = googleUser.picture; needsSave = true; }
      if (user.accountStatus !== 'SIGNUP_COMPLETED') { user.accountStatus = 'SIGNUP_COMPLETED'; needsSave = true; }
      if (needsSave) await user.save();
    }

    const token = createAuthToken(user);
    setAuthCookie(res, token);

    const sessionPayload = await buildSessionPayload(user);
    return res.status(200).json({ success: true, token, ...sessionPayload });
  } catch (error: any) {
    return res.status(error.status || 500).json({
      success: false,
      error: {
        code: error.code || 'GOOGLE_AUTH_FAILED',
        message: error.message || 'Google callback failed',
        requestId: req.headers['x-correlation-id'] || null,
      },
    });
  }
};

/** Google OAuth for platform administrators with allowlisted, read-only signup. */
export const googleAdminCallback = async (req: express.Request, res: express.Response) => {
  try {
    const code = (req.body?.code || (req.query as any)?.code) as string | undefined;
    const redirectUri = (req.body?.redirectUri || (req.query as any)?.redirectUri) as string | undefined;
    if (!code) return res.status(400).json({ success: false, message: 'Missing Google authorization code' });

    const googleUser = await getGoogleUser(code, redirectUri);
    const email = googleUser?.email ? normalizeEmail(googleUser.email) : '';
    if (!email) return res.status(400).json({ success: false, message: 'Failed to retrieve email from Google' });

    let user: any = await User.findOne({ $or: [{ googleId: googleUser.id }, { email }] });
    if (!user) {
      if (!adminGoogleSignupAllowed(email, config.adminGoogleSignupEmails)) {
        return res.status(403).json({
          success: false,
          message: 'This Google account is not authorized for admin signup',
        });
      }

      user = await User.create({
        name: googleUser.name || email.split('@')[0],
        email,
        googleId: googleUser.id,
        authProvider: 'google',
        emailVerified: true,
        profilePicture: googleUser.picture,
        role: 'super_admin_readonly',
        status: 'active',
        accountStatus: 'SIGNUP_COMPLETED',
      });
    } else if (!isAdminRole(user.role)) {
      return res.status(403).json({ success: false, message: 'This Google account is not authorized for the admin portal' });
    }

    let needsSave = false;
    if (!user.googleId) { user.googleId = googleUser.id; needsSave = true; }
    if (user.authProvider !== 'google') { user.authProvider = 'google'; needsSave = true; }
    if (!user.emailVerified) { user.emailVerified = true; needsSave = true; }
    if (!user.profilePicture && googleUser.picture) { user.profilePicture = googleUser.picture; needsSave = true; }
    if (needsSave) await user.save();

    return res.status(200).json({ success: true, user: { email: user.email } });
  } catch (error: any) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Google callback failed',
      code: error.code || 'GOOGLE_ADMIN_AUTH_FAILED',
    });
  }
};

export const facebookLogin = async (req: express.Request, res: express.Response) => {
  return res.status(503).json({
    success: false,
    error: {
      code: 'FEATURE_DISABLED',
      message: 'Facebook authentication is not available',
      requestId: req.headers['x-correlation-id'] || null,
    },
  });
};

/* -------------------------------------------------------------------------- */
/*                              Password reset                                */
/* -------------------------------------------------------------------------- */

export const requestPasswordReset = async (req: express.Request, res: express.Response) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const normalized = normalizeEmail(email);
    const user = await User.findOne({ email: normalized });
    if (!user) {
      return res.status(200).json({ success: true, message: 'Instructions sent if email exists' });
    }

    const resetToken = jwt.sign(
      { id: user._id.toString(), purpose: 'password_reset' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const resetUrl = `${appUrl}/auth/reset?token=${resetToken}`;

    await MailService.sendMail({
      to: user.email!,
      subject: 'Reset your wApi password',
      text: `Hello ${user.name || 'there'},\n\nClick here to reset your password:\n${resetUrl}\n\nThis link is valid for 1 hour.`,
      html: `<p>Hello ${user.name || 'there'},</p><p>Click <a href="${resetUrl}">here</a> to reset your password.</p><p>This link is valid for 1 hour.</p>`
    });

    return res.status(200).json({ success: true, message: 'Instructions sent if email exists' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to request password reset' });
  }
};

export const resetPassword = async (req: express.Request, res: express.Response) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ success: false, message: 'Token and password are required' });

    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    if (decoded.purpose !== 'password_reset') {
      return res.status(400).json({ success: false, message: 'Invalid token purpose' });
    }

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.passwordHash = await bcrypt.hash(String(password), 10);
    await user.save();

    return res.status(200).json({ success: true, message: 'Password reset successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to reset password' });
  }
};

/* -------------------------------------------------------------------------- */
/*                                 Account                                    */
/* -------------------------------------------------------------------------- */

export const getAccount = async (req: AuthRequest, res: express.Response) => {
  try {
    const { user, workspace } = req;
    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        accountStatus: user.accountStatus,
        createdAt: user.createdAt
      },
      workspace: workspace ? {
        id: workspace._id,
        name: workspace.name,
        plan: workspace.plan || 'free'
      } : null
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
  }
};

export const deleteAccount = async (req: AuthRequest, res: express.Response) => {
  try {
    const { confirmText } = req.body || {};
    if (confirmText !== 'DELETE') {
      return res.status(400).json({ success: false, message: "Please type 'DELETE' to confirm" });
    }

    await AccountDeletionService.deleteAccount(req.user._id);

    clearAuthCookie(res);
    return res.status(200).json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.'
    });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Internal server error' });
  }
};

export const requestDeleteAccount = async (req: AuthRequest, res: express.Response) => {
  try {
    const user = req.user;
    if (!user?.email) {
      return res.status(400).json({ success: false, message: 'Authenticated user has no email on file' });
    }

    const result = await createAndSendOtp({
      identifier: user.email,
      purpose: 'email_verification',
      metadata: {
        requestIp: req.ip,
        intent: 'account-delete',
        userId: user._id.toString()
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Verification code sent. Check your email.',
      challengeId: result.challengeId,
      maskedIdentifier: result.maskedIdentifier,
      expiresIn: result.expiresIn
    });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Internal server error', code: error.code });
  }
};

export const confirmDeleteAccount = async (req: AuthRequest, res: express.Response) => {
  try {
    const user = req.user;
    if (!user?.email) {
      return res.status(400).json({ success: false, message: 'Authenticated user has no email on file' });
    }

    const code = String(req.body?.verificationCode || req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, message: 'A valid 6-digit verification code is required' });
    }

    const bodyUserId = req.body?.userId ? String(req.body.userId) : null;
    if (bodyUserId && bodyUserId !== user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only delete your own account' });
    }

    await verifyOtp({ identifier: user.email, purpose: 'email_verification', otp: code });
    await AccountDeletionService.deleteAccount(user._id);

    clearAuthCookie(res);
    return res.status(200).json({
      success: true,
      message: 'Your account and all associated data have been permanently deleted.'
    });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message || 'Internal server error', code: error.code });
  }
};

/* -------------------------------------------------------------------------- */
/*                          Workspaces / Invitations                          */
/* -------------------------------------------------------------------------- */

export const listWorkspaces = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const permissions = await Permission.find({ user: user._id, isActive: true })
      .populate('workspace')
      .sort({ createdAt: -1 });

    const workspaces = permissions
      .filter((p: any) => p.workspace)
      .map((p: any) => ({
        id: p.workspace._id.toString(),
        _id: p.workspace._id.toString(),
        name: p.workspace.name,
        avatar: p.workspace.avatar,
        role: p.role,
        isActive: p.workspace._id.toString() === (user.activeWorkspace?.toString() || user.workspace?.toString())
      }));

    return res.status(200).json({ success: true, workspaces });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to list workspaces' });
  }
};

export const switchWorkspace = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { workspaceId } = req.body || {};
    const membership = await Permission.findOne({ workspace: String(workspaceId), user: user._id });
    if (!membership) return res.status(403).json({ success: false, message: 'Access denied to this workspace' });

    await User.findByIdAndUpdate(user._id, { activeWorkspace: String(workspaceId) });

    try {
      const { invalidateCache } = await import('../utils/redis.js');
      await invalidateCache(`session:${token}`);
    } catch (err: any) {
      console.error('[switchWorkspace] Failed to invalidate session cache:', err.message);
    }

    return res.status(200).json({ success: true, message: 'Workspace switched' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to switch workspace' });
  }
};

export const getInvitation = async (req: express.Request, res: express.Response) => {
  try {
    const { token } = req.params;
    const email = String((req.query as any).email || '').trim().toLowerCase();
    if (!token || !email) {
      return res.status(400).json({ success: false, error: 'Token and Email are required' });
    }

    const invitation: any = await WorkspaceInvitation.findOne({ token: String(token) }).populate('workspace', 'name');
    if (!invitation) return res.status(404).json({ success: false, error: 'Invalid or expired invitation' });

    if (invitation.email.toLowerCase() !== email) {
      return res.status(403).json({ success: false, error: 'This invitation was sent to a different email address.' });
    }

    if (invitation.status === 'accepted') {
      const newInvite: any = await WorkspaceInvitation.findOne({
        email,
        workspace: invitation.workspace,
        status: 'pending',
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      if (newInvite) {
        return res.status(410).json({
          success: false,
          error: 'This invitation link is outdated. A newer invitation is available.',
          redirectToken: newInvite.token,
          redirectEmail: newInvite.email
        });
      }
      return res.status(400).json({ success: false, error: 'You have already accepted this invitation!' });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, error: `This invitation has been ${invitation.status}.` });
    }

    if (invitation.expiresAt < new Date()) {
      return res.status(410).json({ success: false, error: 'This invitation has expired. Please request a new one.' });
    }

    const existingUser = await User.findOne({ email });
    return res.status(200).json({
      success: true,
      data: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        workspaceName: invitation.workspace?.name,
        userExists: !!existingUser,
        authProvider: existingUser?.authProvider || 'local'
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

export const acceptInvitation = async (req: express.Request, res: express.Response) => {
  try {
    const { token, email, name, password, userId: providedUserId } = req.body || {};
    if (!token || !email) {
      return res.status(400).json({ success: false, error: 'Token and Email are required' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const invitation: any = await WorkspaceInvitation.findOne({ token: String(token) });
    if (!invitation) return res.status(404).json({ success: false, error: 'Invalid invitation token.' });

    if (invitation.email.toLowerCase() !== cleanEmail) {
      return res.status(403).json({ success: false, error: 'This invitation belongs to a different email address.' });
    }

    if (invitation.status === 'accepted') {
      return res.status(400).json({ success: false, error: 'You have already accepted this invitation!' });
    }
    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Invitation is no longer valid (Status: ${invitation.status})` });
    }
    if (invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(410).json({ success: false, error: 'This invitation has expired. Please request a new one.' });
    }

    let user: any = providedUserId
      ? await User.findById(providedUserId)
      : await User.findOne({ email: cleanEmail });

    if (!user) {
      if (!password) {
        return res.status(400).json({
          success: false,
          error: 'User account not found. A password is required to create your account.',
          actionRequired: 'signup'
        });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      user = await User.create({
        name: name || invitation.name || cleanEmail.split('@')[0],
        email: cleanEmail,
        passwordHash,
        phone: invitation.phone,
        status: 'active',
        activeWorkspace: invitation.workspace,
        accountStatus: 'SIGNUP_COMPLETED',
        emailVerified: true,
        role: invitation.role
      });
    } else if (user.status === 'removed') {
      user.status = 'active';
      await user.save();
    }

    const systemRoles = ['owner', 'admin', 'manager', 'agent', 'viewer'];
    let permissions: any;
    if (systemRoles.includes(invitation.role)) {
      permissions = (Permission as any).getDefaultPermissions(invitation.role);
    } else {
      const customRole: any = await Role.findOne({ workspace: invitation.workspace, name: invitation.role });
      permissions = customRole?.permissions || (Permission as any).getDefaultPermissions('agent');
    }

    const permissionData = {
      role: invitation.role,
      permissions: invitation.permissionsOverride || permissions,
      isActive: true,
      joinedAt: new Date()
    };

    const existingPerm = await Permission.findOne({ workspace: invitation.workspace, user: user._id });
    if (!existingPerm) {
      await Permission.create({ workspace: invitation.workspace, user: user._id, ...permissionData });
    } else {
      await Permission.findByIdAndUpdate(existingPerm._id, { $set: permissionData });
    }

    if (invitation.teams?.length > 0) {
      await Team.updateMany(
        { _id: { $in: invitation.teams }, workspace: invitation.workspace },
        { $addToSet: { members: { user: user._id, role: 'member', addedAt: new Date() } } }
      );
    }

    user.activeWorkspace = invitation.workspace;
    user.status = 'active';
    await user.save();

    invitation.status = 'accepted';
    invitation.joinedAt = new Date();
    await invitation.save();

    try {
      const owners = await Permission.find({
        workspace: invitation.workspace,
        role: 'owner',
        isActive: true
      }).select('user').lean();

      const recipientIds = new Set<string>();
      if (invitation.invitedBy) recipientIds.add(invitation.invitedBy.toString());
      owners.forEach((o: any) => recipientIds.add(o.user.toString()));

      const notifications = Array.from(recipientIds).map((recipientId) => ({
        workspace: invitation.workspace,
        recipient: recipientId,
        type: 'invitation_accepted',
        title: 'New Team Member Joined',
        message: `${user.name || user.email} has accepted the invitation to join the workspace as ${invitation.role}.`,
        metadata: { joinedUserId: user._id, role: invitation.role }
      }));

      if (notifications.length) await Notification.insertMany(notifications);
    } catch (notifyErr) {
      console.error('[Auth] Failed to create admin notification:', notifyErr);
    }

    return res.status(200).json({
      success: true,
      message: 'Successfully joined the workspace',
      workspaceId: invitation.workspace,
      userId: user._id
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

export const listPendingInvitations = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const invitations = await WorkspaceInvitation.find({
      email: user.email,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    }).populate('workspace', 'name').populate('invitedBy', 'name email');

    return res.status(200).json({ success: true, invitations });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to list invitations' });
  }
};

/* -------------------------------------------------------------------------- */
/*                              Notifications                                 */
/* -------------------------------------------------------------------------- */

export const listNotifications = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const notifications = await Notification.find({ recipient: user._id })
      .sort({ createdAt: -1 })
      .limit(50);

    return res.status(200).json({ success: true, notifications });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to list notifications' });
  }
};

export const markNotificationRead = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: user._id },
      { $set: { read: true, readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });

    return res.status(200).json({ success: true, notification });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update notification' });
  }
};

export const markAllNotificationsRead = async (req: express.Request, res: express.Response) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await resolveUserFromToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    await Notification.updateMany(
      { recipient: user._id, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update notifications' });
  }
};

/* -------------------------------------------------------------------------- */
/*                          Internal session verification                     */
/* -------------------------------------------------------------------------- */

export const verifySession = async (req: express.Request, res: express.Response) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ success: false, message: 'Token signature is invalid' });
    }
    if (!decoded?.id) return res.status(401).json({ success: false, message: 'Invalid token payload' });

    const cacheKey = `session:${token}`;
    try {
      const { getCache, setCache } = await import('../utils/redis.js');
      const cachedSession = await getCache(cacheKey);
      if (cachedSession) {
        try {
          const parsed = JSON.parse(cachedSession);
          const settings = await (SystemSettings as any).getSettings();
          if (settings.maintenanceMode && parsed.user?.role !== 'super_admin') {
            return res.status(503).json({
              success: false,
              message: settings.maintenanceMessage || 'System is currently undergoing maintenance.',
              errorCode: 'MAINTENANCE_MODE'
            });
          }
          return res.status(200).json(parsed);
        } catch (err: any) {
          console.warn('[verifySession] Failed to parse cached session:', err.message);
        }
      }
    } catch (err: any) {
      console.warn('[verifySession] Redis get cache error:', err.message);
    }

    const user: any = await User.findById(decoded.id).select('-passwordHash');
    if (!user) return res.status(401).json({ success: false, message: 'User matching token not found' });

    let workspaceId = user.activeWorkspace || user.workspace;
    if (!workspaceId) {
      const firstMembership: any = await Permission.findOne({ user: user._id }).sort('createdAt');
      if (firstMembership) {
        workspaceId = firstMembership.workspace;
        user.activeWorkspace = workspaceId;
        await User.findByIdAndUpdate(user._id, { activeWorkspace: String(workspaceId) });
      }
    }

    let permission: any = null;
    let workspace: any = null;

    if (workspaceId) {
      permission = await Permission.findOne({ workspace: workspaceId, user: user._id, isActive: { $ne: false } });
      if (!permission && user.workspace?.toString() === workspaceId.toString()) {
        permission = await Permission.create({
          workspace: workspaceId,
          user: user._id,
          role: 'owner',
          permissions: (Permission as any).getDefaultPermissions('owner'),
          isActive: true
        });
      }
      workspace = await Workspace.findById(workspaceId).populate('plan');
    }

    const settings = await (SystemSettings as any).getSettings();
    if (settings.maintenanceMode && user.role !== 'super_admin') {
      return res.status(503).json({
        success: false,
        message: settings.maintenanceMessage || 'System is currently undergoing maintenance.',
        errorCode: 'MAINTENANCE_MODE'
      });
    }

    const responsePayload = {
      success: true,
      user,
      workspace,
      role: permission?.role || null,
      permissions: permission?.permissions || null,
      isImpersonating: !!decoded.isImpersonating
    };

    try {
      const { setCache } = await import('../utils/redis.js');
      await setCache(cacheKey, JSON.stringify(responsePayload), 60);
    } catch (err: any) {
      console.warn('[verifySession] Redis set cache error:', err.message);
    }

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: error.message });
  }
};

export const getUserNotifications = async (req: AuthRequest, res: express.Response) => {
  try {
    const user = await User.findById(req.user._id).select('notificationSettings timezone');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({
      success: true,
      data: {
        notificationSettings: (user as any).notificationSettings || {
          emailNotifications: true,
          smsNotifications: false,
          pushNotifications: true,
          dailyDigest: false,
          marketingEmails: false
        },
        timezone: user.timezone || 'UTC',
        language: 'en'
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to get notification settings' });
  }
};

export const updateUserNotifications = async (req: AuthRequest, res: express.Response) => {
  try {
    const { notificationSettings } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { notificationSettings } },
      { new: true }
    ).select('notificationSettings');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({
      success: true,
      data: user,
      message: 'Notification settings updated'
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update notification settings' });
  }
};
