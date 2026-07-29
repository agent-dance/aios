import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { APP_IDS, APP_REGISTRY, PREINSTALLED_APP_IDS, isAppId, isProtectedSystemApp } from './appRegistry';
import type {
  AppId,
  AppInstallation,
  AppInstallationOperation,
  AppInstallationResult,
  SystemPreferences,
  SystemStatusModel,
  SystemStatusUpdateResult,
  WindowState,
} from './types';

const PERSISTENCE_VERSION = 6;
const FIRST_PERSISTENCE_VERSION_WITH_KNOWN_APP_IDS = 4;
const LATEST_PERSISTENCE_VERSION_WITHOUT_KNOWN_APP_IDS = 3;
const KNOWN_APP_IDS_BY_PERSISTENCE_VERSION: Readonly<Record<number, readonly string[]>> = Object.freeze({
  2: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu']),
  3: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu', 'wechat']),
  4: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu', 'wechat']),
  5: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu', 'wechat']),
  6: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu', 'wechat']),
});
const RETAINABLE_INSTALLATION_IDS_BY_PERSISTENCE_VERSION: Readonly<Record<number, readonly string[]>> = Object.freeze({
  2: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu']),
  3: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu']),
  4: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu']),
  5: Object.freeze(['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'doudizhu']),
});
const LEGACY_RETAINABLE_INSTALLATION_IDS = RETAINABLE_INSTALLATION_IDS_BY_PERSISTENCE_VERSION[5];
export const MAX_WINDOW_Z = 89;
const SYSTEM_STATUS_KEYS = new Set<keyof SystemStatusModel>([
  'wifiEnabled',
  'wifiLabel',
  'bluetoothEnabled',
  'bluetoothLabel',
  'healthScore',
  'storageUsedGb',
  'storageTotalGb',
  'energyMode',
  'brightness',
  'volume',
]);

export const DEFAULT_PREFERENCES: SystemPreferences = Object.freeze({
  theme: 'aurora',
  reduceMotion: false,
  soundEffects: true,
  dockMagnification: true,
  accent: 'lime',
});

export const DEFAULT_SYSTEM_STATUS: SystemStatusModel = Object.freeze({
  wifiEnabled: true,
  wifiLabel: 'AlSniper Mesh',
  bluetoothEnabled: true,
  bluetoothLabel: 'Orbital Link',
  healthScore: 98,
  storageUsedGb: 612,
  storageTotalGb: 1024,
  energyMode: 'Balanced',
  brightness: 72,
  volume: 38,
});

export interface SystemStore {
  windows: Partial<Record<AppId, WindowState>>;
  activeAppId: AppId | null;
  topZ: number;
  controlCenterOpen: boolean;
  clockOpen: boolean;
  preferences: SystemPreferences;
  appInstallations: Partial<Record<AppId, AppInstallation>>;
  knownAppIds: AppId[];
  appInstallationRevision: number;
  systemStatus: SystemStatusModel;
  systemStatusRevision: number;
  openApp: (id: AppId) => void;
  closeApp: (id: AppId) => void;
  minimizeApp: (id: AppId) => void;
  focusApp: (id: AppId) => void;
  toggleMaximize: (id: AppId) => void;
  moveWindow: (id: AppId, x: number, y: number) => void;
  resizeWindow: (id: AppId, width: number, height: number) => void;
  setControlCenterOpen: (open: boolean) => void;
  setClockOpen: (open: boolean) => void;
  updatePreferences: (patch: Partial<SystemPreferences>) => void;
  isAppLaunchable: (id: AppId) => boolean;
  installApp: (id: AppId) => AppInstallationResult;
  enableApp: (id: AppId) => AppInstallationResult;
  disableApp: (id: AppId) => AppInstallationResult;
  uninstallApp: (id: AppId) => AppInstallationResult;
  updateSystemStatus: (patch: Partial<SystemStatusModel>) => SystemStatusUpdateResult;
}

export interface PersistedSystemState {
  preferences: SystemPreferences;
  appInstallations: Partial<Record<AppId, AppInstallation>>;
  knownAppIds: AppId[];
  appInstallationRevision: number;
  systemStatus: SystemStatusModel;
  systemStatusRevision: number;
}

const initialWindow = (id: AppId, zIndex: number): WindowState => {
  const app = APP_REGISTRY[id];
  return {
    appId: id,
    isOpen: true,
    isMinimized: false,
    isMaximized: false,
    zIndex,
    position: { ...app.defaultPosition },
    size: { ...app.defaultSize },
  };
};

function createDefaultInstallations(): Partial<Record<AppId, AppInstallation>> {
  return Object.fromEntries(
    PREINSTALLED_APP_IDS.map((appId) => [appId, { appId, version: APP_REGISTRY[appId].version, enabled: true }]),
  ) as Partial<Record<AppId, AppInstallation>>;
}

function normalizedRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizePreferences(value: unknown): SystemPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
  const candidate = value as Partial<SystemPreferences>;
  return {
    theme: candidate.theme === 'midnight' || candidate.theme === 'aurora' ? candidate.theme : DEFAULT_PREFERENCES.theme,
    reduceMotion: typeof candidate.reduceMotion === 'boolean' ? candidate.reduceMotion : DEFAULT_PREFERENCES.reduceMotion,
    soundEffects: typeof candidate.soundEffects === 'boolean' ? candidate.soundEffects : DEFAULT_PREFERENCES.soundEffects,
    dockMagnification:
      typeof candidate.dockMagnification === 'boolean' ? candidate.dockMagnification : DEFAULT_PREFERENCES.dockMagnification,
    accent: candidate.accent === 'cyan' || candidate.accent === 'amber' || candidate.accent === 'lime'
      ? candidate.accent
      : DEFAULT_PREFERENCES.accent,
  };
}

function isValidStatus(status: SystemStatusModel): boolean {
  return (
    typeof status.wifiEnabled === 'boolean' &&
    typeof status.bluetoothEnabled === 'boolean' &&
    typeof status.wifiLabel === 'string' &&
    status.wifiLabel.trim().length > 0 &&
    status.wifiLabel.length <= 64 &&
    typeof status.bluetoothLabel === 'string' &&
    status.bluetoothLabel.trim().length > 0 &&
    status.bluetoothLabel.length <= 64 &&
    Number.isInteger(status.healthScore) &&
    status.healthScore >= 0 &&
    status.healthScore <= 100 &&
    Number.isFinite(status.storageUsedGb) &&
    status.storageUsedGb >= 0 &&
    Number.isFinite(status.storageTotalGb) &&
    status.storageTotalGb > 0 &&
    status.storageUsedGb <= status.storageTotalGb &&
    (status.energyMode === 'Eco' || status.energyMode === 'Balanced' || status.energyMode === 'Performance') &&
    Number.isInteger(status.brightness) &&
    status.brightness >= 0 &&
    status.brightness <= 100 &&
    Number.isInteger(status.volume) &&
    status.volume >= 0 &&
    status.volume <= 100
  );
}

function sanitizeSystemStatus(value: unknown): SystemStatusModel {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SYSTEM_STATUS };
  const candidate = { ...DEFAULT_SYSTEM_STATUS, ...(value as Partial<SystemStatusModel>) };
  return isValidStatus(candidate) ? candidate : { ...DEFAULT_SYSTEM_STATUS };
}

