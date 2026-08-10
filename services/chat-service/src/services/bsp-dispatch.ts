import { randomUUID } from 'node:crypto';

export interface BspDispatchInput {
  bspUrl: string;
  internalServiceSecret: string;
  workspaceId: string;
  appId: string;
  to: string;
  type: string;
  payload: unknown;
  conversationId?: string;
  contactId?: string;
  campaignId?: string;
  internalMessageId?: string;
}

export interface BspDispatchResult {
  internalMessageId: string;
  providerMessageId: string;
  dispatchResult: any;
}

function providerError(body: any, fallback: string): string {
  return body?.message || body?.error?.message || body?.error || fallback;
}

/**
 * Dispatch an outbound message through service-provider with the correlation
 * fields required for idempotency and delivery-status callbacks.
 */
export async function dispatchBspMessage(input: BspDispatchInput): Promise<BspDispatchResult> {
  const internalMessageId = input.internalMessageId || randomUUID();
  const response = await fetch(`${input.bspUrl}/internal/v1/bsp/messages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-secret': input.internalServiceSecret,
      'x-internal-service': 'chat-service',
    },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      internalMessageId,
      idempotencyKey: internalMessageId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      campaignId: input.campaignId,
      appId: input.appId,
      to: input.to,
      type: input.type,
      payload: input.payload,
    }),
  });

  const rawBody = await response.text();
  let envelope: any = {};
  if (rawBody) {
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      envelope = { message: rawBody };
    }
  }

  if (!response.ok) {
    throw new Error(`BSP Message Dispatch failed (${response.status}): ${providerError(envelope, response.statusText)}`);
  }

  const dispatchResult = envelope?.data || envelope;
  if (!dispatchResult?.success) {
    throw new Error(`BSP Message Dispatch failed: ${providerError(dispatchResult, 'provider rejected the message')}`);
  }

  const providerMessageId = dispatchResult.providerMessageId || dispatchResult.messageId;
  if (!providerMessageId) {
    throw new Error('BSP Message Dispatch failed: provider message ID is missing');
  }

  return { internalMessageId, providerMessageId: String(providerMessageId), dispatchResult };
}
