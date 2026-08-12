import { Router } from 'express';
import { 
  getContactsInternal, 
  createContactInternal, 
  getContactByIdInternal, 
  updateContactInternal, 
  deleteContactInternal, 
  getFormSubmissionsInternal, 
  getContactsPublic, 
  createContactPublic, 
  getContactByIdPublic, 
  updateContactPublic, 
  deleteContactPublic, 
  getFormSubmissionsPublic,
  queryContactsInternal,
  countContactsInternal,
  resolveContactInternal
} from '../controllers/contactController.js';
import { crmController } from '../controllers/crmController.js';
import { bulkController } from '../controllers/bulkController.js';
import { workspaceMessagingController } from '../controllers/workspaceMessagingController.js';
import { authenticate } from '../middleware/auth.js';
import { publishContactEvent } from '../services/eventBus.js';

const router = Router();

const rateLimiterStore = new Map<string, number[]>();
const contactRateLimiter = (req: any, res: any, next: any) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 500;
  const timestamps = (rateLimiterStore.get(ip) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= max) {
    return res.status(429).json({ message: 'Too many requests, please try again later.' });
  }
  timestamps.push(now);
  rateLimiterStore.set(ip, timestamps);
  next();
};

router.use(contactRateLimiter);
const internalAuth = (req: any, res: any, next: any) => {
  const expected = process.env.INTERNAL_SERVICE_SECRET!;
  if (req.header('x-internal-service-secret') !== expected) {
    return res.status(401).json({ success: false, message: 'Unauthorized: internal service secret missing or invalid' });
  }
  next();
};

// Internal Gateway endpoints
router.get('/internal/v1/contacts', internalAuth, getContactsInternal);
router.post('/internal/v1/contacts', internalAuth, createContactInternal);
router.post('/internal/v1/contacts/query', internalAuth, queryContactsInternal);
router.post('/internal/v1/contacts/count', internalAuth, countContactsInternal);
router.post('/internal/v1/contacts/resolve', internalAuth, resolveContactInternal);
router.get('/internal/v1/contacts/:id', internalAuth, getContactByIdInternal);
router.patch('/internal/v1/contacts/:id', internalAuth, updateContactInternal);
router.delete('/internal/v1/contacts/:id', internalAuth, deleteContactInternal);
router.get('/internal/v1/contacts/:id/form-submissions', internalAuth, getFormSubmissionsInternal);
router.post('/internal/v1/contact-events/replay', internalAuth, async (req, res) => {
  const { workspaceId, event = 'contact_updated', payload = {} } = req.body || {};
  if (!workspaceId) return res.status(400).json({ success: false, message: 'workspaceId is required' });
  await publishContactEvent(event, String(workspaceId), payload);
  return res.json({ success: true, replayed: 1 });
});

// Authenticated Gateway Proxy endpoints
router.get('/api/v1/contacts', authenticate, getContactsPublic);
router.post('/api/v1/contacts', authenticate, createContactPublic);
// Monolith aliases (must precede /:id so 'export'/'import' aren't captured as ids)
router.get('/api/v1/contacts/export', authenticate, bulkController.exportContacts);
router.post('/api/v1/contacts/import', authenticate, bulkController.bulkCreateContacts);
router.post('/api/v1/contacts/csv-import/upload', authenticate, bulkController.uploadCSV);
router.get('/api/v1/contacts/csv-import/:jobId/progress', authenticate, bulkController.getCSVProgress);
router.delete('/api/v1/contacts/csv-import/:jobId/cancel', authenticate, bulkController.cancelCSVImport);
router.get('/api/v1/contacts/:id', authenticate, getContactByIdPublic);
router.patch('/api/v1/contacts/:id', authenticate, updateContactPublic);
router.delete('/api/v1/contacts/:id', authenticate, deleteContactPublic);
router.get('/api/v1/contacts/:id/form-submissions', authenticate, getFormSubmissionsPublic);

// Workspace messaging settings: tags and quick replies
router.get('/api/v1/workspace/tags', authenticate, workspaceMessagingController.listTags);
router.post('/api/v1/workspace/tags', authenticate, workspaceMessagingController.createTag);
router.delete('/api/v1/workspace/tags/:id', authenticate, workspaceMessagingController.deleteTag);
router.get('/workspace/tags', authenticate, workspaceMessagingController.listTags);
router.post('/workspace/tags', authenticate, workspaceMessagingController.createTag);
router.delete('/workspace/tags/:id', authenticate, workspaceMessagingController.deleteTag);
router.get('/api/v1/tags', authenticate, workspaceMessagingController.listTags);
router.post('/api/v1/tags', authenticate, workspaceMessagingController.createTag);
router.delete('/api/v1/tags/:id', authenticate, workspaceMessagingController.deleteTag);

