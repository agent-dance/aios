import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse, SidecarClient } from '../agent-platform';
import { startSidecarHealthMonitor } from './healthMonitor';

const health = (status: HealthResponse['status']): HealthResponse => ({
  protocolVersion: '1.0.0',
  status,
  agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
  limits: { maxBodyBytes: 262_144, maxConcurrentRuns: 4 },
  checks: [],
});

const clientWithHealth = (run: SidecarClient['health']): SidecarClient => ({
  health: run,
  chat: async () => { throw new Error('not used'); },
  decide: async () => { throw new Error('not used'); },
});

describe('sidecar health monitor', () => {
  afterEach(() => vi.useRealTimers());

  it('polls serially, reports reconnect and disconnect, and stops after disposal', async () => {
    vi.useFakeTimers();
    const states = [health('ready'), new Error('offline'), health('not_ready')];
    const run = vi.fn<SidecarClient['health']>(async () => {
      const next = states.shift();
      if (next instanceof Error) throw next;
      return next ?? health('ready');
    });
    const publish = vi.fn();
    const monitor = startSidecarHealthMonitor(clientWithHealth(run), publish, { intervalMs: 100, timeoutMs: 100 });
    await Promise.resolve();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenLastCalledWith(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'not_ready' }));
    expect(run).toHaveBeenCalledTimes(3);

    monitor.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('aborts an in-flight health request without publishing a false disconnect', async () => {
    let capturedSignal: AbortSignal | undefined;
    const run = vi.fn<SidecarClient['health']>((options) => new Promise((_resolve, reject) => {
      capturedSignal = options?.signal;
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const publish = vi.fn();
    const monitor = startSidecarHealthMonitor(clientWithHealth(run), publish, { intervalMs: 100, timeoutMs: 100 });
    expect(capturedSignal?.aborted).toBe(false);
    monitor.dispose();
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });
});
