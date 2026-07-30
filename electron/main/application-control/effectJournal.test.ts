import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplicationControlExecuteRequest } from '../../shared/applicationControlProtocol.js';
import { ApplicationEffectJournal, EffectJournalIntegrityError, writeAll } from './effectJournal.js';

const directories: string[] = [];

async function createJournalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'alsniper-effect-journal-test-'));
  directories.push(directory);
  return join(directory, 'trust', 'application-control-v1.jsonl');
}

function request(text = 'SENTINEL_MESSAGE_BODY'): ApplicationControlExecuteRequest {
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
    arguments: { text },
    expectedRevision: 1,
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('ApplicationEffectJournal', () => {
  it('write-all handles injected short writes and rejects zero progress', async () => {
    const chunks: Buffer[] = [];
    const shortWriter = {
      write: async (buffer: Uint8Array, offset: number, length: number) => {
        const bytesWritten = Math.min(2, length);
        chunks.push(Buffer.from(buffer).subarray(offset, offset + bytesWritten));
        return { bytesWritten, buffer };
      },
    };
    await writeAll(shortWriter as never, 'abcdefg');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('abcdefg');

    const stalledWriter = {
      write: async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer }),
    };
    await expect(writeAll(stalledWriter as never, 'x')).rejects.toThrow('forward progress');
  });

  it('syncs a privacy-preserving dispatch fence and recovers it as immutable unknown', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = {
      ...request(),
      intentId: 'CONTACT_ALICE_SENTINEL',
      idempotencyKey: 'MESSAGE_BODY_SENTINEL_KEY',
    };
    const requestFingerprint = journal.fingerprintRequest(candidate);
    await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint,
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
      targetFingerprint: 'b'.repeat(64),
      effectFingerprint: 'c'.repeat(64),
    });
    await journal.close();

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('SENTINEL_MESSAGE_BODY');
    expect(raw).not.toContain('CONTACT_ALICE_SENTINEL');
    expect(raw).not.toContain('MESSAGE_BODY_SENTINEL_KEY');
    expect(raw).not.toContain('recipient');
    expect(raw).not.toContain('b'.repeat(64));
    expect(raw).not.toContain('c'.repeat(64));

    const reopened = await ApplicationEffectJournal.open(path);
    const recovered = await reopened.recoverInterruptedDispatches();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'unknown',
      retryable: false,
      errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
    });
    const receipt = reopened.getLatestReceipt('MESSAGE_BODY_SENTINEL_KEY');
    expect(receipt?.receiptId).toBe(recovered[0]?.receiptId);
    await reopened.close();
  });

  it('rejects impossible receipt payloads before writing any journal bytes', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    const before = await readFile(path);

    await expect(journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'committed',
      approvedByUser: true,
      retryable: true,
    })).rejects.toThrow('impossible');

    expect(await readFile(path)).toEqual(before);
    expect(journal.isHealthy).toBe(true);
    await journal.close();
  });

  it('latches capacity exhaustion as unhealthy so no later dispatch can be advertised', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    await truncate(path, 64 * 1024 * 1024);
    const candidate = request();

    await expect(journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      errorCode: 'APPROVAL_DENIED',
    })).rejects.toThrow('capacity is exhausted');

    expect(journal.isHealthy).toBe(false);
    await journal.close();
  });

  it('does not append duplicate restart recovery records across repeated launches', async () => {
    const path = await createJournalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
    });
    await journal.close();

    let stableReceiptId = '';
    let stableSize = 0;
    for (let launch = 0; launch < 3; launch += 1) {
      journal = await ApplicationEffectJournal.open(path);
      const recovered = await journal.recoverInterruptedDispatches();
      if (launch === 0) expect(recovered).toHaveLength(1);
      else expect(recovered).toHaveLength(0);
      const receipt = journal.getLatestReceipt('idem-1');
      if (launch === 0) stableReceiptId = receipt?.receiptId ?? '';
      else expect(receipt?.receiptId).toBe(stableReceiptId);
      await journal.close();
      const size = (await readFile(path)).byteLength;
      if (launch === 0) stableSize = size;
      else expect(size).toBe(stableSize);
    }
  });

  it('discards an uncommitted terminal tail and recovers the anchored fence without changing its receipt', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    const requestFingerprint = journal.fingerprintRequest(candidate);
    const fence = await journal.appendDispatchFence({
      request: candidate,
      requestFingerprint,
      preparedFingerprint: 'a'.repeat(64),
      approvedByUser: true,
    });
    const preTerminalHead = await readFile(`${path}.head`, 'utf8');
    await journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint,
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      receiptId: fence.receiptId,
      status: 'committed',
      approvedByUser: true,
      retryable: false,
      dispatchReceiptId: fence.receiptId,
    });
    const completedTerminalHead = await readFile(`${path}.head`, 'utf8');
    await journal.close();

    // This is the exact durable state after record write+fsync succeeds but the
    // atomic head rename does not: the prior head remains and a completed temp
    // head may be left behind.
    await writeFile(`${path}.head`, preTerminalHead, 'utf8');
    await writeFile(`${path}.head.99999999.00000000-0000-0000-0000-000000000000.tmp`, completedTerminalHead, 'utf8');

    const reopened = await ApplicationEffectJournal.open(path);
    const beforeRecovery = reopened.getLatestReceipt(candidate.idempotencyKey);
    expect(beforeRecovery).toMatchObject({
      receiptId: fence.receiptId,
      status: 'unknown',
      errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
    });
    expect(await reopened.recoverInterruptedDispatches()).toEqual([beforeRecovery]);
    await reopened.close();
  });

  it('recovers a large indexed set exactly once while preserving every dispatch receipt ID', async () => {
    const path = await createJournalPath();
    let journal = await ApplicationEffectJournal.open(path);
    const receiptIds = new Map<string, string>();
    const effectCount = 128;
    for (let index = 0; index < effectCount; index += 1) {
      const candidate = request(`message-${index}`);
      const scoped = {
        ...candidate,
        intentId: `intent-${index}`,
        idempotencyKey: `idem-${index}`,
      };
      const fence = await journal.appendDispatchFence({
        request: scoped,
        requestFingerprint: journal.fingerprintRequest(scoped),
        preparedFingerprint: 'a'.repeat(64),
        approvedByUser: true,
      });
      receiptIds.set(scoped.idempotencyKey, fence.receiptId);
    }
    await journal.close();

    journal = await ApplicationEffectJournal.open(path);
    expect(journal.listUnresolvedEffects()).toHaveLength(effectCount);
    const recovered = await journal.recoverInterruptedDispatches();
    expect(recovered).toHaveLength(effectCount);
    for (const [idempotencyKey, receiptId] of receiptIds) {
      expect(journal.getLatestReceipt(idempotencyKey)?.receiptId).toBe(receiptId);
    }
    expect(await journal.recoverInterruptedDispatches()).toHaveLength(0);
    await journal.close();
  });

  it('fails closed for modified records, missing keys, and durable-head truncation', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      errorCode: 'APPROVAL_DENIED',
    });
    await journal.close();

    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('APPROVAL_DENIED', 'INVALID_ARGUMENT'), 'utf8');
    await expect(ApplicationEffectJournal.open(path)).rejects.toBeInstanceOf(EffectJournalIntegrityError);
    await writeFile(path, original, 'utf8');
    await rm(`${path}.key`);
    await expect(ApplicationEffectJournal.open(path)).rejects.toThrow('integrity key is missing');
  });

  it('detects complete-record tail deletion using the durable head', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'APPROVAL_DENIED',
    });
    await journal.close();
    await truncate(path, 0);
    await expect(ApplicationEffectJournal.open(path)).rejects.toThrow('truncated');
  });

  it('truncates an incomplete record after the authenticated durable head', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    const receipt = await journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      errorCode: 'APPROVAL_DENIED',
    });
    await journal.close();
    const committedBytes = (await readFile(path)).byteLength;
    await appendFile(path, '{"uncommitted":', 'utf8');

    const reopened = await ApplicationEffectJournal.open(path);
    expect(reopened.getLatestReceipt(candidate.idempotencyKey)).toEqual(receipt);
    expect((await readFile(path)).byteLength).toBe(committedBytes);
    await reopened.close();
  });

  it('ignores a torn temporary head while retaining the last atomically renamed checkpoint', async () => {
    const path = await createJournalPath();
    const journal = await ApplicationEffectJournal.open(path);
    const candidate = request();
    await journal.appendTerminalReceipt({
      request: candidate,
      requestFingerprint: journal.fingerprintRequest(candidate),
      principalFingerprint: journal.fingerprintPrincipal(candidate),
      status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'APPROVAL_DENIED',
    });
    await journal.close();
    await writeFile(`${path}.head.99999999.00000000-0000-0000-0000-000000000000.tmp`, '{"schemaVersion":', 'utf8');

    const reopened = await ApplicationEffectJournal.open(path);
    expect(reopened.getLatestReceipt('idem-1')).toMatchObject({ status: 'rejected' });
    await reopened.close();
  });
});
