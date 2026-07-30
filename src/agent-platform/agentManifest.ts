import {
  assertArray,
  assertEnum,
  assertExactKeys,
  assertRecord,
  assertString,
  stableSerialize,
  ValidationError,
} from './validation';

export const OS_CAPABILITIES = [
  'os.app.open',
  'os.app.close',
  'os.app.focus',
  'os.app.minimize',
  'app.action.execute',
  'os.preferences.write',
  'os.system-status.write',
  'store.app.install',
  'agent.package.install',
  'a2ui.surface.publish',
] as const;

export type OsCapability = (typeof OS_CAPABILITIES)[number];
export const AGENT_CONTRIBUTIONS = ['domain-agent', 'game-controller', 'a2ui-surface-provider'] as const;
export type AgentContribution = (typeof AGENT_CONTRIBUTIONS)[number];

export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
  /** Requested upper bound only. Installation never grants these capabilities. */
  readonly capabilities: readonly OsCapability[];
  readonly publisher: {
    readonly id: string;
    readonly displayName: string;
    readonly trust: 'local-unverified' | 'first-party';
  };
  readonly generatedBy?: {
    readonly provider: 'codex';
    readonly model?: string;
    readonly runId: string;
  };
  readonly contributions: readonly AgentContribution[];
  /** SHA-256 of the canonical manifest with this field omitted. */
  readonly contentDigest: `sha256:${string}`;
}

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const uniqueClosedArray = <T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  max: number,
): readonly T[] => {
  const result = assertArray(value, path, {
    max,
    item: (entry, itemPath) => assertEnum(entry, allowed, itemPath),
  });
  if (new Set(result).size !== result.length) throw new ValidationError(path, 'duplicate value');
  return Object.freeze([...result]);
};

export const validateAgentManifest = (value: unknown, path = 'manifest'): AgentManifest => {
  const record = assertRecord(value, path);
  assertExactKeys(
    record,
    ['id', 'name', 'version', 'description', 'instructions', 'capabilities', 'publisher', 'contributions', 'contentDigest'],
    ['generatedBy'],
    path,
  );
  const publisher = assertRecord(record.publisher, `${path}.publisher`);
  assertExactKeys(publisher, ['id', 'displayName', 'trust'], [], `${path}.publisher`);
  let generatedBy: AgentManifest['generatedBy'];
  if (record.generatedBy !== undefined) {
    const generated = assertRecord(record.generatedBy, `${path}.generatedBy`);
    assertExactKeys(generated, ['provider', 'runId'], ['model'], `${path}.generatedBy`);
    if (generated.provider !== 'codex') throw new ValidationError(`${path}.generatedBy.provider`, 'unsupported generator');
    generatedBy = Object.freeze({
      provider: 'codex',
      runId: assertString(generated.runId, `${path}.generatedBy.runId`, { min: 1, max: 128 }),
      ...(generated.model === undefined ? {} : { model: assertString(generated.model, `${path}.generatedBy.model`, { min: 1, max: 128 }) }),
    });
  }
  return Object.freeze({
    id: assertString(record.id, `${path}.id`, { min: 3, max: 128, pattern: IDENTIFIER }),
    name: assertString(record.name, `${path}.name`, { min: 1, max: 80 }),
    version: assertString(record.version, `${path}.version`, { min: 5, max: 64, pattern: VERSION }),
    description: assertString(record.description, `${path}.description`, { min: 1, max: 500 }),
    instructions: assertString(record.instructions, `${path}.instructions`, { min: 1, max: 12_000 }),
    capabilities: uniqueClosedArray(record.capabilities, `${path}.capabilities`, OS_CAPABILITIES, OS_CAPABILITIES.length),
    publisher: Object.freeze({
      id: assertString(publisher.id, `${path}.publisher.id`, { min: 3, max: 128, pattern: IDENTIFIER }),
      displayName: assertString(publisher.displayName, `${path}.publisher.displayName`, { min: 1, max: 80 }),
      trust: assertEnum(publisher.trust, ['local-unverified', 'first-party'], `${path}.publisher.trust`),
    }),
    ...(generatedBy === undefined ? {} : { generatedBy }),
    contributions: uniqueClosedArray(record.contributions, `${path}.contributions`, AGENT_CONTRIBUTIONS, AGENT_CONTRIBUTIONS.length),
    contentDigest: assertString(record.contentDigest, `${path}.contentDigest`, { min: 71, max: 71, pattern: DIGEST }) as `sha256:${string}`,
  });
};

