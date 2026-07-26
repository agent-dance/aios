import type { HealthResponse } from '../agent-platform/protocol';
import type { SidecarClient } from '../agent-platform/sidecarClient';

export interface SidecarHealthMonitor {
  dispose(): void;
}

interface HealthMonitorOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export const startSidecarHealthMonitor = (
  client: SidecarClient,
  publishHealth: (health: HealthResponse | undefined) => void,
  options: HealthMonitorOptions = {},
): SidecarHealthMonitor => {
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 300_000) {
    throw new TypeError('Health monitor interval must be between 100 and 300000ms.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new TypeError('Health monitor timeout must be between 100 and 300000ms.');
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const poll = async (): Promise<void> => {
    try {
      const health = await client.health({ signal: controller.signal, timeoutMs });
      if (!disposed) publishHealth(health);
    } catch {
      if (!disposed && !controller.signal.aborted) publishHealth(undefined);
    } finally {
      if (!disposed) timer = setTimeout(() => { void poll(); }, intervalMs);
    }
  };
  void poll();

  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    },
  });
};
