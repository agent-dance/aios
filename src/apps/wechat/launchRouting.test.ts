import { describe, expect, it, vi } from 'vitest';
import type { NativeApplicationPort } from '../../native-apps';
import { createApplicationLaunchRouter, routeApplicationLaunch } from './launchRouting';

function nativePort(launch: NativeApplicationPort['launch']): NativeApplicationPort {
  return {
    getStatus: vi.fn(),
    install: vi.fn(),
    launch,
  };
}

const launched = {
  protocolVersion: '1.0.0',
  requestId: 'launch-1',
  appId: 'wechat',
  operation: 'launch',
  code: 'launched',
  changed: false,
  installed: true,
  launchable: true,
  publisherVerified: true,
  version: '3.9.12.51',
  receiptId: 'receipt-launch-1',
} as const;

describe('routeApplicationLaunch', () => {
  it('launches WeChat through the native host without opening the fallback on success', async () => {
    const launch = vi.fn<NativeApplicationPort['launch']>(async () => launched);
    const openFallback = vi.fn();
    const onWeChatLaunchFeedback = vi.fn();

    await routeApplicationLaunch('wechat', {
      nativeApplications: nativePort(launch),
      isLocallyLaunchable: () => true,
      openFallback,
      onWeChatLaunchFeedback,
    });

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith('wechat');
    expect(openFallback).not.toHaveBeenCalled();
    expect(onWeChatLaunchFeedback).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('opens the actionable fallback only when native launch fails or the host is absent', async () => {
    const failedLaunch = vi.fn<NativeApplicationPort['launch']>(async () => {
      throw new Error('WeChat executable unavailable');
    });
    const openAfterFailure = vi.fn();
    await routeApplicationLaunch('wechat', {
      nativeApplications: nativePort(failedLaunch),
      isLocallyLaunchable: () => true,
      openFallback: openAfterFailure,
      onWeChatLaunchFeedback: vi.fn(),
    });
    expect(openAfterFailure).toHaveBeenCalledOnce();
    expect(openAfterFailure).toHaveBeenCalledWith('wechat');

    const openWithoutHost = vi.fn();
    await routeApplicationLaunch('wechat', {
      isLocallyLaunchable: () => true,
      openFallback: openWithoutHost,
      onWeChatLaunchFeedback: vi.fn(),
    });
    expect(openWithoutHost).toHaveBeenCalledWith('wechat');
  });

  it('keeps ordinary application routing unchanged and ignores disabled applications', async () => {
    const launch = vi.fn<NativeApplicationPort['launch']>(async () => launched);
    const openFallback = vi.fn();
    const dependencies = {
      nativeApplications: nativePort(launch),
      isLocallyLaunchable: (appId: string) => appId !== 'wechat',
      openFallback,
      onWeChatLaunchFeedback: vi.fn(),
    };

    await routeApplicationLaunch('finder', dependencies);
    expect(openFallback).toHaveBeenCalledWith('finder');
    expect(launch).not.toHaveBeenCalled();

    openFallback.mockClear();
    await routeApplicationLaunch('wechat', dependencies);
    expect(openFallback).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('coalesces rapid WeChat launch requests into one native operation', async () => {
    let resolveLaunch: ((result: typeof launched) => void) | undefined;
    const launch = vi.fn<NativeApplicationPort['launch']>(() => new Promise((resolve) => {
      resolveLaunch = resolve;
    }));
    const router = createApplicationLaunchRouter({
      nativeApplications: nativePort(launch),
      isLocallyLaunchable: () => true,
      openFallback: vi.fn(),
      onWeChatLaunchFeedback: vi.fn(),
    });

    const first = router('wechat');
    const second = router('wechat');
    expect(first).toBe(second);
    expect(launch).toHaveBeenCalledOnce();

    resolveLaunch?.(launched);
    await Promise.all([first, second]);
  });
});
