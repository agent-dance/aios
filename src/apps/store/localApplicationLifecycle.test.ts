import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultDesktopIcons } from '../../shell/desktopProjection';
import { useSystemStore } from '../../system/useSystemStore';
import type { AppId, AppInstallationResult } from '../../system/types';
import { runLocalApplicationPrimaryAction, type LocalApplicationCommands } from './localApplicationLifecycle';

const installedResult: AppInstallationResult = {
  operation: 'install',
  appId: 'wechat',
  ok: true,
  changed: true,
  code: 'installed',
  revision: 1,
  installation: { appId: 'wechat', version: '1.0.0', enabled: true },
};

function createCommands() {
  const install = vi.fn<(appId: AppId) => AppInstallationResult>(() => installedResult);
  const enable = vi.fn<(appId: AppId) => AppInstallationResult>(() => ({
    ...installedResult,
    operation: 'enable',
    code: 'enabled',
  }));
  const open = vi.fn<(appId: AppId) => void>();
  return { commands: { install, enable, open }, install, enable, open };
}

describe('local App Store application lifecycle', () => {
  beforeEach(() => {
    const appInstallations = { ...useSystemStore.getState().appInstallations };
    delete appInstallations.wechat;
    useSystemStore.setState({ appInstallations, appInstallationRevision: 0 });
  });

  it('installs a missing application through the local store and creates its desktop projection', () => {
    const commands: LocalApplicationCommands = {
      install: useSystemStore.getState().installApp,
      enable: useSystemStore.getState().enableApp,
      open: useSystemStore.getState().openApp,
    };

    expect(runLocalApplicationPrimaryAction('wechat', undefined, commands)).toMatchObject({
      kind: 'installed',
      result: { ok: true, code: 'installed', installation: { appId: 'wechat', enabled: true } },
    });
    expect(getDefaultDesktopIcons(useSystemStore.getState().appInstallations)
      .filter((icon) => icon.appId === 'wechat')).toHaveLength(1);
  });

  it('enables a disabled application without reinstalling or opening it', () => {
    const { commands, install, enable, open } = createCommands();
    const installation = { appId: 'wechat', version: '1.0.0', enabled: false } as const;

    expect(runLocalApplicationPrimaryAction('wechat', installation, commands)).toMatchObject({ kind: 'enabled' });
    expect(enable).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens an installed and enabled application exactly once without another mutation', () => {
    const { commands, install, enable, open } = createCommands();
    const installation = { appId: 'wechat', version: '1.0.0', enabled: true } as const;

    expect(runLocalApplicationPrimaryAction('wechat', installation, commands)).toEqual({ kind: 'opened' });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('wechat');
    expect(install).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });
});
