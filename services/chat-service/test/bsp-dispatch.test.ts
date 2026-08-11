import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchBspMessage, resolveAutomationText } from '../src/services/bsp-dispatch.js';

test('normalizes text from visual-workflow message nodes', () => {
  assert.equal(resolveAutomationText({}, { messageContent: 'welcome' }), 'welcome');
  assert.equal(resolveAutomationText({}, { body: 'rule reply' }), 'rule reply');
  assert.equal(resolveAutomationText({ text: 'direct text' }, { messageContent: 'fallback' }), 'direct text');
  assert.equal(resolveAutomationText({}, { messageContent: '   ' }), undefined);
});

test('sends the required correlation fields and returns the provider message ID', async (t) => {
  let requestBody: any;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      success: true,
      data: { success: true, providerMessageId: 'provider-message-1' },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  });

  const result = await dispatchBspMessage({
    bspUrl: 'http://service-provider',
    internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || 'dummy-test-key-for-unit-tests-only',
    workspaceId: 'workspace-1',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    appId: 'app-1',
    to: '911234567890',
    type: 'text',
    payload: { type: 'text', text: { body: 'welcome' } },
    internalMessageId: 'automation-message-1',
  });

  assert.equal(requestBody.internalMessageId, 'automation-message-1');
  assert.equal(requestBody.idempotencyKey, 'automation-message-1');
  assert.equal(requestBody.conversationId, 'conversation-1');
  assert.equal(requestBody.contactId, 'contact-1');
  assert.equal(result.providerMessageId, 'provider-message-1');
});

test('does not report success when service-provider rejects the dispatch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ statusCode: 500, message: 'internalMessageId is required' }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  ));

  await assert.rejects(
    dispatchBspMessage({
      bspUrl: 'http://service-provider',
      internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || 'dummy-test-key-for-unit-tests-only',
      workspaceId: 'workspace-1',
      appId: 'app-1',
      to: '911234567890',
      type: 'text',
      payload: {},
    }),
    /internalMessageId is required/,
  );
});

test('rejects a malformed success response without a provider message ID', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ success: true, data: { success: true } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));

  await assert.rejects(
    dispatchBspMessage({
      bspUrl: 'http://service-provider',
      internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || 'dummy-test-key-for-unit-tests-only',
      workspaceId: 'workspace-1',
      appId: 'app-1',
      to: '911234567890',
      type: 'text',
      payload: {},
    }),
    /provider message ID is missing/,
  );
});