export const canonicalAgentManifestContent = (manifest: AgentManifest): string => {
  const { contentDigest: _contentDigest, ...content } = validateAgentManifest(manifest);
  return stableSerialize(content);
};

export interface InstalledAgent {
  readonly installationId: string;
  readonly manifest: AgentManifest;
  readonly digest: `sha256:${string}`;
  readonly status: 'enabled' | 'disabled';
  readonly installedAt: string;
  readonly updatedAt: string;
  /** Always empty here. Grants live in the trusted capability host. */
  readonly grantedCapabilities: readonly never[];
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DigestPort {
  sha256(content: string): Promise<string>;
}

/** Trusted host boundary for publisher identity; manifest claims are never proof. */
export interface PublisherVerificationPort {
  verify(manifest: AgentManifest): Promise<boolean>;
}

export interface AgentRegistry {
  list(): readonly InstalledAgent[];
  get(id: string): InstalledAgent | undefined;
  install(manifest: unknown): Promise<InstalledAgent>;
  enable(id: string): Promise<InstalledAgent>;
  disable(id: string): Promise<InstalledAgent>;
  uninstall(id: string): Promise<boolean>;
}

export interface AgentRegistryOptions {
  readonly storage?: KeyValueStorage;
  readonly storageKey?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly digest?: DigestPort;
  readonly publisherVerification?: PublisherVerificationPort;
}

const DEFAULT_STORAGE_KEY = 'alsniper-os-agent-packages-v2';

const defaultIdFactory = (): string => {
  if (!globalThis.crypto?.randomUUID) throw new AgentRegistryError('AGENT_REGISTRY_CRYPTO_UNAVAILABLE', 'Secure installation IDs are unavailable.');
  return globalThis.crypto.randomUUID();
};

const defaultDigest: DigestPort = Object.freeze({
  sha256: async (content: string) => {
    if (!globalThis.crypto?.subtle) throw new AgentRegistryError('AGENT_REGISTRY_CRYPTO_UNAVAILABLE', 'Web Crypto SHA-256 is unavailable.');
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  },
});

const defaultPublisherVerification: PublisherVerificationPort = Object.freeze({
  verify: async (manifest: AgentManifest) => manifest.publisher.trust === 'local-unverified',
});

const cloneInstalled = (agent: InstalledAgent): InstalledAgent => Object.freeze({
  installationId: agent.installationId,
  manifest: validateAgentManifest(agent.manifest),
  digest: agent.digest,
  status: agent.status,
  installedAt: agent.installedAt,
  updatedAt: agent.updatedAt,
  grantedCapabilities: Object.freeze([]),
});

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[] | undefined;
}

const parseVersion = (version: string): ParsedVersion => {
  const match = VERSION.exec(version);
  if (!match) throw new ValidationError('version', 'invalid semantic version');
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4]?.split('.'),
  };
};

const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a.core[index]!;
    const rightPart = b.core[index]!;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  if (a.prerelease === undefined && b.prerelease !== undefined) return 1;
  if (a.prerelease !== undefined && b.prerelease === undefined) return -1;
  if (a.prerelease === undefined || b.prerelease === undefined) return 0;
  const leftParts = a.prerelease;
  const rightParts = b.prerelease;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
};

const validateTimestamp = (value: unknown, path: string): string => {
  const timestamp = assertString(value, path, { min: 20, max: 40 });
  if (Number.isNaN(Date.parse(timestamp))) throw new ValidationError(path, 'invalid timestamp');
  return timestamp;
};

