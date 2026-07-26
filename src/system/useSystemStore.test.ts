import { beforeEach, describe, expect, it } from 'vitest';
import { APP_IDS, APP_REGISTRY } from './appRegistry';
import type { AppId, AppInstallation } from './types';
import { DEFAULT_PREFERENCES, DEFAULT_SYSTEM_STATUS, MAX_WINDOW_Z, restorePersistedSystemState, useSystemStore } from './useSystemStore';

function installedApps() {
  return Object.fromEntries(APP_IDS.map((appId) => [
    appId,
    { appId, version: APP_REGISTRY[appId].version, enabled: true } satisfies AppInstallation,
  ])) as Record<AppId, AppInstallation>;
}

describe('system window manager', () => {
  beforeEach(() => {
    useSystemStore.setState({
      windows: {},
      activeAppId: null,
      topZ: 0,
      preferences: { ...DEFAULT_PREFERENCES },
      appInstallations: installedApps(),
      appInstallationRevision: 0,
      systemStatus: { ...DEFAULT_SYSTEM_STATUS },
      systemStatusRevision: 0,
    });
  });

  it('opens, focuses, minimizes and restores an app through one lifecycle', () => {
    const store = useSystemStore.getState();
    store.openApp('terminal');
    expect(useSystemStore.getState().windows.terminal).toMatchObject({
      isOpen: true,
      isMinimized: false,
    });

    useSystemStore.getState().minimizeApp('terminal');
    expect(useSystemStore.getState().windows.terminal?.isMinimized).toBe(true);

    useSystemStore.getState().openApp('terminal');
    expect(useSystemStore.getState().windows.terminal?.isMinimized).toBe(false);
    expect(useSystemStore.getState().activeAppId).toBe('terminal');
  });

  it('restores exact bounds after maximizing a window', () => {
    useSystemStore.getState().openApp('finder');
    useSystemStore.getState().moveWindow('finder', 123, 87);
    useSystemStore.getState().resizeWindow('finder', 720, 510);
    useSystemStore.getState().toggleMaximize('finder');
    expect(useSystemStore.getState().windows.finder?.isMaximized).toBe(true);

    useSystemStore.getState().toggleMaximize('finder');
    expect(useSystemStore.getState().windows.finder).toMatchObject({
      isMaximized: false,
      position: { x: 123, y: 87 },
      size: { width: 720, height: 510 },
    });
  });

  it('uses registry bounds for a newly launched app', () => {
    useSystemStore.getState().openApp('calculator');
    expect(useSystemStore.getState().windows.calculator?.size).toEqual(
      APP_REGISTRY.calculator.defaultSize,
    );
  });

  it('applies idempotent app lifecycle operations with stable revisions', () => {
    const firstUninstall = useSystemStore.getState().uninstallApp('terminal');
    expect(firstUninstall).toMatchObject({ ok: true, changed: true, code: 'uninstalled', revision: 1 });
    expect(useSystemStore.getState().isAppLaunchable('terminal')).toBe(false);

    const repeatedUninstall = useSystemStore.getState().uninstallApp('terminal');
    expect(repeatedUninstall).toMatchObject({ ok: true, changed: false, code: 'not-installed', revision: 1 });

    const installed = useSystemStore.getState().installApp('terminal');
    expect(installed).toMatchObject({ ok: true, changed: true, code: 'installed', revision: 2 });
    const repeatedInstall = useSystemStore.getState().installApp('terminal');
    expect(repeatedInstall).toMatchObject({ ok: true, changed: false, code: 'already-installed', revision: 2 });

    expect(useSystemStore.getState().disableApp('terminal')).toMatchObject({ code: 'disabled', revision: 3 });
    expect(useSystemStore.getState().openApp('terminal')).toBeUndefined();
    expect(useSystemStore.getState().windows.terminal).toBeUndefined();
    expect(useSystemStore.getState().enableApp('terminal')).toMatchObject({ code: 'enabled', revision: 4 });
  });

  it('keeps protected system apps installed and enabled', () => {
    expect(useSystemStore.getState().disableApp('finder')).toMatchObject({
      ok: false,
      changed: false,
      code: 'protected-system-app',
      revision: 0,
    });
    expect(useSystemStore.getState().uninstallApp('settings')).toMatchObject({
      ok: false,
      changed: false,
      code: 'protected-system-app',
      revision: 0,
    });
    expect(useSystemStore.getState().isAppLaunchable('finder')).toBe(true);
  });

  it('validates system status patches atomically', () => {
    expect(useSystemStore.getState().updateSystemStatus({ brightness: 35, energyMode: 'Eco' })).toMatchObject({
      ok: true,
      changed: true,
      code: 'updated',
      revision: 1,
    });
    expect(useSystemStore.getState().systemStatus).toMatchObject({ brightness: 35, energyMode: 'Eco' });

    const invalid = useSystemStore.getState().updateSystemStatus({ storageUsedGb: 2048 });
    expect(invalid).toMatchObject({ ok: false, changed: false, code: 'invalid-patch', revision: 1 });
    expect(useSystemStore.getState().systemStatus.storageUsedGb).toBe(DEFAULT_SYSTEM_STATUS.storageUsedGb);
    expect(useSystemStore.getState().updateSystemStatus({ unexpected: true } as never)).toMatchObject({
      ok: false,
      changed: false,
      code: 'invalid-patch',
      revision: 1,
    });
    expect(useSystemStore.getState().updateSystemStatus({ brightness: 35 })).toMatchObject({
      ok: true,
      changed: false,
      code: 'unchanged',
      revision: 1,
    });
  });

  it('rebases window layers before they can overtake trusted shell surfaces', () => {
    useSystemStore.getState().openApp('finder');
    useSystemStore.getState().openApp('terminal');
    useSystemStore.setState({ topZ: MAX_WINDOW_Z });
    useSystemStore.getState().focusApp('finder');

    const state = useSystemStore.getState();
    expect(state.topZ).toBeLessThan(MAX_WINDOW_Z);
    expect(state.windows.finder?.zIndex).toBe(state.topZ);
    expect(state.windows.finder!.zIndex).toBeGreaterThan(state.windows.terminal!.zIndex);
  });

  it('repairs invalid persisted projections without granting unknown apps', () => {
    const state = restorePersistedSystemState({
      preferences: { theme: 'invalid', soundEffects: 'yes' },
      appInstallations: {
        finder: { appId: 'finder', version: 'tampered', enabled: false },
        terminal: { appId: 'other', version: '1', enabled: true },
        malware: { appId: 'malware', version: '1', enabled: true },
      },
      appInstallationRevision: -5,
      systemStatus: { brightness: 999 },
      systemStatusRevision: 'many',
    });
    expect(state.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(state.appInstallations.finder).toEqual({ appId: 'finder', version: APP_REGISTRY.finder.version, enabled: true });
    expect(state.appInstallations.terminal).toBeUndefined();
    expect((state.appInstallations as Record<string, unknown>).malware).toBeUndefined();
    expect(state.appInstallationRevision).toBe(0);
    expect(state.systemStatus).toEqual(DEFAULT_SYSTEM_STATUS);
    expect(state.systemStatusRevision).toBe(0);
  });

  it('migrates the legacy preference-only projection with bundled apps intact', () => {
    const migrated = restorePersistedSystemState({
      preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight', accent: 'cyan' },
    });
    expect(migrated.preferences).toMatchObject({ theme: 'midnight', accent: 'cyan' });
    expect(Object.keys(migrated.appInstallations).sort()).toEqual([...APP_IDS].sort());
    expect(migrated.systemStatus).toEqual(DEFAULT_SYSTEM_STATUS);
  });
});
