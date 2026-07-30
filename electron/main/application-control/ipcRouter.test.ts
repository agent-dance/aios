import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { APPLICATION_CONTROL_IPC_CHANNELS } from '../../shared/applicationControlProtocol.js';
import type { ApplicationControlService } from './applicationControlService.js';
import { registerApplicationControlIpc } from './ipcRouter.js';

function harness(frameUrl = 'app://alsniper/index.html') {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const frameIpc = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel)),
  };
  const frame = {
    ipc: frameIpc,
    url: frameUrl,
    parent: null,
    isDestroyed: vi.fn(() => false),
  };
  const contents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
  };
  const window = {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow;
  const service = {
    listCapabilities: vi.fn(() => []),
    execute: vi.fn(async () => ({ status: 'committed' })),
    getReceipt: vi.fn(() => null),
    close: vi.fn(async () => undefined),
  } as unknown as ApplicationControlService;
  const dispose = registerApplicationControlIpc(window, new URL('app://alsniper/index.html'), service);
  return { handlers, frame, contents, window, service, dispose };
}

describe('application-control IPC router', () => {
  it('accepts only the exact current shell main frame and exact argument counts', async () => {
    const test = harness();
    const event = { sender: test.contents, senderFrame: test.frame } as unknown as IpcMainInvokeEvent;
    await expect(test.handlers.get(APPLICATION_CONTROL_IPC_CHANNELS.execute)?.(event, { request: true })).resolves.toEqual({ status: 'committed' });
    expect(test.service.execute).toHaveBeenCalledWith({ request: true });
    expect(() => test.handlers.get(APPLICATION_CONTROL_IPC_CHANNELS.execute)?.(event)).toThrow('argument count');
    expect(() => test.handlers.get(APPLICATION_CONTROL_IPC_CHANNELS.listCapabilities)?.(event, undefined)).toThrow('argument count');
  });

  it.each(['different-contents', 'subframe', 'destroyed-frame', 'stale-url'])(
    'rejects unauthorized sender condition: %s',
    async (condition) => {
      const test = harness();
      const frame = condition === 'subframe'
        ? { ...test.frame, parent: test.frame }
        : condition === 'destroyed-frame'
          ? { ...test.frame, isDestroyed: () => true }
          : condition === 'stale-url'
            ? { ...test.frame, url: 'https://evil.example/' }
            : test.frame;
      if (condition !== 'different-contents') (test.contents as { mainFrame: unknown }).mainFrame = frame;
      const sender = condition === 'different-contents' ? {} : test.contents;
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      expect(() => test.handlers.get(APPLICATION_CONTROL_IPC_CHANNELS.listCapabilities)?.(event)).toThrow('Unauthorized');
      expect(test.service.listCapabilities).not.toHaveBeenCalled();
    },
  );

  it('removes every frame-scoped handler on dispose', () => {
    const test = harness();
    test.dispose();
    expect(test.handlers.size).toBe(0);
  });
});
