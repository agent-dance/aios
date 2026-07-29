import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { APP_IDS, APP_REGISTRY, PREINSTALLED_APP_IDS } from './appRegistry';
import type { AppId, AppInstallation } from './types';
import { getDefaultDesktopIcons } from '../shell/desktopProjection';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SYSTEM_STATUS,
  MAX_WINDOW_Z,
  type PersistedSystemState,
  restorePersistedSystemState,
  useSystemStore,
} from './useSystemStore';

vi.hoisted(() => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });
});

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
      knownAppIds: [...APP_IDS],
      nativeInstallationProvenanceVersion: 1,
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

  it('projects install, disable, enable, launch, and uninstall changes onto the desktop', () => {
    const installations = { ...useSystemStore.getState().appInstallations };
    delete installations.wechat;
    useSystemStore.setState({ appInstallations: installations, appInstallationRevision: 0 });

    const projectedAppIds = () => getDefaultDesktopIcons(useSystemStore.getState().appInstallations)
      .map((icon) => icon.appId);

    expect(APP_REGISTRY.wechat.defaultInstallation).toBe('on-demand');
    expect(projectedAppIds()).not.toContain('wechat');

    expect(useSystemStore.getState().installApp('wechat')).toMatchObject({
      ok: true,
      changed: true,
      code: 'installed',
      revision: 1,
    });
    expect(projectedAppIds().filter((appId) => appId === 'wechat')).toHaveLength(1);

    useSystemStore.getState().openApp('wechat');
    expect(useSystemStore.getState()).toMatchObject({
      activeAppId: 'wechat',
      windows: { wechat: { appId: 'wechat', isOpen: true, isMinimized: false } },
    });

    expect(useSystemStore.getState().disableApp('wechat')).toMatchObject({ code: 'disabled', revision: 2 });
    expect(useSystemStore.getState().appInstallations.wechat).toMatchObject({ enabled: false });
    expect(useSystemStore.getState().windows.wechat).toMatchObject({ isOpen: false });
    expect(projectedAppIds()).not.toContain('wechat');

    expect(useSystemStore.getState().enableApp('wechat')).toMatchObject({ code: 'enabled', revision: 3 });
    expect(projectedAppIds()).toContain('wechat');

    expect(useSystemStore.getState().uninstallApp('wechat')).toMatchObject({ code: 'uninstalled', revision: 4 });
    expect(useSystemStore.getState().appInstallations.wechat).toBeUndefined();
    expect(useSystemStore.getState().windows.wechat).toBeUndefined();
    expect(projectedAppIds()).not.toContain('wechat');
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
    }, 0);
    expect(migrated.preferences).toMatchObject({ theme: 'midnight', accent: 'cyan' });
    expect(Object.keys(migrated.appInstallations).sort()).toEqual([...PREINSTALLED_APP_IDS].sort());
    expect(migrated.appInstallations.wechat).toBeUndefined();
    expect(migrated.systemStatus).toEqual(DEFAULT_SYSTEM_STATUS);
  });

  it('hydrates and rewrites a v0 preference-only envelope as v5', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const legacyState = {
      preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight' as const },
      appInstallations: {
        wechat: { appId: 'wechat', version: 'forged', enabled: true },
      },
      nativeInstallationProvenanceVersion: 1,
    } as unknown as PersistedSystemState;
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({ state: legacyState, version: 0 }),
      setItem: (_name, value) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }

    expect(useSystemStore.getState().preferences.theme).toBe('midnight');
    expect(Object.keys(useSystemStore.getState().appInstallations).sort()).toEqual([...PREINSTALLED_APP_IDS].sort());
    expect(useSystemStore.getState().appInstallations.wechat).toBeUndefined();
    expect(useSystemStore.getState().knownAppIds).toEqual(APP_IDS);
    expect(writes.at(-1)).toMatchObject({
      version: 5,
      state: {
        knownAppIds: APP_IDS,
        nativeInstallationProvenanceVersion: 1,
      },
    });
  });

  it('hydrates an unversioned preference-only envelope and upgrades it on the next persisted update', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        state: {
          preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight' },
          knownAppIds: APP_IDS,
          appInstallations: installedApps(),
        } as unknown as PersistedSystemState,
      }),
      setItem: (_name, value) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();

      const hydrated = useSystemStore.getState();
      expect(hydrated.preferences.theme).toBe('midnight');
      expect(Object.keys(hydrated.appInstallations).sort()).toEqual([...PREINSTALLED_APP_IDS].sort());
      expect(hydrated.appInstallations.wechat).toBeUndefined();
      expect(hydrated.knownAppIds).toEqual(APP_IDS);
      expect(writes).toHaveLength(0);

      hydrated.updatePreferences({ accent: 'cyan' });
      expect(writes.at(-1)).toMatchObject({
        version: 5,
        state: {
          knownAppIds: APP_IDS,
          nativeInstallationProvenanceVersion: 1,
        },
      });
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }
  });

  it.each([
    {
      sourceVersion: 2,
      legacyState: {
        nativeInstallationProvenanceVersion: 1,
        appInstallations: {
          finder: { appId: 'finder', version: 'legacy', enabled: true },
          settings: { appId: 'settings', version: 'legacy', enabled: true },
          store: { appId: 'store', version: 'legacy', enabled: true },
          wechat: { appId: 'wechat', version: 'injected', enabled: true },
        },
      },
      expectedWechatEnabled: undefined,
    },
    {
      sourceVersion: 3,
      legacyState: {
        knownAppIds: [],
        nativeInstallationProvenanceVersion: 1,
        appInstallations: {
          finder: { appId: 'finder', version: 'legacy', enabled: true },
          settings: { appId: 'settings', version: 'legacy', enabled: true },
          store: { appId: 'store', version: 'legacy', enabled: true },
          wechat: { appId: 'wechat', version: 'legacy', enabled: false },
        },
      },
      expectedWechatEnabled: undefined,
    },
  ])('hydrates and rewrites a v$sourceVersion envelope through the configured migration', async ({
    sourceVersion,
    legacyState,
    expectedWechatEnabled,
  }) => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        state: legacyState as unknown as PersistedSystemState,
        version: sourceVersion,
      }),
      setItem: (_name, value) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }

    const state = useSystemStore.getState();
    expect(state.appInstallations.calculator).toBeUndefined();
    expect(state.appInstallations.wechat?.enabled).toBe(expectedWechatEnabled);
    expect(state.knownAppIds).toEqual(APP_IDS);
    expect(writes.at(-1)).toMatchObject({
      version: 5,
      state: {
        knownAppIds: APP_IDS,
        nativeInstallationProvenanceVersion: 1,
      },
    });
  });

  it('hydrates a v4 explicitly installed WeChat and upgrades its native provenance', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        version: 4,
        state: {
          appInstallations: {
            finder: { appId: 'finder', version: 'current', enabled: true },
            settings: { appId: 'settings', version: 'current', enabled: true },
            store: { appId: 'store', version: 'current', enabled: true },
            wechat: { appId: 'wechat', version: 'current', enabled: true },
          },
          knownAppIds: APP_IDS,
        } as unknown as PersistedSystemState,
      }),
      setItem: (_name, value) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }

    expect(useSystemStore.getState().appInstallations.wechat).toEqual({
      appId: 'wechat',
      version: APP_REGISTRY.wechat.version,
      enabled: true,
    });
    expect(useSystemStore.getState().nativeInstallationProvenanceVersion).toBe(1);
    expect(writes.at(-1)).toMatchObject({
      version: 5,
      state: { nativeInstallationProvenanceVersion: 1 },
    });
  });

  it.each([
    { provenanceVersion: 1, expectedInstalled: true },
    { provenanceVersion: undefined, expectedInstalled: false },
    { provenanceVersion: 2, expectedInstalled: false },
  ])('accepts a v5 WeChat installation only with current native provenance $provenanceVersion', async ({
    provenanceVersion,
    expectedInstalled,
  }) => {
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        version: 5,
        state: {
          appInstallations: {
            wechat: { appId: 'wechat', version: 'current', enabled: true },
          },
          knownAppIds: APP_IDS,
          nativeInstallationProvenanceVersion: provenanceVersion,
        } as unknown as PersistedSystemState,
      }),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }

    expect(Boolean(useSystemStore.getState().appInstallations.wechat)).toBe(expectedInstalled);
  });

  it('discards launcher-only on-demand apps while migrating unversioned state', () => {
    const migrated = restorePersistedSystemState({
      appInstallations: {
        finder: { appId: 'finder', version: 'legacy', enabled: true },
        wechat: { appId: 'wechat', version: 'legacy', enabled: false },
      },
    });

    expect(migrated.appInstallations.wechat).toBeUndefined();
    expect(migrated.appInstallations.calculator).toBeUndefined();
  });

  it('migrates v2 and v3 installation projections from frozen historical app sets', () => {
    const v2 = restorePersistedSystemState({
      knownAppIds: [],
      appInstallations: {
        finder: { appId: 'finder', version: 'legacy', enabled: true },
        calculator: { appId: 'calculator', version: 'legacy', enabled: true },
        settings: { appId: 'settings', version: 'legacy', enabled: true },
        store: { appId: 'store', version: 'legacy', enabled: true },
        'space-game': { appId: 'space-game', version: 'legacy', enabled: true },
        doudizhu: { appId: 'doudizhu', version: 'legacy', enabled: true },
        wechat: { appId: 'wechat', version: 'injected', enabled: true },
      },
    }, 2);
    expect(v2.appInstallations.terminal).toBeUndefined();
    expect(v2.appInstallations.wechat).toBeUndefined();
    expect(v2.knownAppIds).toEqual(APP_IDS);

    const v3 = restorePersistedSystemState({
      knownAppIds: [],
      appInstallations: {
        finder: { appId: 'finder', version: 'legacy', enabled: true },
        settings: { appId: 'settings', version: 'legacy', enabled: true },
        store: { appId: 'store', version: 'legacy', enabled: true },
        wechat: { appId: 'wechat', version: 'legacy', enabled: false },
      },
    }, 3);
    expect(v3.appInstallations.calculator).toBeUndefined();
    expect(v3.appInstallations.doudizhu).toBeUndefined();
    expect(v3.appInstallations.wechat).toBeUndefined();
  });

  it('installs a newly preinstalled app once and preserves subsequent uninstall and reinstall choices', () => {
    const beforeDoudizhu = APP_IDS.filter((appId) => appId !== 'doudizhu');
    const installations: Partial<Record<AppId, AppInstallation>> = installedApps();
    delete installations.doudizhu;
    delete installations.wechat;

    const migrated = restorePersistedSystemState({
      appInstallations: installations,
      knownAppIds: beforeDoudizhu,
    }, 4);
    expect(migrated.appInstallations.doudizhu).toEqual({
      appId: 'doudizhu',
      version: APP_REGISTRY.doudizhu.version,
      enabled: true,
    });
    expect(migrated.appInstallations.wechat).toBeUndefined();
    expect(migrated.knownAppIds).toEqual(APP_IDS);

    const afterExplicitUninstall = { ...migrated.appInstallations };
    delete afterExplicitUninstall.doudizhu;
    const restoredAfterUninstall = restorePersistedSystemState({
      ...migrated,
      appInstallations: afterExplicitUninstall,
    }, 4);
    expect(restoredAfterUninstall.appInstallations.doudizhu).toBeUndefined();

    useSystemStore.setState({
      appInstallations: restoredAfterUninstall.appInstallations,
      knownAppIds: restoredAfterUninstall.knownAppIds,
      appInstallationRevision: 0,
    });
    expect(useSystemStore.getState().installApp('doudizhu')).toMatchObject({
      ok: true,
      changed: true,
      code: 'installed',
      revision: 1,
    });
    expect(useSystemStore.getState().knownAppIds).toEqual(APP_IDS);
  });

  it('cleans tampered provenance and installations without auto-installing on-demand apps', () => {
    const inheritedInstallations = Object.create({
      wechat: { appId: 'wechat', version: 'inherited', enabled: true },
    }) as Record<string, unknown>;
    inheritedInstallations.finder = { appId: 'finder', version: 'tampered', enabled: false };
    inheritedInstallations.malware = { appId: 'malware', version: 'tampered', enabled: true };

    const restored = restorePersistedSystemState({
      knownAppIds: ['finder', 'finder', 'wechat', 'malware', 42],
      appInstallations: inheritedInstallations,
    }, 4);

    expect(restored.knownAppIds).toEqual(APP_IDS);
    expect(restored.appInstallations.finder).toEqual({
      appId: 'finder',
      version: APP_REGISTRY.finder.version,
      enabled: true,
    });
    expect(restored.appInstallations.settings).toEqual({
      appId: 'settings',
      version: APP_REGISTRY.settings.version,
      enabled: true,
    });
    expect(restored.appInstallations.wechat).toBeUndefined();
    expect((restored.appInstallations as Record<string, unknown>).malware).toBeUndefined();

    const inheritedProjection = Object.create({
      knownAppIds: [],
      appInstallations: {
        wechat: { appId: 'wechat', version: 'inherited', enabled: true },
      },
      appInstallationRevision: 99,
    });
    const restoredInheritedProjection = restorePersistedSystemState(inheritedProjection, 4);
    expect(restoredInheritedProjection.appInstallations.wechat).toBeUndefined();
    expect(restoredInheritedProjection.appInstallationRevision).toBe(0);

    const inheritedCandidate = Object.create({ appId: 'wechat', enabled: true });
    const arrayCandidate = Object.assign([], { appId: 'calculator', enabled: true });
    const restoredNestedProjections = restorePersistedSystemState({
      knownAppIds: APP_IDS,
      appInstallations: {
        wechat: inheritedCandidate,
        calculator: arrayCandidate,
      },
    }, 4);
    expect(restoredNestedProjections.appInstallations.wechat).toBeUndefined();
    expect(restoredNestedProjections.appInstallations.calculator).toBeUndefined();
  });
});
