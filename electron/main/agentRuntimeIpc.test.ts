import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL } from '../shared/agentRuntimeProtocol.js';
import { registerAgentRuntimeIpc } from './agentRuntimeIpc.js';

const CONFIG = Object.freeze({
  baseUrl: 'http://127.0.0.1:4317',
  token: 'u'.repeat(32),
  origin: 'app://alsniper',
});

function harness(frameUrl = 'app://alsniper/index.html', config: typeof CONFIG | null = CONFIG) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const frameIpc = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel)),
  };
  const frame = { ipc: frameIpc, url: frameUrl, parent: null, isDestroyed: vi.fn(() => false) };
  const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false) };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
  const dispose = registerAgentRuntimeIpc(
    window,
    new URL('app://alsniper/index.html'),
    config ?? undefined,
  );
  return { handlers, frame, contents, window, dispose };
}

describe('Agent Runtime IPC router', () => {
  it('returns independent in-memory copies to repeated trusted main-frame calls', () => {
    const test = harness();
    const handler = test.handlers.get(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL);
    const event = { sender: test.contents, senderFrame: test.frame } as unknown as IpcMainInvokeEvent;
    const first = handler?.(event);
    const second = handler?.(event);
    expect(first).toEqual(CONFIG);
    expect(second).toEqual(CONFIG);
    expect(first).not.toBe(second);
    expect(() => handler?.(event, undefined)).toThrow('argument count');
  });

  it.each(['different-contents', 'subframe', 'destroyed-frame', 'wrong-origin'])(
    'rejects unauthorized sender condition: %s',
    (condition) => {
      const test = harness();
      const frame = condition === 'subframe'
        ? { ...test.frame, parent: test.frame }
        : condition === 'destroyed-frame'
          ? { ...test.frame, isDestroyed: () => true }
          : condition === 'wrong-origin'
            ? { ...test.frame, url: 'https://evil.example/' }
            : test.frame;
      if (condition !== 'different-contents') (test.contents as { mainFrame: unknown }).mainFrame = frame;
      const event = {
        sender: condition === 'different-contents' ? {} : test.contents,
        senderFrame: frame,
      } as unknown as IpcMainInvokeEvent;
      expect(() => test.handlers.get(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL)?.(event)).toThrow('Unauthorized');
    },
  );

  it('returns no config when launched without the trusted capability and removes its handler', () => {
    const test = harness('app://alsniper/index.html', null);
    const event = { sender: test.contents, senderFrame: test.frame } as unknown as IpcMainInvokeEvent;
    expect(test.handlers.get(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL)?.(event)).toBeUndefined();
    test.dispose();
    expect(test.handlers.size).toBe(0);
  });
});
