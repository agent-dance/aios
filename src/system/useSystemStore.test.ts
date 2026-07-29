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

  it('restores the v7 desktop workspace with bounded geometry and coherent focus', () => {
    const state = restorePersistedSystemState({
      appInstallations: installedApps(),
      knownAppIds: APP_IDS,
      windows: {
        finder: {
          appId: 'finder',
          isOpen: true,
          isMinimized: false,
          isMaximized: false,
          zIndex: 500,
          position: { x: Number.POSITIVE_INFINITY, y: -90_000 },
          size: { width: 50, height: 90_000 },
        },
        wechat: {
          appId: 'wechat',
          isOpen: true,
          isMinimized: false,
          isMaximized: true,
          zIndex: 7,
          position: { x: 140, y: 60 },
          size: { width: 1080, height: 720 },
          restore: { position: { x: 155, y: 75 }, size: { width: 1180, height: 760 } },
        },
      },
      activeAppId: 'malware',
      topZ: 90_000,
    }, 7);

    expect(state.windows.finder).toMatchObject({
      position: { x: APP_REGISTRY.finder.defaultPosition.x, y: -32_768 },
      size: { width: 320, height: 32_768 },
      zIndex: 2,
    });
    expect(state.windows.wechat).toMatchObject({
      isOpen: true,
      isMaximized: true,
      zIndex: 1,
      restore: { position: { x: 155, y: 75 }, size: { width: 1180, height: 760 } },
    });
    expect(state.activeAppId).toBe('finder');
    expect(state.topZ).toBe(2);
    expect((state.windows as Record<string, unknown>).malware).toBeUndefined();
  });

  it('retains disabled app geometry without restoring an unlaunchable window', () => {
    const installations = installedApps();
    installations.terminal = { ...installations.terminal, enabled: false };
    const state = restorePersistedSystemState({
      appInstallations: installations,
      knownAppIds: APP_IDS,
      windows: {
        terminal: {
          appId: 'terminal',
          isOpen: true,
          isMinimized: false,
          isMaximized: true,
          zIndex: 4,
          position: { x: 444, y: 222 },
          size: { width: 888, height: 555 },
          restore: { position: { x: 400, y: 200 }, size: { width: 800, height: 500 } },
        },
      },
      activeAppId: 'terminal',
      topZ: 4,
    }, 7);

    expect(state.windows.terminal).toMatchObject({
      isOpen: false,
      isMaximized: true,
      position: { x: 444, y: 222 },
      size: { width: 888, height: 555 },
      restore: { position: { x: 400, y: 200 }, size: { width: 800, height: 500 } },
    });
    expect(state.activeAppId).toBeNull();
  });

  it('distinguishes an intentionally empty workspace from a malformed one', () => {
    const persisted = {
      appInstallations: installedApps(),
      knownAppIds: APP_IDS,
      activeAppId: null,
      topZ: 0,
    };
    expect(restorePersistedSystemState({ ...persisted, windows: {} }, 7)).toMatchObject({
      windows: {},
      activeAppId: null,
      topZ: 0,
    });
    expect(restorePersistedSystemState({ ...persisted, windows: 'corrupt' }, 7)).toMatchObject({
      windows: { finder: { appId: 'finder', isOpen: true } },
      activeAppId: 'finder',
      topZ: 1,
    });
  });

  it('rehydrates a current v7 workspace through the actual Zustand persistence middleware', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        version: 7,
        state: {
          windows: {
            finder: {
              appId: 'finder',
              isOpen: true,
              isMinimized: false,
              isMaximized: false,
              zIndex: 1,
              position: { x: 88, y: 96 },
              size: { width: 980, height: 610 },
            },
            wechat: {
              appId: 'wechat',
              isOpen: true,
              isMinimized: false,
              isMaximized: true,
              zIndex: 2,
              position: { x: 140, y: 60 },
              size: { width: 1080, height: 720 },
              restore: { position: { x: 166, y: 74 }, size: { width: 1040, height: 690 } },
            },
          },
          activeAppId: 'wechat',
          topZ: 2,
          preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight' },
          appInstallations: installedApps(),
          knownAppIds: [...APP_IDS],
          appInstallationRevision: 8,
          systemStatus: { ...DEFAULT_SYSTEM_STATUS, volume: 63 },
          systemStatusRevision: 4,
        },
      }),
      setItem: (_name, value) => { writes.push(value); },
      removeItem: () => undefined,
    };
    const previousStorage = useSystemStore.persist.getOptions().storage;

    try {
      useSystemStore.persist.setOptions({ storage });
      await useSystemStore.persist.rehydrate();
      expect(useSystemStore.getState()).toMatchObject({
        activeAppId: 'wechat',
        topZ: 2,
        preferences: { theme: 'midnight' },
        systemStatus: { volume: 63 },
        windows: {
          finder: { position: { x: 88, y: 96 }, size: { width: 980, height: 610 }, zIndex: 1 },
          wechat: {
            isOpen: true,
            isMaximized: true,
            zIndex: 2,
            restore: { position: { x: 166, y: 74 }, size: { width: 1040, height: 690 } },
          },
        },
      });
      expect(writes).toHaveLength(0);
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }
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

  it('hydrates and rewrites a v0 preference-only envelope as v7', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const legacyState = {
      preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight' as const },
      appInstallations: {
        wechat: { appId: 'wechat', version: 'forged', enabled: true },
      },
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
      version: 7,
      state: { knownAppIds: APP_IDS },
    });
  });

  it('hydrates an unversioned preference-only envelope and upgrades it on the next persisted update', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        state: {
          preferences: { ...DEFAULT_PREFERENCES, theme: 'midnight' },
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
        version: 7,
        state: { knownAppIds: APP_IDS },
      });
    } finally {
      useSystemStore.persist.setOptions({ storage: previousStorage });
    }
  });

  it('preserves future and unreadable envelopes instead of overwriting them after a mutation', async () => {
    const key = 'alsniper-os-preferences';
    const futureEnvelope = JSON.stringify({
      version: 99,
      state: { futureOnlyField: 'must-survive-downgrade' },
    });
    window.localStorage.setItem(key, futureEnvelope);

    try {
      await useSystemStore.persist.rehydrate();
      useSystemStore.getState().updatePreferences({ accent: 'amber' });
      expect(window.localStorage.getItem(key)).toBe(futureEnvelope);

      const malformedEnvelope = '{"version":7,"state":';
      window.localStorage.setItem(key, malformedEnvelope);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await useSystemStore.persist.rehydrate();
      useSystemStore.getState().updatePreferences({ accent: 'cyan' });
      expect(window.localStorage.getItem(key)).toBe(malformedEnvelope);
      expect(consoleError).toHaveBeenCalledWith(
        'AlSniper OS preserved an unavailable or unreadable system state instead of overwriting it.',
        expect.any(SyntaxError),
      );
      consoleError.mockRestore();
    } finally {
      window.localStorage.removeItem(key);
      await useSystemStore.persist.rehydrate();
    }
  });

  it('locks persistence when browser storage cannot be read and never overwrites the unavailable value', async () => {
    const originalWindow = window;
    const readFailure = new DOMException('storage unavailable', 'SecurityError');
    let readsFail = true;
    const storage = {
      getItem: vi.fn(() => {
        if (readsFail) throw readFailure;
        return JSON.stringify({ version: 99, state: { futureOnlyField: 'preserve' } });
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 1,
    } satisfies Storage;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });

    try {
      await useSystemStore.persist.rehydrate();
      useSystemStore.getState().updatePreferences({ accent: 'amber' });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        'AlSniper OS preserved an unavailable or unreadable system state instead of overwriting it.',
        readFailure,
      );
    } finally {
      readsFail = false;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      consoleError.mockRestore();
      await useSystemStore.persist.rehydrate();
    }
  });

  it('contains a browser storage write failure and switches the session to read-only persistence', async () => {
    const originalWindow = window;
    const writeFailure = new DOMException('quota exceeded', 'QuotaExceededError');
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw writeFailure; }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    } satisfies Storage;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });

    try {
      await useSystemStore.persist.rehydrate();
      expect(() => useSystemStore.getState().updatePreferences({ accent: 'amber' })).not.toThrow();
      useSystemStore.getState().updatePreferences({ accent: 'cyan' });
      expect(storage.setItem).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        'AlSniper OS switched system state persistence to read-only after a write failure.',
        writeFailure,
      );
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      consoleError.mockRestore();
      await useSystemStore.persist.rehydrate();
    }
  });

  it.each([
    {
      sourceVersion: 2,
      legacyState: {
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
      version: 7,
      state: { knownAppIds: APP_IDS },
    });
  });

  it('clears a v4 native WeChat installation while upgrading to the web model', async () => {
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

    expect(useSystemStore.getState().appInstallations.wechat).toBeUndefined();
    expect(writes.at(-1)).toMatchObject({
      version: 7,
      state: { knownAppIds: APP_IDS },
    });
    expect(writes.at(-1)?.state).not.toHaveProperty('nativeInstallationProvenanceVersion');
  });

  it('clears a v5 WeChat installation and removes its native provenance field', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        version: 5,
        state: {
          appInstallations: {
            wechat: { appId: 'wechat', version: 'current', enabled: true },
          },
          knownAppIds: APP_IDS,
          nativeInstallationProvenanceVersion: 1,
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

    expect(useSystemStore.getState().appInstallations.wechat).toBeUndefined();
    expect(writes.at(-1)).toMatchObject({ version: 7, state: { knownAppIds: APP_IDS } });
    expect(writes.at(-1)?.state).not.toHaveProperty('nativeInstallationProvenanceVersion');
  });

  it('preserves an explicitly installed web WeChat application while migrating v6', async () => {
    const writes: StorageValue<PersistedSystemState>[] = [];
    const storage: PersistStorage<PersistedSystemState> = {
      getItem: () => ({
        version: 6,
        state: {
          appInstallations: {
            wechat: { appId: 'wechat', version: 'web', enabled: true },
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
    expect(writes.at(-1)).toMatchObject({
      version: 7,
      state: {
        appInstallations: {
          wechat: { appId: 'wechat', enabled: true },
        },
        windows: {
          finder: { appId: 'finder', isOpen: true },
        },
        activeAppId: 'finder',
      },
    });
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