router.get('/api/v1/workspace/quick-replies', authenticate, workspaceMessagingController.listQuickReplies);
router.post('/api/v1/workspace/quick-replies', authenticate, workspaceMessagingController.saveQuickReply);
router.patch('/api/v1/workspace/quick-replies/:id', authenticate, workspaceMessagingController.saveQuickReply);
router.delete('/api/v1/workspace/quick-replies/:id', authenticate, workspaceMessagingController.deleteQuickReply);
router.get('/workspace/quick-replies', authenticate, workspaceMessagingController.listQuickReplies);
router.post('/workspace/quick-replies', authenticate, workspaceMessagingController.saveQuickReply);
router.patch('/workspace/quick-replies/:id', authenticate, workspaceMessagingController.saveQuickReply);
router.delete('/workspace/quick-replies/:id', authenticate, workspaceMessagingController.deleteQuickReply);
router.get('/api/v1/messaging/quick-replies', authenticate, workspaceMessagingController.listQuickReplies);
router.post('/api/v1/messaging/quick-replies', authenticate, workspaceMessagingController.saveQuickReply);
router.patch('/api/v1/messaging/quick-replies/:id', authenticate, workspaceMessagingController.saveQuickReply);
router.delete('/api/v1/messaging/quick-replies/:id', authenticate, workspaceMessagingController.deleteQuickReply);

// CRM pipelines & deal pipeline routes
router.get('/api/v1/crm/pipelines', authenticate, crmController.getPipelines);
router.post('/api/v1/crm/pipelines', authenticate, crmController.createPipeline);

router.get('/api/v1/crm/deals', authenticate, crmController.getDeals);
router.post('/api/v1/crm/deals', authenticate, crmController.createDeal);
router.get('/api/v1/crm/deals/:id', authenticate, crmController.getDeal);
router.patch('/api/v1/crm/deals/:id', authenticate, crmController.updateDeal);
router.delete('/api/v1/crm/deals/:id', authenticate, crmController.deleteDeal);
router.patch('/api/v1/crm/deals/:id/stage', authenticate, crmController.updateDealStage);
router.post('/api/v1/crm/deals/:id/notes', authenticate, crmController.addDealNote);
router.get('/api/v1/crm/contacts/:contactId/deals', authenticate, crmController.getContactDeals);

router.get('/api/v1/crm/tasks', authenticate, crmController.getTasks);
router.post('/api/v1/crm/tasks', authenticate, crmController.createTask);
router.patch('/api/v1/crm/tasks/:id', authenticate, crmController.updateTask);
router.patch('/api/v1/crm/tasks/:id/status', authenticate, crmController.updateTaskStatus);
router.delete('/api/v1/crm/tasks/:id', authenticate, crmController.deleteTask);

router.get('/api/v1/crm/analytics', authenticate, crmController.getAnalytics);
router.get('/api/v1/crm/automation', authenticate, crmController.getAutomationRules);
router.post('/api/v1/crm/automation', authenticate, crmController.saveAutomationRule);
router.delete('/api/v1/crm/automation', authenticate, crmController.deleteAutomationRule);

// Bulk Operations endpoints
router.post('/api/v1/bulk/contacts/import', authenticate, bulkController.bulkCreateContacts);
router.post('/api/v1/bulk/contacts/csv-import/upload', authenticate, bulkController.uploadCSV);
router.get('/api/v1/bulk/contacts/csv-import/:jobId/progress', authenticate, bulkController.getCSVProgress);
router.delete('/api/v1/bulk/contacts/csv-import/:jobId/cancel', authenticate, bulkController.cancelCSVImport);
router.post('/api/v1/bulk/contacts/update', authenticate, bulkController.bulkUpdateContacts);
router.post('/api/v1/bulk/contacts/delete', authenticate, bulkController.bulkDeleteContacts);
router.post('/api/v1/bulk/contacts/tag', authenticate, bulkController.bulkTagContacts);
router.post('/api/v1/bulk/contacts/untag', authenticate, bulkController.bulkUntagContacts);
router.post('/api/v1/bulk/messages/send', authenticate, bulkController.bulkSendMessage);
router.get('/api/v1/bulk/contacts/export', authenticate, bulkController.exportContacts);
router.get('/api/v1/bulk/status/:jobId', authenticate, bulkController.getBulkOperationStatus);

router.post('/bulk/contacts/import', authenticate, bulkController.bulkCreateContacts);
router.post('/bulk/contacts/csv-import/upload', authenticate, bulkController.uploadCSV);
router.get('/bulk/contacts/csv-import/:jobId/progress', authenticate, bulkController.getCSVProgress);
router.delete('/bulk/contacts/csv-import/:jobId/cancel', authenticate, bulkController.cancelCSVImport);
router.post('/bulk/contacts/update', authenticate, bulkController.bulkUpdateContacts);
router.post('/bulk/contacts/delete', authenticate, bulkController.bulkDeleteContacts);
router.post('/bulk/contacts/tag', authenticate, bulkController.bulkTagContacts);
router.post('/bulk/contacts/untag', authenticate, bulkController.bulkUntagContacts);
router.post('/bulk/messages/send', authenticate, bulkController.bulkSendMessage);
router.get('/bulk/contacts/export', authenticate, bulkController.exportContacts);
router.get('/bulk/status/:jobId', authenticate, bulkController.getBulkOperationStatus);

export default router;
