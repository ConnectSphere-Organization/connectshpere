import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { 
  User, 
  Workspace, 
  Permission, 
  WorkspaceInvitation, 
  Team, 
  Notification 
} from '../models/index.js';
import { AuthRequest } from '../middleware/businessAuth.js';
import { getMailTransporter } from '../utils/email.js';
import { normalizeEmail, createAuthToken, setAuthCookie } from '../utils/authHelper.js';
import config from '../config/index.js';

export const getInvitationByToken = async (req: express.Request, res: express.Response) => {
  try {
    const { token } = req.params;
    const email = String(req.query.email || '').trim().toLowerCase();

    if (!token || !email) {
      return res.status(400).json({ success: false, error: 'Token and email are required' });
    }

    const invitation = await WorkspaceInvitation.findOne({ token }).populate('workspace', 'name');
    if (!invitation) {
      return res.status(404).json({ success: false, error: 'Invalid or expired invitation' });
    }

    if (invitation.email.toLowerCase() !== email) {
      return res.status(403).json({ success: false, error: 'This invitation was sent to a different email address.' });
    }

    if (invitation.status === 'accepted') {
      return res.status(400).json({ success: false, error: 'You have already accepted this invitation!' });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, error: `This invitation is ${invitation.status}.` });
    }

    if (new Date(invitation.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ success: false, error: 'This invitation has expired.' });
    }

    const existingUser = await User.findOne({ email });
    return res.status(200).json({
      success: true,
      data: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        workspaceName: (invitation.workspace as any)?.name,
        userExists: !!existingUser,
        authProvider: existingUser?.authProvider || 'local'
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

export const acceptWorkspaceInvitation = async (req: express.Request, res: express.Response) => {
  try {
    const { token, email, name, password } = req.body || {};
    if (!token || !email) {
      return res.status(400).json({ success: false, error: 'Token and email are required' });
    }

    const cleanEmail = normalizeEmail(email);
    const invitation = await WorkspaceInvitation.findOne({ token });
    if (!invitation) {
      return res.status(404).json({ success: false, error: 'Invalid invitation token.' });
    }

    if (invitation.email.toLowerCase() !== cleanEmail) {
      return res.status(403).json({ success: false, error: 'This invitation belongs to a different email address.' });
    }

    if (invitation.status === 'accepted') {
      return res.status(400).json({ success: false, error: 'You have already accepted this invitation!' });
    }

    if (invitation.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Invitation is no longer valid (Status: ${invitation.status})` });
    }

    if (new Date(invitation.expiresAt).getTime() < Date.now()) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(410).json({ success: false, error: 'This invitation has expired.' });
    }

    let user = await User.findOne({ email: cleanEmail });
    if (!user) {
      if (!password) {
        return res.status(400).json({ 
          success: false, 
          error: 'User account not found. A password is required to create your account.',
          actionRequired: 'signup'
        });
      }

      const passwordHash = await bcrypt.hash(String(password), 12);
      user = await User.create({
        name: name || invitation.name || cleanEmail.split('@')[0],
        email: cleanEmail,
        passwordHash,
        phone: invitation.phone,
        activeWorkspace: invitation.workspace,
        emailVerified: true,
        role: invitation.role,
      });
    }

    // Upsert Permissions
    const defaultPermissions = (Permission as any).getDefaultPermissions ? (Permission as any).getDefaultPermissions(invitation.role) : ['*'];
    await Permission.findOneAndUpdate(
      { workspace: invitation.workspace, user: user._id },
      {
        $set: {
          role: invitation.role,
          permissions: invitation.permissionsOverride || defaultPermissions,
          isActive: true,
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Update preassigned teams
    if (invitation.teams && invitation.teams.length > 0) {
      await Team.updateMany(
        { _id: { $in: invitation.teams }, workspace: invitation.workspace },
        { $addToSet: { members: { user: user._id, role: 'member', addedAt: new Date() } } }
      );
    }

    user.activeWorkspace = invitation.workspace;
    await user.save();

    invitation.status = 'accepted';
    invitation.joinedAt = new Date();
    await invitation.save();

    // Create Notification
    try {
      await Notification.create({
        workspace: invitation.workspace,
        recipient: invitation.invitedBy,
        type: 'invitation_accepted',
        title: 'New Team Member Joined',
        message: `${user.name || user.email} has accepted the invitation to join the workspace as ${invitation.role}.`,
        metadata: { joinedUserId: user._id.toString(), role: invitation.role }
      });
    } catch (notifyErr) {
      console.error('[AcceptInvite] Notification failed:', notifyErr);
    }

    const tokenPayload = createAuthToken(user);
    setAuthCookie(res, tokenPayload);

    return res.status(200).json({
      success: true,
      message: 'Successfully joined the workspace',
      workspaceId: invitation.workspace,
      userId: user._id,
      token: tokenPayload
    });
  } catch (error: any) {
    console.error('[AcceptInvite] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

export const searchTeamMemberByEmail = async (req: AuthRequest, res: express.Response) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email || email.length < 3) {
      return res.json({ success: true, data: null });
    }
    const user: any = await User.findOne({ email }).select('name email phone role status').lean();
    if (!user) {
      return res.json({ success: true, data: { exists: false } });
    }
    const membership: any = await Permission.findOne({
      workspace: req.workspace._id,
      user: user._id,
    })
      .select('role isActive')
      .lean();

    return res.json({
      success: true,
      data: {
        exists: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
        },
        isMember: !!membership && membership.isActive !== false,
        membershipStatus: membership ? (membership.isActive !== false ? 'active' : 'removed') : 'none',
        membershipRole: membership?.role,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const listWorkspaceMembers = async (req: AuthRequest, res: express.Response) => {
  try {
    const workspaceId = req.workspace._id;

    const permissions = await Permission.find({ workspace: workspaceId, isActive: { $ne: false } })
      .populate('user', 'name email role lastLogin phone status');

    const members = permissions.map((p: any) => ({
      _id: p.user?._id,
      id: p.user?._id,
      name: p.user?.name,
      email: p.user?.email,
      phone: p.user?.phone,
      role: p.role,
      isActive: p.isActive,
      isOnline: p.isOnline || false,
      isAvailable: p.isAvailable || false,
      lastSeenAt: p.lastSeenAt || null,
      openConversations: 0,
      teams: []
    }));

    const pendingInvites = await WorkspaceInvitation.find({ workspace: workspaceId, status: 'pending' });
    const invitations = pendingInvites.map((inv: any) => ({
      _id: inv._id,
      id: inv._id,
      email: inv.email,
      name: inv.name,
      phone: inv.phone || '',
      role: inv.role,
      status: 'pending',
      invitedAt: inv.createdAt,
      expiresAt: inv.expiresAt
    }));

    return res.status(200).json({
      success: true,
      data: { members, invitations }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const inviteTeamMember = async (req: AuthRequest, res: express.Response) => {
  try {
    const { email, name, role, phone, teamIds = [] } = req.body || {};
    if (!email || !role) {
      return res.status(400).json({ success: false, message: 'Email and role are required' });
    }

    const cleanEmail = normalizeEmail(email);
    const workspaceId = req.workspace._id;

    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      const perm = await Permission.findOne({ workspace: workspaceId, user: existingUser._id, isActive: { $ne: false } });
      if (perm) {
        return res.status(409).json({ success: false, error: 'User is already a member of this workspace', isMember: true });
      }
    }

    const invitationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await WorkspaceInvitation.create({
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      workspace: workspaceId,
      role,
      invitedBy: req.user._id,
      token: invitationToken,
      teams: teamIds,
      phone,
      expiresAt
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const invitationUrl = `${appUrl.replace(/\/$/, '')}/auth/accept-invite?token=${invitationToken}&email=${encodeURIComponent(cleanEmail)}`;

    let emailStatus = { success: false };
    try {
      const transporter = await getMailTransporter();
      const from = config.smtpFrom || config.smtpUser || 'no-reply@local.wapi';
      await transporter.sendMail({
        from,
        to: cleanEmail,
        subject: `Invitation to join ${req.workspace.name} on wApi`,
        html: `<p>Hello ${name || 'there'},</p><p>You have been invited by ${req.user.name} to join <strong>${req.workspace.name}</strong> as ${role}.</p><p><a href="${invitationUrl}">Accept Invitation</a></p>`
      });
      emailStatus = { success: true };
    } catch (mailErr: any) {
      console.warn('[Workspace Invite] Email sending failed, dev fallback:', mailErr.message);
      if (config.env !== 'production') {
        emailStatus = { success: true };
      }
    }

    return res.status(201).json({
      success: true,
      data: {
        id: invitation._id,
        email: invitation.email,
        role: invitation.role,
        invitationUrl,
        emailStatus
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getMemberPermissions = async (req: AuthRequest, res: express.Response) => {
  try {
    const { memberId } = req.params;
    let perm: any = await Permission.findOne({ workspace: req.workspace._id, user: memberId }).lean();
    if (!perm) {
      perm = await Permission.findOne({ _id: memberId, workspace: req.workspace._id }).lean();
    }
    if (!perm) {
      const user: any = await User.findById(memberId).lean();
      if (user) {
        return res.status(200).json({
          success: true,
          data: {
            user: user._id,
            workspace: req.workspace._id,
            role: user.role || 'owner',
            isActive: true,
            permissions: []
          }
        });
      }
      return res.status(404).json({ success: false, message: 'Member permissions not found' });
    }
    return res.status(200).json({ success: true, data: perm });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMemberPermissions = async (req: AuthRequest, res: express.Response) => {
  try {
    const { memberId } = req.params;
    const { permissions, role, isAvailable, maxConcurrentChats } = req.body || {};

    const perm = await Permission.findOne({ workspace: req.workspace._id, user: memberId });
    if (!perm) {
      return res.status(404).json({ success: false, message: 'Member permission record not found' });
    }

    if (role) {
      perm.role = role;
      perm.permissions = (Permission as any).getDefaultPermissions ? (Permission as any).getDefaultPermissions(role) : permissions;
    } else if (permissions) {
      perm.permissions = { ...perm.permissions, ...permissions };
    }

    if (isAvailable !== undefined) perm.isAvailable = isAvailable;
    if (maxConcurrentChats !== undefined) perm.maxConcurrentChats = maxConcurrentChats;

    await perm.save();
    return res.status(200).json({ success: true, data: perm });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMemberRoleQuick = async (req: AuthRequest, res: express.Response) => {
  try {
    const { memberId } = req.params;
    const { role } = req.body || {};
    if (!role) {
      return res.status(400).json({ success: false, message: 'Role is required' });
    }

    const perm = await Permission.findOne({ workspace: req.workspace._id, user: memberId });
    if (!perm) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    perm.role = role;
    perm.permissions = (Permission as any).getDefaultPermissions ? (Permission as any).getDefaultPermissions(role) : ['*'];
    await perm.save();

    return res.status(200).json({ success: true, data: perm });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMemberRecord = async (req: AuthRequest, res: express.Response) => {
  try {
    const { memberId } = req.params;
    const { name, phone, role } = req.body || {};

    const user = await User.findById(memberId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    await user.save();

    if (role) {
      await Permission.findOneAndUpdate(
        { workspace: req.workspace._id, user: memberId },
        {
          $set: {
            role,
            permissions: (Permission as any).getDefaultPermissions ? (Permission as any).getDefaultPermissions(role) : ['*']
          }
        }
      );
    }

    return res.status(200).json({ success: true, data: user });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const removeWorkspaceMember = async (req: AuthRequest, res: express.Response) => {
  try {
    const { memberId } = req.params;
    const workspaceId = req.workspace._id;

    const invite = await WorkspaceInvitation.findOne({ _id: memberId, workspace: workspaceId });
    if (invite) {
      await invite.deleteOne();
      return res.status(200).json({ success: true, message: 'Invitation removed' });
    }

    const perm = await Permission.findOne({ workspace: workspaceId, user: memberId });
    if (!perm) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    perm.isActive = false;
    await perm.save();

    return res.status(200).json({ success: true, message: 'Member removed successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const resendInvitation = async (req: AuthRequest, res: express.Response) => {
  try {
    const { invitationId } = req.params;
    const workspaceId = req.workspace._id;

    const invitation = await WorkspaceInvitation.findOne({ _id: invitationId, workspace: workspaceId, status: 'pending' });
    if (!invitation) {
      return res.status(404).json({ success: false, message: 'Pending invitation not found' });
    }

    const invitationToken = crypto.randomBytes(32).toString('hex');
    invitation.token = invitationToken;
    invitation.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    invitation.resendCount = (invitation.resendCount || 0) + 1;
    invitation.lastSentAt = new Date();
    await invitation.save();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const invitationUrl = `${appUrl.replace(/\/$/, '')}/auth/accept-invite?token=${invitationToken}&email=${encodeURIComponent(invitation.email)}`;

    try {
      const transporter = await getMailTransporter();
      const from = config.smtpFrom || config.smtpUser || 'no-reply@local.wapi';
      await transporter.sendMail({
        from,
        to: invitation.email,
        subject: `Invitation to join ${req.workspace.name} on wApi (Resent)`,
        html: `<p>Hello ${invitation.name || 'there'},</p><p>You have been invited by ${req.user.name} to join <strong>${req.workspace.name}</strong> as ${invitation.role}.</p><p><a href="${invitationUrl}">Accept Invitation</a></p>`
      });
    } catch (mailErr: any) {
      console.warn('[Workspace Resend Invite] Email sending failed, dev fallback:', mailErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Invitation resent successfully',
      data: { id: invitation._id, email: invitation.email }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
