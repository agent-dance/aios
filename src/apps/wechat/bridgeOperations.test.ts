import { describe, expect, it, vi } from 'vitest';
import type { WeChatEmbeddedViewBridge } from './bridge';
import { enqueueWeChatBridgeOperation } from './bridgeOperations';

describe('WeChat bridge operation ordering', () => {
  it('serializes StrictMode mount, cleanup, and remount without overlapping native mutations', async () => {
    const bridge = {} as WeChatEmbeddedViewBridge;
    const order: string[] = [];
    let finishFirstMount: (() => void) | undefined;
    const firstMount = enqueueWeChatBridgeOperation(bridge, async () => {
      order.push('mount:first:start');
      await new Promise<void>((resolve) => { finishFirstMount = resolve; });
      order.push('mount:first:end');
    });
    const cleanup = enqueueWeChatBridgeOperation(bridge, async () => { order.push('unmount:first'); });
    const secondMount = enqueueWeChatBridgeOperation(bridge, async () => { order.push('mount:second'); });

    await Promise.resolve();
    expect(order).toEqual(['mount:first:start']);
    finishFirstMount?.();
    await Promise.all([firstMount, cleanup, secondMount]);
    expect(order).toEqual(['mount:first:start', 'mount:first:end', 'unmount:first', 'mount:second']);
  });

  it('continues the queue after a rejected host operation', async () => {
    const bridge = {} as WeChatEmbeddedViewBridge;
    const later = vi.fn(async () => 'ready');
    const failed = enqueueWeChatBridgeOperation(bridge, async () => {
      throw new Error('expected failure');
    });
    const recovered = enqueueWeChatBridgeOperation(bridge, later);

    await expect(failed).rejects.toThrow('expected failure');
    await expect(recovered).resolves.toBe('ready');
    expect(later).toHaveBeenCalledOnce();
  });
});