function sanitizeKnownAppIds(value: unknown): AppId[] {
  if (!Array.isArray(value)) return [];
  const candidates = new Set(value.filter(isAppId));
  return APP_IDS.filter((appId) => candidates.has(appId));
}

function resolvePreviouslyKnownAppIds(
  knownAppIds: unknown,
  appInstallations: unknown,
  persistedVersion?: number,
): ReadonlySet<AppId> {
  if (persistedVersion !== undefined && persistedVersion < 2) {
    return new Set();
  }
  if (
    Array.isArray(knownAppIds) &&
    (
      persistedVersion === undefined ||
      (
        persistedVersion !== undefined &&
        persistedVersion >= FIRST_PERSISTENCE_VERSION_WITH_KNOWN_APP_IDS
      )
    )
  ) {
    return new Set(sanitizeKnownAppIds(knownAppIds));
  }

  if (appInstallations === undefined) return new Set();

  const legacyVersion = persistedVersion ?? LATEST_PERSISTENCE_VERSION_WITHOUT_KNOWN_APP_IDS;
  const historicalSnapshot = KNOWN_APP_IDS_BY_PERSISTENCE_VERSION[legacyVersion] ??
    KNOWN_APP_IDS_BY_PERSISTENCE_VERSION[PERSISTENCE_VERSION];
  return new Set(sanitizeKnownAppIds(historicalSnapshot));
}

