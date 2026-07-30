import { Router } from 'express';
import {
  getInvitationByToken,
  acceptWorkspaceInvitation,
  listWorkspaceMembers,
  searchTeamMemberByEmail,
  inviteTeamMember,
  getMemberPermissions,
  updateMemberPermissions, 
  updateMemberRoleQuick, 
  updateMemberRecord, 
  removeWorkspaceMember, 
  resendInvitation 
} from '../controllers/memberController.js';
import { businessAuthMiddleware } from '../middleware/businessAuth.js';

const router = Router();

router.get('/invitation/:token', getInvitationByToken);
router.post('/accept-invite', acceptWorkspaceInvitation);

// Workspace membership
router.get('/workspace/members', businessAuthMiddleware, listWorkspaceMembers);
router.get('/workspace/team/members', businessAuthMiddleware, listWorkspaceMembers);
router.get('/members', businessAuthMiddleware, listWorkspaceMembers);
router.get('/team/members', businessAuthMiddleware, listWorkspaceMembers);

// Member lookup by email (used by the settings member panel before inviting)
router.get('/workspace/team/search', businessAuthMiddleware, searchTeamMemberByEmail);
router.get('/team/search', businessAuthMiddleware, searchTeamMemberByEmail);

router.post('/workspace/members/invite', businessAuthMiddleware, inviteTeamMember);
router.post('/members/invite', businessAuthMiddleware, inviteTeamMember);

// Member actions
router.get('/workspace/members/:memberId/permissions', businessAuthMiddleware, getMemberPermissions);
router.get('/workspace/members/:memberId', businessAuthMiddleware, getMemberPermissions);
router.get('/workspace/team/members/:memberId/permissions', businessAuthMiddleware, getMemberPermissions);
router.get('/members/:memberId/permissions', businessAuthMiddleware, getMemberPermissions);

router.patch('/workspace/members/:memberId/permissions', businessAuthMiddleware, updateMemberPermissions);
router.patch('/workspace/team/members/:memberId/permissions', businessAuthMiddleware, updateMemberPermissions);
router.patch('/members/:memberId/permissions', businessAuthMiddleware, updateMemberPermissions);

router.patch('/workspace/members/:memberId/role', businessAuthMiddleware, updateMemberRoleQuick);
router.patch('/workspace/team/members/:memberId/role', businessAuthMiddleware, updateMemberRoleQuick);
router.patch('/members/:memberId/role', businessAuthMiddleware, updateMemberRoleQuick);

router.patch('/workspace/members/:memberId', businessAuthMiddleware, updateMemberRecord);
router.patch('/workspace/team/members/:memberId', businessAuthMiddleware, updateMemberRecord);
router.patch('/members/:memberId', businessAuthMiddleware, updateMemberRecord);

router.delete('/workspace/members/:memberId', businessAuthMiddleware, removeWorkspaceMember);
router.delete('/workspace/team/members/:memberId', businessAuthMiddleware, removeWorkspaceMember);
router.delete('/members/:memberId', businessAuthMiddleware, removeWorkspaceMember);

router.post('/workspace/team/members/:invitationId/resend', businessAuthMiddleware, resendInvitation);
router.post('/members/:invitationId/resend', businessAuthMiddleware, resendInvitation);

export default router;