const validateInstalled = (value: unknown, path: string): InstalledAgent => {
  const record = assertRecord(value, path);
  assertExactKeys(record, ['installationId', 'manifest', 'digest', 'status', 'installedAt', 'updatedAt', 'grantedCapabilities'], [], path);
  assertArray(record.grantedCapabilities, `${path}.grantedCapabilities`, {
    max: 0,
    item: (_entry, itemPath) => { throw new ValidationError(itemPath, 'stored grants are forbidden'); },
  });
  const manifest = validateAgentManifest(record.manifest, `${path}.manifest`);
  const digest = assertString(record.digest, `${path}.digest`, { min: 71, max: 71, pattern: DIGEST }) as `sha256:${string}`;
  if (digest !== manifest.contentDigest) throw new ValidationError(`${path}.digest`, 'digest does not match manifest');
  return cloneInstalled({
    installationId: assertString(record.installationId, `${path}.installationId`, { min: 8, max: 128 }),
    manifest,
    digest,
    status: assertEnum(record.status, ['enabled', 'disabled'], `${path}.status`),
    installedAt: validateTimestamp(record.installedAt, `${path}.installedAt`),
    updatedAt: validateTimestamp(record.updatedAt, `${path}.updatedAt`),
    grantedCapabilities: [],
  });
};

export const createAgentRegistry = async (options: AgentRegistryOptions = {}): Promise<AgentRegistry> => {
  const storage = options.storage;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const digest = options.digest ?? defaultDigest;
  const publisherVerification = options.publisherVerification ?? defaultPublisherVerification;
  const agents = new Map<string, InstalledAgent>();

  const verifyPublisher = async (manifest: AgentManifest): Promise<void> => {
    try {
      if (await publisherVerification.verify(manifest)) return;
    } catch (error) {
      throw new AgentRegistryError(
        'AGENT_REGISTRY_PUBLISHER_UNVERIFIED',
        'Agent publisher identity could not be verified by the trusted host.',
        error,
      );
    }
    throw new AgentRegistryError(
      'AGENT_REGISTRY_PUBLISHER_UNVERIFIED',
      'Agent publisher identity could not be verified by the trusted host.',
    );
  };

  if (storage) {
    try {
      const encoded = storage.getItem(storageKey);
      if (encoded) {
        const parsed: unknown = JSON.parse(encoded);
        const records = assertArray(parsed, 'registry', { max: 128, item: validateInstalled });
        for (const agent of records) {
          if (agents.has(agent.manifest.id)) throw new ValidationError('registry', 'duplicate package id');
          const computed = `sha256:${await digest.sha256(canonicalAgentManifestContent(agent.manifest))}`;
          if (computed !== agent.digest) throw new ValidationError('registry', 'persisted package digest verification failed');
          await verifyPublisher(agent.manifest);
          agents.set(agent.manifest.id, agent);
        }
      }
    } catch {
      agents.clear();
    }
  }

  const persist = (): void => {
    if (storage) storage.setItem(storageKey, JSON.stringify([...agents.values()]));
  };

  const mutate = async <T>(operation: () => T): Promise<T> => {
    const before = new Map(agents);
    const result = operation();
    try { persist(); } catch (error) {
      agents.clear();
      for (const [id, agent] of before) agents.set(id, agent);
      throw new AgentRegistryError('AGENT_REGISTRY_STORAGE_FAILED', 'Agent registry change could not be persisted.', error);
    }
    return result;
  };

  const changeStatus = async (id: string, status: InstalledAgent['status']): Promise<InstalledAgent> => {
    const existing = agents.get(id);
    if (!existing) throw new AgentRegistryError('AGENT_REGISTRY_NOT_FOUND', 'Agent package is not installed.');
    if (existing.status === status) return cloneInstalled(existing);
    return mutate(() => {
      const updated = cloneInstalled({ ...existing, status, updatedAt: now().toISOString() });
      agents.set(id, updated);
      return cloneInstalled(updated);
    });
  };

  return Object.freeze({
    list: () => Object.freeze([...agents.values()].map(cloneInstalled)),
    get: (id: string) => {
      const result = agents.get(id);
      return result ? cloneInstalled(result) : undefined;
    },
    install: async (candidate: unknown) => {
      const manifest = validateAgentManifest(candidate);
      const computed = `sha256:${await digest.sha256(canonicalAgentManifestContent(manifest))}` as const;
      if (computed !== manifest.contentDigest) {
        throw new AgentRegistryError('AGENT_REGISTRY_DIGEST_MISMATCH', 'Agent manifest content digest does not match its canonical content.');
      }
      await verifyPublisher(manifest);
      const existing = agents.get(manifest.id);
      if (existing?.digest === computed) return cloneInstalled(existing);
      if (existing) {
        const versionOrder = compareVersions(manifest.version, existing.manifest.version);
        if (versionOrder < 0) {
          throw new AgentRegistryError('AGENT_REGISTRY_DOWNGRADE_DENIED', 'Agent package downgrade is denied.');
        }
        if (versionOrder === 0) {
          throw new AgentRegistryError('AGENT_REGISTRY_VERSION_CONFLICT', 'Equivalent semantic versions cannot replace different content.');
        }
      }
      return mutate(() => {
        const timestamp = now().toISOString();
        const installed = cloneInstalled({
          installationId: existing?.installationId ?? idFactory(),
          manifest,
          digest: computed,
          status: existing?.status ?? 'enabled',
          installedAt: existing?.installedAt ?? timestamp,
          updatedAt: timestamp,
          grantedCapabilities: [],
        });
        agents.set(manifest.id, installed);
        return cloneInstalled(installed);
      });
    },
    enable: (id: string) => changeStatus(id, 'enabled'),
    disable: (id: string) => changeStatus(id, 'disabled'),
    uninstall: async (id: string) => {
      if (!agents.has(id)) return false;
      return mutate(() => agents.delete(id));
    },
  });
};

