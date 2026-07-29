import { describe, expect, it, vi } from 'vitest';
import type { NativeApplicationInstallResult, NativeApplicationLaunchResult, NativeApplicationStatus } from '../agent-platform';
import type { NativeApplicationSidecarClient } from '../agent-platform/sidecarClient';
import { createNativeApplicationPort } from './NativeApplicationPort';

const status: NativeApplicationStatus = {
  protocolVersion: '1.0.0',
  appId: 'wechat',
  platform: 'windows',
  state: 'installed',
  installed: true,
  launchable: true,
  publisherVerified: true,
  version: '3.9.12.51',
};

const installed: NativeApplicationInstallResult = {
  protocolVersion: '1.0.0',
  requestId: 'native-install-1',
  appId: 'wechat',
  operation: 'install',
  code: 'installed',
  changed: true,
  installed: true,
  launchable: true,
  publisherVerified: true,
  version: '3.9.12.51',
  receiptId: 'receipt-install-1',
};

const launched: NativeApplicationLaunchResult = {
  protocolVersion: '1.0.0',
  requestId: 'native-launch-1',
  appId: 'wechat',
  operation: 'launch',
  code: 'launched',
  changed: false,
  installed: true,
  launchable: true,
  publisherVerified: true,
  version: '3.9.12.51',
  receiptId: 'receipt-launch-1',
};

describe('NativeApplicationPort', () => {
  it('generates transport request IDs while preserving explicit terms acceptance and cancellation', async () => {
    const nativeApplicationStatus = vi.fn<NativeApplicationSidecarClient['nativeApplicationStatus']>(async () => status);
    const installNativeApplication = vi.fn<NativeApplicationSidecarClient['installNativeApplication']>(async (_appId, request) => ({
      ...installed,
      requestId: request.requestId,
    }));
    const launchNativeApplication = vi.fn<NativeApplicationSidecarClient['launchNativeApplication']>(async (_appId, request) => ({
      ...launched,
      requestId: request.requestId,
    }));
    const ids = ['native-install-1', 'native-launch-1'];
    const port = createNativeApplicationPort(
      { nativeApplicationStatus, installNativeApplication, launchNativeApplication },
      { requestId: () => ids.shift() ?? 'unexpected' },
    );
    const controller = new AbortController();

    await expect(port.getStatus('wechat', { signal: controller.signal })).resolves.toBe(status);
    await expect(port.install('wechat', { acceptedTerms: true }, { signal: controller.signal })).resolves.toEqual(installed);
    await expect(port.launch('wechat', { signal: controller.signal })).resolves.toEqual(launched);

    expect(nativeApplicationStatus).toHaveBeenCalledWith('wechat', { signal: controller.signal });
    expect(installNativeApplication).toHaveBeenCalledWith(
      'wechat',
      { requestId: 'native-install-1', acceptedTerms: true },
      { signal: controller.signal },
    );
    expect(launchNativeApplication).toHaveBeenCalledWith(
      'wechat',
      { requestId: 'native-launch-1' },
      { signal: controller.signal },
    );
    expect(Object.isFrozen(port)).toBe(true);
  });

  it('does not invent transport options when no abort signal is supplied', async () => {
    const nativeApplicationStatus = vi.fn<NativeApplicationSidecarClient['nativeApplicationStatus']>(async () => status);
    const port = createNativeApplicationPort({
      nativeApplicationStatus,
      installNativeApplication: async () => installed,
      launchNativeApplication: async () => launched,
    });

    await port.getStatus('wechat');

    expect(nativeApplicationStatus).toHaveBeenCalledWith('wechat', undefined);
  });
});
