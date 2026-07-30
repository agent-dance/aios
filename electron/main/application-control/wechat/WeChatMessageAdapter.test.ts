import { describe, expect, it, vi } from 'vitest';
import type { ApplicationControlExecuteRequest } from '../../../shared/applicationControlProtocol.js';
import type { ApplicationControlGrant } from '../applicationAdapter.js';
import type { WeChatAutomationTarget } from './weChatAutomationTarget.js';
import {
  WECHAT_SEND_TO_CURRENT_ACTION_ID,
  WeChatApplicationControlError,
  WeChatMessageAdapter,
} from './WeChatMessageAdapter.js';

function createRequest(text = '你好 👋\n今晚八点见'): ApplicationControlExecuteRequest {
  return {
    protocolVersion: 1,
    intentId: 'intent-1',
    idempotencyKey: 'idempotency-1',
    principal: {
      kind: 'agent',
      instanceId: 'instance-1',
      packageId: 'package-1',
      userId: 'user-1',
    },
    appId: 'wechat',
    actionId: WECHAT_SEND_TO_CURRENT_ACTION_ID,
    arguments: { text },
    expectedRevision: 0,
  };
}

function createTarget(
  commitResult: unknown = { kind: 'committed', dispatched: true },
): WeChatAutomationTarget & { current: boolean; execute: ReturnType<typeof vi.fn> } {
  const target = {
    binding: { controllerGeneration: 3, documentSequence: 7, origin: 'https://wx.qq.com' },
    current: true,
    isCurrent() {
      return this.current;
    },
    execute: vi.fn(async (input: { operation: string; rootToken: string }) => input.operation === 'prepare'
      ? {
          kind: 'prepared',
          rootToken: input.rootToken,
          recipientUsername: '@@opaque-chat-id',
          recipientTitle: '项目讨论组',
        }
      : commitResult),
    prepareMessage(input: { operation: 'prepare'; rootToken: string }) {
      return this.execute(input, false);
    },
    commitMessage(input: { operation: 'commit'; rootToken: string }) {
      return this.execute(input, true);
    },
  };
  return target;
}

function createGrant(preparedFingerprint: string) {
  let consumed = false;
  const grant: ApplicationControlGrant = {
    grantId: 'grant-1',
    requestFingerprint: 'host-request-fingerprint',
    preparedFingerprint,
    expiresAt: Date.now() + 10_000,
    consume(expectedRequestFingerprint, expectedPreparedFingerprint) {
      if (consumed) throw new Error('grant replay');
      expect(expectedRequestFingerprint).toBe(this.requestFingerprint);
      expect(expectedPreparedFingerprint).toBe(this.preparedFingerprint);
      consumed = true;
    },
  };
  return { grant, wasConsumed: () => consumed };
}