export type AgentRegistryErrorCode =
  | 'AGENT_REGISTRY_STORAGE_FAILED'
  | 'AGENT_REGISTRY_CRYPTO_UNAVAILABLE'
  | 'AGENT_REGISTRY_DIGEST_MISMATCH'
  | 'AGENT_REGISTRY_PUBLISHER_UNVERIFIED'
  | 'AGENT_REGISTRY_DOWNGRADE_DENIED'
  | 'AGENT_REGISTRY_VERSION_CONFLICT'
  | 'AGENT_REGISTRY_NOT_FOUND';

export class AgentRegistryError extends Error {
  readonly code: AgentRegistryErrorCode;
  readonly cause?: unknown;

  constructor(code: AgentRegistryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
    this.cause = cause;
  }
}

export type AgentRegistryPersistenceMode = 'persistent' | 'memory-only';

export interface BrowserAgentRegistryOptions extends Omit<AgentRegistryOptions, 'storage'> {
  readonly onPersistenceModeChange?: (mode: AgentRegistryPersistenceMode) => void;
  /** Injectable browser boundary for deterministic tests and embedded WebViews. */
  readonly storageFactory?: () => KeyValueStorage | undefined;
}

const createMemoryStorage = (): KeyValueStorage => {
  const values = new Map<string, string>();
  return Object.freeze({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
};

const defaultBrowserStorageFactory = (): KeyValueStorage | undefined =>
  typeof window === 'undefined' ? undefined : window.localStorage;

/**
 * Browser persistence is an availability feature, never a prerequisite for
 * the Agent runtime. A denied or failing storage backend degrades atomically
 * to a session-only in-memory mirror without losing the current mutation.
 */
export const createBrowserAgentRegistry = (
  options: BrowserAgentRegistryOptions = {},
): Promise<AgentRegistry> => {
  const {
    onPersistenceModeChange,
    storageFactory = defaultBrowserStorageFactory,
    ...registryOptions
  } = options;
  const memory = createMemoryStorage();
  let persistent: KeyValueStorage | undefined;
  let mode: AgentRegistryPersistenceMode = 'persistent';
  const publishMode = (nextMode: AgentRegistryPersistenceMode): void => {
    if (mode === nextMode) return;
    mode = nextMode;
    try { onPersistenceModeChange?.(nextMode); } catch { /* Status observers cannot break registry operations. */ }
  };
  try {
    persistent = storageFactory();
  } catch {
    persistent = undefined;
  }
  if (persistent === undefined) publishMode('memory-only');
  else {
    try { onPersistenceModeChange?.('persistent'); } catch { /* Status observers cannot break registry startup. */ }
  }

  const storage: KeyValueStorage = Object.freeze({
    getItem: (key: string): string | null => {
      if (persistent === undefined) return memory.getItem(key);
      try {
        const value = persistent.getItem(key);
        if (value !== null) memory.setItem(key, value);
        return value;
      } catch {
        persistent = undefined;
        publishMode('memory-only');
        return memory.getItem(key);
      }
    },
    setItem: (key: string, value: string): void => {
      memory.setItem(key, value);
      if (persistent === undefined) return;
      try {
        persistent.setItem(key, value);
      } catch {
        persistent = undefined;
        publishMode('memory-only');
      }
    },
  });

  return createAgentRegistry({ ...registryOptions, storage });
};
