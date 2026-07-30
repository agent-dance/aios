import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationAdapter } from './applicationAdapter.js';
import { ApplicationEffectJournal } from './effectJournal.js';
import { createApplicationControlService } from './createApplicationControlService.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('createApplicationControlService', () => {
  it('preserves a corrupt journal, boots fail-closed, and advertises zero capabilities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alsniper-control-service-test-'));
    directories.push(directory);
    const path = join(directory, 'application-control.jsonl');
    const journal = await ApplicationEffectJournal.open(path);
    const request = {
      protocolVersion: 1 as const,
      intentId: 'intent-1',
      idempotencyKey: 'idem-1',
      principal: { kind: 'agent' as const, instanceId: 'agent-1', packageId: 'package-1', userId: 'user-1' },
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'secret' },
      expectedRevision: 1,
    };
    await journal.appendTerminalReceipt({
      request,
      requestFingerprint: journal.fingerprintRequest(request),
      principalFingerprint: journal.fingerprintPrincipal(request),
      status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'APPROVAL_DENIED',
    });
    await journal.close();
    const damaged = (await readFile(path, 'utf8')).replace('APPROVAL_DENIED', 'INVALID_ARGUMENT');
    await writeFile(path, damaged, 'utf8');

    const prepare = vi.fn();
    const commit = vi.fn();
    const adapter: ApplicationAdapter = {
      appId: 'wechat',
      listCapabilities: () => [{
        appId: 'wechat', actionId: 'wechat.message.send_to_current', adapterVersion: '1.0.0', risk: 'R3', requiresApproval: true,
      }],
      prepare,
      commit,
    };
    const logger = { error: vi.fn() };
    const service = await createApplicationControlService({
      journalPath: path,
      approval: { request: async () => true },
      adapters: [adapter],
      logger,
    });
    expect(service.listCapabilities()).toEqual([]);
    await expect(service.execute(request)).resolves.toMatchObject({
      status: 'rejected', errorCode: 'JOURNAL_UNAVAILABLE', journalSequence: 0,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(damaged);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    await service.close();
  });
});