function resolvePersistedInstallationAllowlist(
  knownAppIds: unknown,
  persistedVersion?: number,
): ReadonlySet<AppId> | undefined {
  if (persistedVersion !== undefined) {
    if (persistedVersion >= PERSISTENCE_VERSION) return undefined;
    return new Set(sanitizeKnownAppIds(RETAINABLE_INSTALLATION_IDS_BY_PERSISTENCE_VERSION[persistedVersion]));
  }
  if (Array.isArray(knownAppIds)) return undefined;
  return new Set(sanitizeKnownAppIds(LEGACY_RETAINABLE_INSTALLATION_IDS));
}

function sanitizeInstallations(
  value: unknown,
  previouslyKnownAppIds: ReadonlySet<AppId>,
  persistedInstallationAllowlist: ReadonlySet<AppId> | undefined,
): Partial<Record<AppId, AppInstallation>> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sanitized: Partial<Record<AppId, AppInstallation>> = {};

  for (const appId of APP_IDS) {
    const candidate = persistedInstallationAllowlist?.has(appId) === false ||
      !Object.prototype.hasOwnProperty.call(source, appId)
      ? undefined
      : source[appId];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const installation = candidate as Partial<AppInstallation>;
      if (
        Object.prototype.hasOwnProperty.call(installation, 'appId') &&
        Object.prototype.hasOwnProperty.call(installation, 'enabled') &&
        installation.appId === appId &&
        typeof installation.enabled === 'boolean'
      ) {
        sanitized[appId] = {
          appId,
          version: APP_REGISTRY[appId].version,
          enabled: isProtectedSystemApp(appId) ? true : installation.enabled,
        };
      }
    }
    if (isProtectedSystemApp(appId) && !sanitized[appId]) {
      sanitized[appId] = { appId, version: APP_REGISTRY[appId].version, enabled: true };
    } else if (
      APP_REGISTRY[appId].defaultInstallation === 'preinstalled' &&
      !previouslyKnownAppIds.has(appId) &&
      !sanitized[appId]
    ) {
      sanitized[appId] = { appId, version: APP_REGISTRY[appId].version, enabled: true };
    }
  }

  return sanitized;
}

export function restorePersistedSystemState(value: unknown, persistedVersion?: number): PersistedSystemState {
  const persisted = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const ownValue = (key: keyof PersistedSystemState): unknown => (
    Object.prototype.hasOwnProperty.call(persisted, key) ? persisted[key] : undefined
  );
  const persistedInstallations = ownValue('appInstallations');
  const knownAppIds = ownValue('knownAppIds');
  const previouslyKnownAppIds = resolvePreviouslyKnownAppIds(
    knownAppIds,
    persistedInstallations,
    persistedVersion,
  );
  const persistedInstallationAllowlist = resolvePersistedInstallationAllowlist(
    knownAppIds,
    persistedVersion,
  );
  return {
    preferences: sanitizePreferences(ownValue('preferences')),
    appInstallations: sanitizeInstallations(
      persistedInstallations,
      previouslyKnownAppIds,
      persistedInstallationAllowlist,
    ),
    knownAppIds: [...APP_IDS],
    appInstallationRevision: normalizedRevision(ownValue('appInstallationRevision')),
    systemStatus: sanitizeSystemStatus(ownValue('systemStatus')),
    systemStatusRevision: normalizedRevision(ownValue('systemStatusRevision')),
  };
}

function cloneInstallation(installation: AppInstallation | undefined): AppInstallation | null {
  return installation ? { ...installation } : null;
}

function installationResult(
  operation: AppInstallationOperation,
  appId: string,
  ok: boolean,
  changed: boolean,
  code: AppInstallationResult['code'],
  revision: number,
  installation?: AppInstallation,
): AppInstallationResult {
  return { operation, appId, ok, changed, code, revision, installation: cloneInstallation(installation) };
}

function isLaunchable(state: Pick<SystemStore, 'appInstallations'>, appId: AppId): boolean {
  return state.appInstallations[appId]?.enabled === true;
}

function nextWindowLayer(state: Pick<SystemStore, 'windows' | 'topZ'>): {
  windows: Partial<Record<AppId, WindowState>>;
  zIndex: number;
} {
  if (state.topZ < MAX_WINDOW_Z) {
    return { windows: state.windows, zIndex: state.topZ + 1 };
  }

  const ordered = Object.values(state.windows)
    .filter((window): window is WindowState => Boolean(window))
    .sort((left, right) => left.zIndex - right.zIndex || APP_IDS.indexOf(left.appId) - APP_IDS.indexOf(right.appId));
  const windows = { ...state.windows };
  ordered.forEach((window, index) => {
    windows[window.appId] = { ...window, zIndex: index + 1 };
  });
  return { windows, zIndex: ordered.length + 1 };
}

