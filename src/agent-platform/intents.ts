import { validateAgentManifest, type AgentManifest, type OsCapability } from './agentManifest';
import type { A2uiSurface } from './a2ui';
import { validateA2uiSurface } from './a2ui';
import {
  assertBoolean,
  assertEnum,
  assertExactKeys,
  assertFiniteNumber,
  assertRecord,
  assertSafeInteger,
  assertString,
  ValidationError,
} from './validation';

export const INTENT_TYPES = [
  'open_app',
  'close_app',
  'focus_app',
  'minimize_app',
  'install_app',
  'set_preferences',
  'install_agent',
  'set_system_status',
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

interface IntentBase {
  readonly id: string;
  readonly expectedRevision?: number;
}

export const ENERGY_MODES = ['Eco', 'Balanced', 'Performance'] as const;
export type EnergyMode = (typeof ENERGY_MODES)[number];

export interface SystemStatusSnapshot {
  readonly wifiEnabled: boolean;
  readonly wifiLabel: string;
  readonly bluetoothEnabled: boolean;
  readonly bluetoothLabel: string;
  readonly healthScore: number;
  readonly storageUsedGb: number;
  readonly storageTotalGb: number;
  readonly energyMode: EnergyMode;
  readonly brightness: number;
  readonly volume: number;
}

export type SystemStatusPatch = Partial<Pick<
  SystemStatusSnapshot,
  'wifiEnabled' | 'bluetoothEnabled' | 'energyMode' | 'brightness' | 'volume'
>>;

const SYSTEM_STATUS_KEYS = [
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
] as const satisfies readonly (keyof SystemStatusSnapshot)[];

const SYSTEM_STATUS_PATCH_KEYS = [
  'wifiEnabled',
  'bluetoothEnabled',
  'energyMode',
  'brightness',
  'volume',
] as const satisfies readonly (keyof SystemStatusPatch)[];

const validateStatusLabel = (value: unknown, path: string): string => {
  const label = assertString(value, path, { min: 1, max: 64 });
  if (label.trim().length === 0) throw new ValidationError(path, 'must contain a non-whitespace character');
  return label;
};

const validateSystemStatusRecord = (
  value: unknown,
  path: string,
  required: boolean,
): SystemStatusPatch => {
  const record = assertRecord(value, path);
  assertExactKeys(record, required ? SYSTEM_STATUS_KEYS : [], required ? [] : SYSTEM_STATUS_PATCH_KEYS, path);
  if (!required && Object.keys(record).length === 0) throw new ValidationError(path, 'at least one status field is required');
  const result: Partial<SystemStatusSnapshot> = {
    ...(record.wifiEnabled === undefined ? {} : { wifiEnabled: assertBoolean(record.wifiEnabled, `${path}.wifiEnabled`) }),
    ...(required ? { wifiLabel: validateStatusLabel(record.wifiLabel, `${path}.wifiLabel`) } : {}),
    ...(record.bluetoothEnabled === undefined ? {} : { bluetoothEnabled: assertBoolean(record.bluetoothEnabled, `${path}.bluetoothEnabled`) }),
    ...(required ? { bluetoothLabel: validateStatusLabel(record.bluetoothLabel, `${path}.bluetoothLabel`) } : {}),
    ...(required ? { healthScore: assertSafeInteger(record.healthScore, `${path}.healthScore`, { min: 0, max: 100 }) } : {}),
    ...(required ? { storageUsedGb: assertFiniteNumber(record.storageUsedGb, `${path}.storageUsedGb`, 0) } : {}),
    ...(required ? { storageTotalGb: assertFiniteNumber(record.storageTotalGb, `${path}.storageTotalGb`, Number.MIN_VALUE) } : {}),
    ...(record.energyMode === undefined ? {} : { energyMode: assertEnum(record.energyMode, ENERGY_MODES, `${path}.energyMode`) }),
    ...(record.brightness === undefined ? {} : { brightness: assertSafeInteger(record.brightness, `${path}.brightness`, { min: 0, max: 100 }) }),
    ...(record.volume === undefined ? {} : { volume: assertSafeInteger(record.volume, `${path}.volume`, { min: 0, max: 100 }) }),
  };
  if (
    result.storageUsedGb !== undefined &&
    result.storageTotalGb !== undefined &&
    result.storageUsedGb > result.storageTotalGb
  ) {
    throw new ValidationError(path, 'storageUsedGb cannot exceed storageTotalGb');
  }
  return Object.freeze(result) as SystemStatusPatch;
};

export const validateSystemStatusSnapshot = (value: unknown, path = 'systemStatus'): SystemStatusSnapshot =>
  validateSystemStatusRecord(value, path, true) as SystemStatusSnapshot;

export const validateSystemStatusPatch = (value: unknown, path = 'statusPatch'): SystemStatusPatch =>
  validateSystemStatusRecord(value, path, false);

export type OsIntent =
  | (IntentBase & { readonly type: 'open_app' | 'close_app' | 'focus_app' | 'minimize_app'; readonly appId: string })
  | (IntentBase & { readonly type: 'install_app'; readonly listingId: string })
  | (IntentBase & {
      readonly type: 'set_preferences';
      readonly preferences: {
        readonly theme?: 'aurora' | 'midnight';
        readonly reduceMotion?: boolean;
        readonly soundEffects?: boolean;
        readonly dockMagnification?: boolean;
        readonly accent?: 'lime' | 'cyan' | 'amber';
      };
    })
  | (IntentBase & { readonly type: 'set_system_status'; readonly statusPatch: SystemStatusPatch })
  | (IntentBase & { readonly type: 'install_agent'; readonly manifest: AgentManifest });

export interface PublishSurfaceIntent extends IntentBase {
  readonly type: 'publish_surface';
  readonly surface: A2uiSurface;
  readonly availableIntents: readonly OsIntent[];
}

export type BrokerIntent = OsIntent | PublishSurfaceIntent;

export const validateOsIntent = (value: unknown, path = 'intent'): OsIntent => {
  const record = assertRecord(value, path);
  const type = assertEnum(record.type, INTENT_TYPES, `${path}.type`);
  const id = assertString(record.id, `${path}.id`, { min: 1, max: 128 });
  const commonOptional = ['expectedRevision'] as const;
  const expectedRevision = record.expectedRevision === undefined
    ? undefined
    : assertSafeInteger(record.expectedRevision, `${path}.expectedRevision`, { min: 0 });
  const base = expectedRevision === undefined ? { id } : { id, expectedRevision };

  if (type === 'open_app' || type === 'close_app' || type === 'focus_app' || type === 'minimize_app') {
    assertExactKeys(record, ['id', 'type', 'appId'], commonOptional, path);
    return Object.freeze({ ...base, type, appId: assertString(record.appId, `${path}.appId`, { min: 1, max: 128 }) });
  }
  if (type === 'install_app') {
    assertExactKeys(record, ['id', 'type', 'listingId'], commonOptional, path);
    return Object.freeze({ ...base, type, listingId: assertString(record.listingId, `${path}.listingId`, { min: 1, max: 128 }) });
  }
  if (type === 'install_agent') {
    assertExactKeys(record, ['id', 'type', 'manifest'], commonOptional, path);
    return Object.freeze({ ...base, type, manifest: validateAgentManifest(record.manifest, `${path}.manifest`) });
  }
  if (type === 'set_system_status') {
    assertExactKeys(record, ['id', 'type', 'statusPatch'], commonOptional, path);
    return Object.freeze({ ...base, type, statusPatch: validateSystemStatusPatch(record.statusPatch, `${path}.statusPatch`) });
  }

  assertExactKeys(record, ['id', 'type', 'preferences'], commonOptional, path);
  const preferences = assertRecord(record.preferences, `${path}.preferences`);
  assertExactKeys(preferences, [], ['theme', 'reduceMotion', 'soundEffects', 'dockMagnification', 'accent'], `${path}.preferences`);
  if (Object.keys(preferences).length === 0) throw new ValidationError(`${path}.preferences`, 'at least one preference is required');
  const result: Extract<OsIntent, { type: 'set_preferences' }>['preferences'] = {
    ...(preferences.theme === undefined ? {} : { theme: assertEnum(preferences.theme, ['aurora', 'midnight'] as const, `${path}.preferences.theme`) }),
    ...(preferences.reduceMotion === undefined ? {} : { reduceMotion: assertBoolean(preferences.reduceMotion, `${path}.preferences.reduceMotion`) }),
    ...(preferences.soundEffects === undefined ? {} : { soundEffects: assertBoolean(preferences.soundEffects, `${path}.preferences.soundEffects`) }),
    ...(preferences.dockMagnification === undefined ? {} : { dockMagnification: assertBoolean(preferences.dockMagnification, `${path}.preferences.dockMagnification`) }),
    ...(preferences.accent === undefined ? {} : { accent: assertEnum(preferences.accent, ['lime', 'cyan', 'amber'] as const, `${path}.preferences.accent`) }),
  };
  return Object.freeze({ ...base, type, preferences: Object.freeze(result) });
};

export const validatePublishSurfaceIntent = (value: unknown, path = 'intent'): PublishSurfaceIntent => {
  const record = assertRecord(value, path);
  assertExactKeys(record, ['id', 'type', 'surface', 'availableIntents'], ['expectedRevision'], path);
  if (record.type !== 'publish_surface') throw new ValidationError(`${path}.type`, 'expected publish_surface');
  const availableIntents = Object.freeze((Array.isArray(record.availableIntents) ? record.availableIntents : []).map((intent, index) =>
    validateOsIntent(intent, `${path}.availableIntents[${index}]`)));
  const intentIds = new Set(availableIntents.map((intent) => intent.id));
  return Object.freeze({
    id: assertString(record.id, `${path}.id`, { min: 1, max: 128 }),
    type: 'publish_surface',
    ...(record.expectedRevision === undefined ? {} : {
      expectedRevision: assertSafeInteger(record.expectedRevision, `${path}.expectedRevision`, { min: 0 }),
    }),
    surface: validateA2uiSurface(record.surface, { validIntentIds: intentIds, path: `${path}.surface` }),
    availableIntents,
  });
};

export const capabilityForIntent = (intent: BrokerIntent): OsCapability => {
  switch (intent.type) {
    case 'open_app': return 'os.app.open';
    case 'close_app': return 'os.app.close';
    case 'focus_app': return 'os.app.focus';
    case 'minimize_app': return 'os.app.minimize';
    case 'set_preferences': return 'os.preferences.write';
    case 'set_system_status': return 'os.system-status.write';
    case 'install_app': return 'store.app.install';
    case 'install_agent': return 'agent.package.install';
    case 'publish_surface': return 'a2ui.surface.publish';
  }
};
