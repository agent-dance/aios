import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationControlExecuteRequest } from '../../shared/applicationControlProtocol.js';
import type { ApplicationAdapter } from './applicationAdapter.js';
import { ApplicationControlHost } from './ApplicationControlHost.js';
import { ApplicationEffectJournal } from './effectJournal.js';
import { UnavailableApplicationControlService } from './UnavailableApplicationControlService.js';

const directories: string[] = [];

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'alsniper-control-host-test-'));
  directories.push(directory);
  return join(directory, 'application-control.jsonl');
}

function request(overrides: Partial<ApplicationControlExecuteRequest> = {}): ApplicationControlExecuteRequest {
  return {
    protocolVersion: 1,
    intentId: 'intent-1',
    idempotencyKey: 'idem-1',
    principal: {
      kind: 'agent',
      instanceId: 'domain-agent:assistant@1.0.0#sha256:abc:local',
      packageId: 'ai.alsniper.desktop-assistant@1.0.0',
      userId: 'user-1',
    },
    appId: 'wechat',
    actionId: 'wechat.message.send_to_current',
    arguments: { text: 'SENTINEL_MESSAGE_BODY' },
    expectedRevision: 2,
    ...overrides,
  };
}

function adapter(commit = vi.fn(async ({ grant, prepared }) => {
  grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
  return { status: 'committed' as const };
})): ApplicationAdapter {
  return {
    appId: 'wechat',
    listCapabilities: () => [{
      appId: 'wechat', actionId: 'wechat.message.send_to_current', adapterVersion: '1.0.0', risk: 'R3', requiresApproval: true,
    }],
    prepare: vi.fn(async () => ({
      preparedFingerprint: 'a'.repeat(64),
      approval: {
        title: '确认发送', message: '将发送消息', detail: 'SENTINEL_MESSAGE_BODY', confirmLabel: '发送',
      },
      state: Object.freeze({}),
    })),
    commit,
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('ApplicationControlHost', () => {
  it('requires native approval, dispatches once, and reuses the durable receipt', async () => {
    const path = await journalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const commit = vi.fn(async ({ grant, prepared }) => {
      grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
      return { status: 'committed' as const };
    });
    const approval = { request: vi.fn(async () => true) };
    const host = new ApplicationControlHost({ journal, approval });
    await host.initialize();
    await host.registerAdapter(adapter(commit));

    const first = await host.execute(request());
    const repeated = await host.execute(request());
    expect(first.status).toBe('committed');
    expect(repeated).toEqual(first);
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(host.getReceipt({
      protocolVersion: 1, idempotencyKey: 'idem-1', principal: request().principal,
    })).toEqual(first);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: 'idem-1',
      principal: { ...request().principal, userId: 'other-user' },
    })).toBeNull();
    await host.close();
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('SENTINEL_MESSAGE_BODY');
    const receiptIds = raw.trim().split('\n').map((line) => (
      (JSON.parse(line) as { payload: { receiptId: string } }).payload.receiptId
    ));
    expect(receiptIds).toEqual([first.receiptId, first.receiptId]);
  });

  it('persists conflict without replacing the canonical receipt', async () => {
    const path = await journalPath();
    const host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => true },
    });
    const appAdapter = adapter();
    await host.initialize();
    await host.registerAdapter(appAdapter);
    const original = await host.execute(request());
    const conflict = await host.execute(request({ arguments: { text: 'different' } }));
    expect(conflict).toMatchObject({ status: 'rejected', errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(host.getReceipt({
      protocolVersion: 1, idempotencyKey: 'idem-1', principal: request().principal,
    })).toEqual(original);
    expect(appAdapter.commit).toHaveBeenCalledTimes(1);
    const bytesAfterFirstConflict = (await readFile(path)).byteLength;
    for (let index = 0; index < 20; index += 1) {
      const repeatedConflict = await host.execute(request({ arguments: { text: `different-${index}` } }));
      expect(repeatedConflict.receiptId).toBe(conflict.receiptId);
    }
    const differentlyShapedConflictRequest = request({
      intentId: 'intent-other',
      appId: 'calendar',
      actionId: 'calendar.event.create',
      arguments: { title: 'different operation' },
    });
    const differentlyShapedConflict = await host.execute(differentlyShapedConflictRequest);
    expect(differentlyShapedConflict).toMatchObject({
      receiptId: conflict.receiptId,
      intentId: differentlyShapedConflictRequest.intentId,
      idempotencyKey: differentlyShapedConflictRequest.idempotencyKey,
      appId: differentlyShapedConflictRequest.appId,
      actionId: differentlyShapedConflictRequest.actionId,
      status: 'rejected',
      errorCode: 'IDEMPOTENCY_CONFLICT',
    });
    expect((await readFile(path)).byteLength).toBe(bytesAfterFirstConflict);
    await host.close();
  });

  it('scopes idempotency to principal and permits a later turn to reuse the model intent ID', async () => {
    const path = await journalPath();
    const appAdapter = adapter();
    const host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => true },
    });
    await host.initialize();
    await host.registerAdapter(appAdapter);

    const first = await host.execute(request());
    const laterTurn = await host.execute(request({
      idempotencyKey: 'idem-later-turn',
      arguments: { text: 'later turn' },
    }));
    const otherPrincipal = await host.execute(request({
      principal: { ...request().principal, instanceId: 'agent-2' },
      arguments: { text: 'other principal scope' },
    }));

    expect(first.status).toBe('committed');
    expect(laterTurn.status).toBe('committed');
    expect(otherPrincipal.status).toBe('committed');
    expect(appAdapter.commit).toHaveBeenCalledTimes(3);
    await host.close();
  });

  it('never dispatches when native approval is denied', async () => {
    const path = await journalPath();
    const appAdapter = adapter();
    const host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => false },
    });
    await host.initialize();
    await host.registerAdapter(appAdapter);
    await expect(host.execute(request())).resolves.toMatchObject({
      status: 'rejected', errorCode: 'APPROVAL_DENIED', approvedByUser: false,
    });
    expect(appAdapter.commit).not.toHaveBeenCalled();
    await host.close();
  });

  it('centrally rejects approval text containing bidi or control-character spoofing', async () => {
    const path = await journalPath();
    const appAdapter = adapter();
    appAdapter.prepare = vi.fn(async () => ({
      preparedFingerprint: 'a'.repeat(64),
      approval: {
        title: '确认发送\u202e伪造',
        message: '将发送消息',
        detail: 'recipient\nbody',
        confirmLabel: '发送',
      },
      state: Object.freeze({}),
    }));
    const approval = { request: vi.fn(async () => true) };
    const host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval,
    });
    await host.initialize();
    await host.registerAdapter(appAdapter);
    await expect(host.execute(request())).resolves.toMatchObject({
      status: 'rejected', errorCode: 'PRECONDITION_FAILED', approvedByUser: false,
    });
    expect(approval.request).not.toHaveBeenCalled();
    expect(appAdapter.commit).not.toHaveBeenCalled();
    await host.close();
  });

  it('returns non-retryable unknown after the durable fence and redacts adapter errors from logs', async () => {
    const path = await journalPath();
    const logger = { error: vi.fn() };
    const appAdapter = adapter(vi.fn(async ({ grant, prepared }) => {
      grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
      throw new Error('SENTINEL_SECRET_RECIPIENT_AND_BODY');
    }));
    const host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => true },
      logger,
    });
    await host.initialize();
    await host.registerAdapter(appAdapter);
    const receipt = await host.execute(request());
    expect(receipt).toMatchObject({ status: 'unknown', retryable: false, errorCode: 'INTERNAL_ERROR' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SENTINEL_SECRET_RECIPIENT_AND_BODY');
    expect(await readFile(path, 'utf8')).not.toContain('SENTINEL_SECRET_RECIPIENT_AND_BODY');
    await host.close();
  });

  it('turns a malformed post-fence adapter result into a durable legal Unknown that survives reopen', async () => {
    const path = await journalPath();
    let commitCalls = 0;
    const malformedAdapter = adapter(vi.fn(async ({ grant, prepared }) => {
      commitCalls += 1;
      grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
      return { status: 'committed' as const, retryable: true };
    }));
    let host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => true },
    });
    await host.initialize();
    await host.registerAdapter(malformedAdapter);
    const first = await host.execute(request());
    expect(first).toMatchObject({ status: 'unknown', retryable: false, errorCode: 'INTERNAL_ERROR' });
    await host.close();

    host = new ApplicationControlHost({
      journal: await ApplicationEffectJournal.open(path),
      approval: { request: async () => true },
    });
    await host.initialize();
    await host.registerAdapter(malformedAdapter);
    const reopened = await host.execute(request());
    expect(reopened).toEqual(first);
    expect(commitCalls).toBe(1);
    await host.close();
  });

  it('drops capabilities when the journal becomes unhealthy and preserves a fence receipt ID after reopen', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const closingAdapter = adapter(vi.fn(async ({ grant, prepared }) => {
      grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
      await journal.close();
      return { status: 'committed' as const };
    }));
    let host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(closingAdapter);
    const unknown = await host.execute(request());
    expect(unknown).toMatchObject({
      status: 'unknown',
      retryable: false,
      errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
    });
    expect(host.listCapabilities()).toEqual([]);
    expect(await host.execute(request())).toEqual(unknown);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: request().idempotencyKey,
      principal: request().principal,
    })).toEqual(unknown);
    await host.close();

    journal = await ApplicationEffectJournal.open(path);
    host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(adapter());
    const recovered = await host.execute(request());
    expect(recovered).toEqual(unknown);
    await host.close();
  });

  it('returns a stable journal-unavailable refusal when persistence fails before the dispatch fence', async () => {
    const path = await journalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const appAdapter = adapter();
    const host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(appAdapter);
    expect(host.listCapabilities()).toHaveLength(1);
    await truncate(path, 64 * 1024 * 1024);

    const refusal = await host.execute(request());
    expect(refusal).toMatchObject({
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      journalSequence: 0,
      errorCode: 'JOURNAL_UNAVAILABLE',
    });
    expect(appAdapter.commit).not.toHaveBeenCalled();
    expect(host.listCapabilities()).toEqual([]);
    expect(await host.execute(request())).toEqual(refusal);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: request().idempotencyKey,
      principal: request().principal,
    })).toEqual(refusal);
    await host.close();
  });

  it('keeps the anchored fence Unknown when a terminal record cannot cross the head commit boundary', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    let priorHead = '';
    const checkpointFailingAdapter = adapter(vi.fn(async ({ grant, prepared }) => {
      grant.consume(grant.requestFingerprint, prepared.preparedFingerprint);
      priorHead = await readFile(`${path}.head`, 'utf8');
      await rm(`${path}.head`);
      await mkdir(`${path}.head`);
      return { status: 'committed' as const };
    }));
    let host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(checkpointFailingAdapter);

    const unknown = await host.execute(request());
    expect(unknown).toMatchObject({
      status: 'unknown',
      retryable: false,
      errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
    });
    expect(host.listCapabilities()).toEqual([]);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: request().idempotencyKey,
      principal: request().principal,
    })).toEqual(unknown);
    expect(await host.execute(request())).toEqual(unknown);
    await host.close();

    await rm(`${path}.head`, { recursive: true });
    await writeFile(`${path}.head`, priorHead, 'utf8');
    journal = await ApplicationEffectJournal.open(path);
    host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(adapter());
    expect(await host.execute(request())).toEqual(unknown);
    await host.close();
  });

  it('never commits when a dispatch fence cannot cross the durable head boundary', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const priorHead = await readFile(`${path}.head`, 'utf8');
    const appAdapter = adapter();
    let host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter(appAdapter);
    await rm(`${path}.head`);
    await mkdir(`${path}.head`);

    const refusal = await host.execute(request());
    expect(refusal).toMatchObject({
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      journalSequence: 0,
      errorCode: 'JOURNAL_UNAVAILABLE',
    });
    expect(appAdapter.commit).not.toHaveBeenCalled();
    expect(host.listCapabilities()).toEqual([]);
    expect(await host.execute(request())).toEqual(refusal);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: request().idempotencyKey,
      principal: request().principal,
    })).toEqual(refusal);
    await host.close();

    await rm(`${path}.head`, { recursive: true });
    await writeFile(`${path}.head`, priorHead, 'utf8');
    journal = await ApplicationEffectJournal.open(path);
    expect((await readFile(path)).byteLength).toBe(0);
    host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: request().idempotencyKey,
      principal: request().principal,
    })).toBeNull();
    await host.close();
  });

  it('preserves an Unknown receipt when reconciliation has no new evidence', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
    });
    await journal.close();

    let receiptId = '';
    let size = 0;
    for (let launch = 0; launch < 3; launch += 1) {
      journal = await ApplicationEffectJournal.open(path);
      const host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
      await host.initialize();
      const appAdapter = { ...adapter(), reconcile: vi.fn(async () => ({ status: 'unknown' as const })) };
      await host.registerAdapter(appAdapter);
      const receipt = host.getReceipt({
        protocolVersion: 1, idempotencyKey: 'idem-1', principal: candidate.principal,
      });
      if (launch === 0) receiptId = receipt?.receiptId ?? '';
      else expect(receipt?.receiptId).toBe(receiptId);
      await host.close();
      const nextSize = (await readFile(path)).byteLength;
      if (launch === 0) size = nextSize;
      else expect(nextSize).toBe(size);
    }
  });

  it('does not append a malformed reconciliation result', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
    });
    await journal.close();

    journal = await ApplicationEffectJournal.open(path);
    const host = new ApplicationControlHost({
      journal,
      approval: { request: async () => true },
      logger: { error: vi.fn() },
    });
    await host.initialize();
    const bytesBeforeReconcile = (await readFile(path)).byteLength;
    const malformedReconcile = vi.fn(async () => ({
      status: 'committed' as const,
      retryable: true,
    }));
    await host.registerAdapter({ ...adapter(), reconcile: malformedReconcile });
    expect(malformedReconcile).toHaveBeenCalledTimes(1);
    expect((await readFile(path)).byteLength).toBe(bytesBeforeReconcile);
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: candidate.idempotencyKey,
      principal: candidate.principal,
    })).toMatchObject({ status: 'unknown', retryable: false });
    await host.close();
  });

  it('normalizes a failed reconciliation without an error code into a durable legal receipt', async () => {
    const path = await journalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
    });
    await journal.close();

    journal = await ApplicationEffectJournal.open(path);
    let host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    await host.registerAdapter({
      ...adapter(),
      reconcile: vi.fn(async () => ({ status: 'failed' as const })),
    });
    const failed = host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: candidate.idempotencyKey,
      principal: candidate.principal,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      retryable: false,
      errorCode: 'INTERNAL_ERROR',
    });
    await host.close();

    journal = await ApplicationEffectJournal.open(path);
    host = new ApplicationControlHost({ journal, approval: { request: async () => true } });
    await host.initialize();
    expect(host.getReceipt({
      protocolVersion: 1,
      idempotencyKey: candidate.idempotencyKey,
      principal: candidate.principal,
    })).toEqual(failed);
    await host.close();
  });
});

describe('UnavailableApplicationControlService', () => {
  it('advertises no capabilities and returns stable fail-closed refusals without dispatch', async () => {
    const service = new UnavailableApplicationControlService();
    expect(service.listCapabilities()).toEqual([]);
    const first = await service.execute(request());
    const second = await service.execute(request());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'rejected', errorCode: 'JOURNAL_UNAVAILABLE', retryable: false, journalSequence: 0,
    });
    const changedRequest = request({
      intentId: 'different-intent',
      appId: 'calendar',
      actionId: 'calendar.event.create',
      arguments: { title: 'different operation' },
    });
    const correlated = await service.execute(changedRequest);
    expect(correlated).toMatchObject({
      receiptId: first.receiptId,
      intentId: changedRequest.intentId,
      idempotencyKey: changedRequest.idempotencyKey,
      appId: changedRequest.appId,
      actionId: changedRequest.actionId,
      errorCode: 'JOURNAL_UNAVAILABLE',
      journalSequence: 0,
    });
    await service.close();
  });
});
