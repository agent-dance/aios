import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { hardenWeChatSession } from './sessionPolicy.js';

function createFakeSession() {
  const handlers: Record<string, (...args: never[]) => unknown> = {};
  const fakeSession = {
    setPermissionCheckHandler: vi.fn((handler) => { handlers.permissionCheck = handler; }),
    setPermissionRequestHandler: vi.fn((handler) => { handlers.permissionRequest = handler; }),
    setDevicePermissionHandler: vi.fn((handler) => { handlers.devicePermission = handler; }),
    on: vi.fn((event, handler) => { handlers[event] = handler; }),
    webRequest: {
      onBeforeRequest: vi.fn((handler) => { handlers.beforeRequest = handler; }),
    },
    getUserAgent: vi.fn(() => 'Mozilla/5.0 Chrome/142.0 Electron/43.2.0 Safari/537.36'),
    setUserAgent: vi.fn(),
  };

  return { fakeSession, handlers };
}

describe('hardenWeChatSession', () => {
  it('denies permissions, device access, and downloads by default', () => {
    const { fakeSession, handlers } = createFakeSession();
    hardenWeChatSession(fakeSession as unknown as Session);

    expect(handlers.permissionCheck?.()).toBe(false);
    expect(handlers.devicePermission?.()).toBe(false);

    const permissionCallback = vi.fn();
    handlers.permissionRequest?.(undefined as never, undefined as never, permissionCallback as never);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const downloadEvent = { preventDefault: vi.fn() };
    handlers['will-download']?.(downloadEvent as never);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('allows only exact runtime resource URLs and blocks exfiltration hosts', () => {
    const { fakeSession, handlers } = createFakeSession();
    hardenWeChatSession(fakeSession as unknown as Session);

    const allowedCallback = vi.fn();
    handlers.beforeRequest?.(
      { resourceType: 'script', url: 'https://res.wx.qq.com/app.js' } as never,
      allowedCallback as never,
    );
    expect(allowedCallback).toHaveBeenCalledWith({ cancel: false });

    const blockedCallback = vi.fn();
    handlers.beforeRequest?.(
      { resourceType: 'xhr', url: 'https://analytics.example.com/collect' } as never,
      blockedCallback as never,
    );
    expect(blockedCallback).toHaveBeenCalledWith({ cancel: true });
  });

  it('removes Electron from the user agent and configures each session once', () => {
    const { fakeSession } = createFakeSession();
    hardenWeChatSession(fakeSession as unknown as Session);
    hardenWeChatSession(fakeSession as unknown as Session);

    expect(fakeSession.setUserAgent).toHaveBeenCalledWith(
      'Mozilla/5.0 Chrome/142.0 Safari/537.36',
    );
    expect(fakeSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(fakeSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
  });
});