describe('WeChatMessageAdapter', () => {
  it('advertises only a versioned R3, approval-gated semantic send capability', () => {
    const adapter = new WeChatMessageAdapter(() => null);
    expect(adapter.listCapabilities()).toEqual([{
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      adapterVersion: '1.0.0',
      risk: 'R3',
      requiresApproval: true,
    }]);
  });

  it('keeps recipient and body only in the memory-owned approval and prepared state', async () => {
    const target = createTarget();
    const request = createRequest();
    const adapter = new WeChatMessageAdapter(() => target);

    const prepared = await adapter.prepare(request);

    expect(prepared.approval.detail).toContain('"项目讨论组"');
    expect(prepared.approval.detail).toContain('"你好 👋\\n今晚八点见"');
    expect(prepared.reconciliation).toBeUndefined();
    expect(prepared.preparedFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a DOM-supplied display title containing approval-spoofing bidi controls', async () => {
    const target = createTarget();
    target.execute.mockImplementationOnce(async (input: { rootToken: string }) => ({
      kind: 'prepared',
      rootToken: input.rootToken,
      recipientUsername: '@@opaque-chat-id',
      recipientTitle: '可信名称\u202e：伪造收件人',
    }));
    const adapter = new WeChatMessageAdapter(() => target);

    await expect(adapter.prepare(createRequest())).rejects.toMatchObject({
      errorCode: 'PRECONDITION_FAILED',
    });
  });

  it('rejects drafts/profile drift without leaking recipient or body through the error', async () => {
    const target = createTarget();
    target.execute.mockResolvedValueOnce({
      kind: 'precondition-failed',
      reason: 'draft-present',
      dispatched: false,
    });
    const adapter = new WeChatMessageAdapter(() => target);
    const request = createRequest('机密正文');

    const error = await adapter.prepare(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeChatApplicationControlError);
    expect((error as WeChatApplicationControlError).errorCode).toBe('PRECONDITION_FAILED');
    expect(String(error)).not.toContain('机密正文');
    expect(String(error)).not.toContain('draft-present');
  });

  it.each([
    ['', 'blank'],
    ['\ufeff', 'bom-only'],
    ['\0', 'nul'],
    ['x'.repeat(4_001), 'over-limit'],
    ['正文\u202e收件人：伪造', 'bidi-override'],
    ['正文\u0007提示音', 'control'],
    ['\ud800', 'lone-high-surrogate'],
    ['\udc00', 'lone-low-surrogate'],
  ])('rejects invalid message input (%s)', async (text) => {
    const target = createTarget();
    const adapter = new WeChatMessageAdapter(() => target);
    await expect(adapter.prepare(createRequest(text))).rejects.toMatchObject({
      errorCode: 'INVALID_ARGUMENT',
    });
    expect(target.execute).not.toHaveBeenCalled();
  });

  it('consumes the grant before dispatch, then maps status 2 to committed', async () => {
    const target = createTarget();
    const adapter = new WeChatMessageAdapter(() => target);
    const request = createRequest();
    const prepared = await adapter.prepare(request);
    const { grant, wasConsumed } = createGrant(prepared.preparedFingerprint);
    target.execute.mockImplementationOnce(async (input: { operation: string }) => {
      expect(input.operation).toBe('commit');
      expect(wasConsumed()).toBe(true);
      return { kind: 'committed', dispatched: true };
    });

    await expect(adapter.commit({ request, prepared, grant })).resolves.toEqual({
      status: 'committed',
      retryable: false,
    });
  });

  it('maps status 5 to failed and a pending timeout to non-retryable unknown', async () => {
    const failedTarget = createTarget({ kind: 'failed', dispatched: true });
    const failedAdapter = new WeChatMessageAdapter(() => failedTarget);
    const request = createRequest();
    const failedPrepared = await failedAdapter.prepare(request);
    const failedGrant = createGrant(failedPrepared.preparedFingerprint).grant;
    await expect(failedAdapter.commit({ request, prepared: failedPrepared, grant: failedGrant })).resolves.toEqual({
      status: 'failed',
      retryable: false,
    });

    const pendingTarget = createTarget({ kind: 'unknown', dispatched: true });
    const pendingAdapter = new WeChatMessageAdapter(() => pendingTarget);
    const pendingPrepared = await pendingAdapter.prepare(request);
    const pendingGrant = createGrant(pendingPrepared.preparedFingerprint).grant;
    await expect(pendingAdapter.commit({ request, prepared: pendingPrepared, grant: pendingGrant })).resolves.toEqual({
      status: 'unknown',
      retryable: false,
      errorCode: 'RECONCILIATION_FAILED',
    });
  });

  it('fails safely when navigation happens before dispatch and returns unknown after dispatch may have started', async () => {
    const beforeTarget = createTarget();
    const beforeAdapter = new WeChatMessageAdapter(() => beforeTarget);
    const request = createRequest();
    const beforePrepared = await beforeAdapter.prepare(request);
    beforeTarget.current = false;
    const beforeGrant = createGrant(beforePrepared.preparedFingerprint).grant;
    await expect(beforeAdapter.commit({ request, prepared: beforePrepared, grant: beforeGrant })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'PRECONDITION_FAILED',
    });
    expect(beforeTarget.execute).toHaveBeenCalledTimes(1);

    const afterTarget = createTarget();
    const afterAdapter = new WeChatMessageAdapter(() => afterTarget);
    const afterPrepared = await afterAdapter.prepare(request);
    const afterGrant = createGrant(afterPrepared.preparedFingerprint).grant;
    afterTarget.execute.mockImplementationOnce(() => new Promise(() => undefined));
    setTimeout(() => { afterTarget.current = false; }, 5);
    await expect(afterAdapter.commit({ request, prepared: afterPrepared, grant: afterGrant })).resolves.toMatchObject({
      status: 'unknown',
      retryable: false,
    });
  });

  it('never dispatches a second click when a prepared action is committed twice', async () => {
    const target = createTarget();
    const adapter = new WeChatMessageAdapter(() => target);
    const request = createRequest();
    const prepared = await adapter.prepare(request);
    await adapter.commit({ request, prepared, grant: createGrant(prepared.preparedFingerprint).grant });

    const replayResult = await adapter.commit({
      request,
      prepared,
      grant: createGrant(prepared.preparedFingerprint).grant,
    });

    expect(replayResult).toMatchObject({ status: 'failed', errorCode: 'REPLAY_REJECTED' });
    expect(target.execute).toHaveBeenCalledTimes(2);
  });
});