export const useSystemStore = create<SystemStore>()(
  persist(
    (set, get) => ({
      windows: { finder: initialWindow('finder', 1) },
      activeAppId: 'finder',
      topZ: 1,
      controlCenterOpen: false,
      clockOpen: false,
      preferences: { ...DEFAULT_PREFERENCES },
      appInstallations: createDefaultInstallations(),
      knownAppIds: [...APP_IDS],
      appInstallationRevision: 0,
      systemStatus: { ...DEFAULT_SYSTEM_STATUS },
      systemStatusRevision: 0,
      openApp: (id) => {
        const state = get();
        if (!isAppId(id) || !isLaunchable(state, id)) return;
        const layer = nextWindowLayer(state);
        const existing = layer.windows[id];
        set({
          topZ: layer.zIndex,
          activeAppId: id,
          controlCenterOpen: false,
          clockOpen: false,
          windows: {
            ...layer.windows,
            [id]: existing
              ? { ...existing, isOpen: true, isMinimized: false, zIndex: layer.zIndex }
              : initialWindow(id, layer.zIndex),
          },
        });
      },
      closeApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        set({
          windows: { ...state.windows, [id]: { ...win, isOpen: false } },
          activeAppId: state.activeAppId === id ? null : state.activeAppId,
        });
      },
      minimizeApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        set({
          windows: { ...state.windows, [id]: { ...win, isMinimized: true } },
          activeAppId: state.activeAppId === id ? null : state.activeAppId,
        });
      },
      focusApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win || !isLaunchable(state, id)) return;
        const layer = nextWindowLayer(state);
        const rebasedWindow = layer.windows[id] ?? win;
        set({
          topZ: layer.zIndex,
          activeAppId: id,
          windows: { ...layer.windows, [id]: { ...rebasedWindow, zIndex: layer.zIndex, isMinimized: false } },
        });
      },
      toggleMaximize: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        const maximized = !win.isMaximized;
        set({
          windows: {
            ...state.windows,
            [id]: maximized
              ? { ...win, isMaximized: true, restore: { position: win.position, size: win.size } }
              : {
                  ...win,
                  isMaximized: false,
                  position: win.restore?.position ?? win.position,
                  size: win.restore?.size ?? win.size,
                  restore: undefined,
                },
          },
        });
      },
      moveWindow: (id, x, y) => {
        const state = get();
        const win = state.windows[id];
        if (!win || win.isMaximized) return;
        set({ windows: { ...state.windows, [id]: { ...win, position: { x, y } } } });
      },
      resizeWindow: (id, width, height) => {
        const state = get();
        const win = state.windows[id];
        if (!win || win.isMaximized) return;
        set({ windows: { ...state.windows, [id]: { ...win, size: { width, height } } } });
      },
      setControlCenterOpen: (open) => set({ controlCenterOpen: open, clockOpen: false }),
      setClockOpen: (open) => set({ clockOpen: open, controlCenterOpen: false }),
      updatePreferences: (patch) => set((state) => ({ preferences: sanitizePreferences({ ...state.preferences, ...patch }) })),
      isAppLaunchable: (id) => isAppId(id) && isLaunchable(get(), id),
      installApp: (id) => {
        const state = get();
        if (!isAppId(id)) return installationResult('install', String(id), false, false, 'unknown-app', state.appInstallationRevision);
        const existing = state.appInstallations[id];
        if (existing) {
          return installationResult('install', id, true, false, 'already-installed', state.appInstallationRevision, existing);
        }
        const installation = { appId: id, version: APP_REGISTRY[id].version, enabled: true } satisfies AppInstallation;
        const revision = state.appInstallationRevision + 1;
        set({ appInstallations: { ...state.appInstallations, [id]: installation }, appInstallationRevision: revision });
        return installationResult('install', id, true, true, 'installed', revision, installation);
      },
      enableApp: (id) => {
        const state = get();
        if (!isAppId(id)) return installationResult('enable', String(id), false, false, 'unknown-app', state.appInstallationRevision);
        const existing = state.appInstallations[id];
        if (!existing) return installationResult('enable', id, false, false, 'not-installed', state.appInstallationRevision);
        if (existing.enabled) return installationResult('enable', id, true, false, 'already-enabled', state.appInstallationRevision, existing);
        const installation = { ...existing, enabled: true };
        const revision = state.appInstallationRevision + 1;
        set({ appInstallations: { ...state.appInstallations, [id]: installation }, appInstallationRevision: revision });
        return installationResult('enable', id, true, true, 'enabled', revision, installation);
      },
      disableApp: (id) => {
        const state = get();
        if (!isAppId(id)) return installationResult('disable', String(id), false, false, 'unknown-app', state.appInstallationRevision);
        const existing = state.appInstallations[id];
        if (!existing) return installationResult('disable', id, false, false, 'not-installed', state.appInstallationRevision);
        if (isProtectedSystemApp(id)) {
          return installationResult('disable', id, false, false, 'protected-system-app', state.appInstallationRevision, existing);
        }
        if (!existing.enabled) return installationResult('disable', id, true, false, 'already-disabled', state.appInstallationRevision, existing);
        const installation = { ...existing, enabled: false };
        const window = state.windows[id];
        const revision = state.appInstallationRevision + 1;
        set({
          appInstallations: { ...state.appInstallations, [id]: installation },
          appInstallationRevision: revision,
          windows: window ? { ...state.windows, [id]: { ...window, isOpen: false, isMinimized: false } } : state.windows,
          activeAppId: state.activeAppId === id ? null : state.activeAppId,
        });
        return installationResult('disable', id, true, true, 'disabled', revision, installation);
      },
      uninstallApp: (id) => {
        const state = get();
        if (!isAppId(id)) return installationResult('uninstall', String(id), false, false, 'unknown-app', state.appInstallationRevision);
        const existing = state.appInstallations[id];
        if (!existing) return installationResult('uninstall', id, true, false, 'not-installed', state.appInstallationRevision);
        if (isProtectedSystemApp(id)) {
          return installationResult('uninstall', id, false, false, 'protected-system-app', state.appInstallationRevision, existing);
        }
        const installations = { ...state.appInstallations };
        delete installations[id];
        const windows = { ...state.windows };
        delete windows[id];
        const revision = state.appInstallationRevision + 1;
        set({
          appInstallations: installations,
          appInstallationRevision: revision,
          windows,
          activeAppId: state.activeAppId === id ? null : state.activeAppId,
        });
        return installationResult('uninstall', id, true, true, 'uninstalled', revision);
      },
      updateSystemStatus: (patch) => {
        const state = get();
        if (
          !patch ||
          typeof patch !== 'object' ||
          Object.keys(patch).some((key) => !SYSTEM_STATUS_KEYS.has(key as keyof SystemStatusModel))
        ) {
          return { ok: false, changed: false, code: 'invalid-patch', revision: state.systemStatusRevision, status: { ...state.systemStatus } };
        }
        const status = { ...state.systemStatus, ...patch };
        if (!isValidStatus(status)) {
          return { ok: false, changed: false, code: 'invalid-patch', revision: state.systemStatusRevision, status: { ...state.systemStatus } };
        }
        const changed = (Object.keys(status) as (keyof SystemStatusModel)[]).some((key) => status[key] !== state.systemStatus[key]);
        if (!changed) {
          return { ok: true, changed: false, code: 'unchanged', revision: state.systemStatusRevision, status: { ...state.systemStatus } };
        }
        const revision = state.systemStatusRevision + 1;
        set({ systemStatus: status, systemStatusRevision: revision });
        return { ok: true, changed: true, code: 'updated', revision, status: { ...status } };
      },
    }),
    {
      name: 'alsniper-os-preferences',
      version: PERSISTENCE_VERSION,
      partialize: (state): PersistedSystemState => ({
        preferences: state.preferences,
        appInstallations: state.appInstallations,
        knownAppIds: state.knownAppIds,
        appInstallationRevision: state.appInstallationRevision,
        systemStatus: state.systemStatus,
        systemStatusRevision: state.systemStatusRevision,
      }),
      migrate: (persistedState, persistedVersion) => restorePersistedSystemState(persistedState, persistedVersion),
      merge: (persistedState, currentState) => {
        const persisted = restorePersistedSystemState(persistedState);
        return {
          ...currentState,
          ...persisted,
        };
      },
    },
  ),
);
