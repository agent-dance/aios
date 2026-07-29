import { describe, expect, it, vi } from 'vitest';
import type {
  NativeApplicationInstallResult,
  NativeApplicationPort,
  NativeApplicationStatus,
} from '../../native-apps';
import type { AppInstallationResult } from '../../system/types';
import { commitWeChatProjection, installWeChatTransaction } from './weChatInstallation';

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

const nativeInstalled: NativeApplicationInstallResult = {
  protocolVersion: '1.0.0',
  requestId: 'install-1',
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

const localInstalled: AppInstallationResult = {
  operation: 'install',
  appId: 'wechat',
  ok: true,
  changed: true,
  code: 'installed',
  revision: 1,
  installation: { appId: 'wechat', version: '1.0.0', enabled: true },
};

function nativePort(install: NativeApplicationPort['install']): NativeApplicationPort {
  return {
    getStatus: vi.fn(async () => status),
    install,
    launch: vi.fn(async () => ({
      ...nativeInstalled,
      requestId: 'launch-1',
      operation: 'launch' as const,
      code: 'launched' as const,
      changed: false as const,
    })),
  };
}

describe('installWeChatTransaction', () => {
  it('commits the desktop installation only after the native result is verified', async () => {
    let resolveInstall: ((result: NativeApplicationInstallResult) => void) | undefined;
    const install = vi.fn<NativeApplicationPort['install']>(() => new Promise((resolve) => {
      resolveInstall = resolve;
    }));
    const commitLocalInstallation = vi.fn(() => localInstalled);

    const transaction = installWeChatTransaction({
      nativeApplications: nativePort(install),
      acceptedTerms: true,
      commitLocalInstallation,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith('wechat', { acceptedTerms: true });
    expect(commitLocalInstallation).not.toHaveBeenCalled();

    resolveInstall?.(nativeInstalled);
    await expect(transaction).resolves.toMatchObject({ ok: true });
    expect(commitLocalInstallation).toHaveBeenCalledOnce();
  });

  it('does not call the host or commit without explicit Tencent terms consent', async () => {
    const install = vi.fn<NativeApplicationPort['install']>(async () => nativeInstalled);
    const commitLocalInstallation = vi.fn(() => localInstalled);

    await expect(installWeChatTransaction({
      nativeApplications: nativePort(install),
      acceptedTerms: false,
      commitLocalInstallation,
    })).resolves.toMatchObject({ ok: false, code: 'terms-not-accepted' });

    expect(install).not.toHaveBeenCalled();
    expect(commitLocalInstallation).not.toHaveBeenCalled();
  });

  it('does not create a local installation when the native host is absent or rejects installation', async () => {
    const commitWithoutHost = vi.fn(() => localInstalled);
    await expect(installWeChatTransaction({
      acceptedTerms: true,
      commitLocalInstallation: commitWithoutHost,
    })).resolves.toMatchObject({ ok: false, code: 'native-host-unavailable' });
    expect(commitWithoutHost).not.toHaveBeenCalled();

    const commitAfterFailure = vi.fn(() => localInstalled);
    const failingPort = nativePort(vi.fn<NativeApplicationPort['install']>(async () => {
      throw new Error('publisher verification failed');
    }));
    await expect(installWeChatTransaction({
      nativeApplications: failingPort,
      acceptedTerms: true,
      commitLocalInstallation: commitAfterFailure,
    })).resolves.toMatchObject({ ok: false, code: 'native-install-rejected' });
    expect(commitAfterFailure).not.toHaveBeenCalled();
  });

  it('rejects an untrusted native response and catches a failed local commit', async () => {
    const invalidResult = {
      ...nativeInstalled,
      launchable: false,
      publisherVerified: false,
    } as unknown as NativeApplicationInstallResult;
    const commitUntrusted = vi.fn(() => localInstalled);
    await expect(installWeChatTransaction({
      nativeApplications: nativePort(vi.fn(async () => invalidResult)),
      acceptedTerms: true,
      commitLocalInstallation: commitUntrusted,
    })).resolves.toMatchObject({ ok: false, code: 'native-install-rejected' });
    expect(commitUntrusted).not.toHaveBeenCalled();

    await expect(installWeChatTransaction({
      nativeApplications: nativePort(vi.fn(async () => nativeInstalled)),
      acceptedTerms: true,
      commitLocalInstallation: () => {
        throw new Error('storage unavailable');
      },
    })).resolves.toMatchObject({ ok: false, code: 'local-commit-rejected' });
  });
});

describe('commitWeChatProjection', () => {
  it('installs a missing projection and repairs enabled or disabled legacy records', () => {
    const installLocalApplication = vi.fn(() => localInstalled);
    const enableLocalApplication = vi.fn(() => ({
      ...localInstalled,
      operation: 'enable' as const,
      code: 'enabled' as const,
    }));

    expect(commitWeChatProjection(undefined, installLocalApplication, enableLocalApplication).ok).toBe(true);
    expect(installLocalApplication).toHaveBeenCalledOnce();
    expect(enableLocalApplication).not.toHaveBeenCalled();

    installLocalApplication.mockClear();
    expect(commitWeChatProjection(
      { appId: 'wechat', version: '1.0.0', enabled: true },
      installLocalApplication,
      enableLocalApplication,
    ).ok).toBe(true);
    expect(installLocalApplication).toHaveBeenCalledOnce();
    expect(enableLocalApplication).not.toHaveBeenCalled();

    installLocalApplication.mockClear();
    expect(commitWeChatProjection(
      { appId: 'wechat', version: '1.0.0', enabled: false },
      installLocalApplication,
      enableLocalApplication,
    ).ok).toBe(true);
    expect(enableLocalApplication).toHaveBeenCalledOnce();
    expect(installLocalApplication).not.toHaveBeenCalled();
  });
});
