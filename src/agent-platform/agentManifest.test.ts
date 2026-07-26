import { describe, expect, it } from 'vitest';
import {
  AgentRegistryError,
  canonicalAgentManifestContent,
  createAgentRegistry,
  createBrowserAgentRegistry,
  type AgentManifest,
  type KeyValueStorage,
} from './agentManifest';

const digestHex = 'a'.repeat(64);
const manifest = (version = '1.0.0', digest = `sha256:${digestHex}`): AgentManifest => ({
  id: 'local.weather-guide',
  name: 'Weather Guide',
  version,
  description: 'Explains local weather context.',
  instructions: 'Use the supplied weather context and be concise.',
  capabilities: ['a2ui.surface.publish'],
  publisher: { id: 'local.user', displayName: 'Local User', trust: 'local-unverified' },
  generatedBy: { provider: 'codex', model: 'test-model', runId: 'run-1' },
  contributions: ['domain-agent', 'a2ui-surface-provider'],
  contentDigest: digest as `sha256:${string}`,
});

const firstPartyManifest = (version = '1.0.0', digest = `sha256:${digestHex}`): AgentManifest => ({
  ...manifest(version, digest),
  publisher: { id: 'aios.official', displayName: 'AlSniper OS', trust: 'first-party' },
  generatedBy: undefined,
});

const storage = (): KeyValueStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
};

describe('agent registry', () => {
  it('verifies provenance digest, persists lifecycle, and never grants requested capabilities', async () => {
    const backing = storage();
    let clock = 0;
    const registry = await createAgentRegistry({
      storage: backing,
      now: () => new Date(1_700_000_000_000 + clock++ * 1_000),
      idFactory: () => 'installation-1',
      digest: { sha256: async (content) => {
        expect(content).toBe(canonicalAgentManifestContent(manifest()));
        expect(content).not.toContain('contentDigest');
        return digestHex;
      } },
    });
    const installed = await registry.install(manifest());
    expect(installed).toMatchObject({ installationId: 'installation-1', status: 'enabled', digest: `sha256:${digestHex}` });
    expect(installed.grantedCapabilities).toEqual([]);
    expect((await registry.disable(installed.manifest.id)).status).toBe('disabled');
    expect((await registry.enable(installed.manifest.id)).status).toBe('enabled');
    expect(await registry.uninstall(installed.manifest.id)).toBe(true);
    expect(await registry.uninstall(installed.manifest.id)).toBe(false);
  });

  it('is idempotent by digest and denies downgrade or same-version mutation', async () => {
    const registry = await createAgentRegistry({
      idFactory: () => 'installation-1',
      digest: { sha256: async (content) => content.includes('changed') ? 'b'.repeat(64) : content.includes('0.9.0') ? 'c'.repeat(64) : digestHex },
    });
    const first = await registry.install(manifest());
    expect(await registry.install(manifest())).toEqual(first);
    await expect(registry.install({ ...manifest('0.9.0', `sha256:${'c'.repeat(64)}`) })).rejects.toMatchObject({ code: 'AGENT_REGISTRY_DOWNGRADE_DENIED' });
    await expect(registry.install({
      ...manifest(),
      description: 'changed',
      contentDigest: `sha256:${'b'.repeat(64)}`,
    })).rejects.toMatchObject({ code: 'AGENT_REGISTRY_VERSION_CONFLICT' });
  });

  it('rejects content tampering and fails closed on malformed persisted grants', async () => {
    const backing = storage();
    const registry = await createAgentRegistry({ digest: { sha256: async () => 'b'.repeat(64) } });
    await expect(registry.install(manifest())).rejects.toBeInstanceOf(AgentRegistryError);
    backing.values.set('alsniper-os-agent-packages-v2', JSON.stringify([{
      installationId: 'installation-1', manifest: manifest(), digest: `sha256:${digestHex}`,
      status: 'enabled', installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      grantedCapabilities: ['os.app.open'],
    }]));
    expect((await createAgentRegistry({ storage: backing, digest: { sha256: async () => digestHex } })).list()).toEqual([]);
  });

  it('never trusts a candidate first-party claim without host verification and re-verifies recovery', async () => {
    const backing = storage();
    const untrusted = await createAgentRegistry({ digest: { sha256: async () => digestHex } });
    await expect(untrusted.install(firstPartyManifest())).rejects.toMatchObject({
      code: 'AGENT_REGISTRY_PUBLISHER_UNVERIFIED',
    });

    const verifiedSources: string[] = [];
    const publisherVerification = {
      verify: async (candidate: AgentManifest) => {
        verifiedSources.push(candidate.publisher.id);
        return candidate.publisher.id === 'aios.official' && candidate.publisher.trust === 'first-party';
      },
    };
    const registry = await createAgentRegistry({
      storage: backing,
      idFactory: () => 'installation-1',
      digest: { sha256: async () => digestHex },
      publisherVerification,
    });
    await registry.install(firstPartyManifest());
    expect(verifiedSources).toEqual(['aios.official']);

    const restored = await createAgentRegistry({
      storage: backing,
      digest: { sha256: async () => digestHex },
      publisherVerification,
    });
    expect(restored.list()).toHaveLength(1);
    expect(verifiedSources).toEqual(['aios.official', 'aios.official']);

    const defaultRecovery = await createAgentRegistry({ storage: backing, digest: { sha256: async () => digestHex } });
    expect(defaultRecovery.list()).toEqual([]);
  });

  it('compares arbitrarily large SemVer core and prerelease numbers without precision loss', async () => {
    const digestByVersion = new Map([
      ['9007199254740992.999.999', '1'.repeat(64)],
      ['9007199254740993.0.0', '2'.repeat(64)],
      ['9007199254740994.0.0', '3'.repeat(64)],
      ['9007199254740994.0.0-alpha.9007199254740993', '4'.repeat(64)],
      ['9007199254740994.0.0-alpha.9007199254740992', '5'.repeat(64)],
      ['9007199254740994.0.0+build.2', '6'.repeat(64)],
    ]);
    const packageFor = (version: string): AgentManifest => {
      const hex = digestByVersion.get(version);
      if (!hex) throw new Error(`Missing test digest for ${version}`);
      return manifest(version, `sha256:${hex}`);
    };
    const preciseDigest = { sha256: async (content: string) => {
      const version = [...digestByVersion.keys()].find((candidate) => content.includes(`\"version\":\"${candidate}\"`));
      if (!version) throw new Error('Unexpected manifest version');
      return digestByVersion.get(version)!;
    } };

    const coreRegistry = await createAgentRegistry({ idFactory: () => 'installation-core', digest: preciseDigest });
    await coreRegistry.install(packageFor('9007199254740993.0.0'));
    await expect(coreRegistry.install(packageFor('9007199254740992.999.999'))).rejects.toMatchObject({
      code: 'AGENT_REGISTRY_DOWNGRADE_DENIED',
    });
    await expect(coreRegistry.install(packageFor('9007199254740994.0.0'))).resolves.toMatchObject({
      manifest: { version: '9007199254740994.0.0' },
    });

    const prereleaseRegistry = await createAgentRegistry({ idFactory: () => 'installation-pre', digest: preciseDigest });
    await prereleaseRegistry.install(packageFor('9007199254740994.0.0-alpha.9007199254740993'));
    await expect(prereleaseRegistry.install(packageFor('9007199254740994.0.0-alpha.9007199254740992'))).rejects.toMatchObject({
      code: 'AGENT_REGISTRY_DOWNGRADE_DENIED',
    });
    await expect(prereleaseRegistry.install(packageFor('9007199254740994.0.0'))).resolves.toMatchObject({
      manifest: { version: '9007199254740994.0.0' },
    });
    await expect(prereleaseRegistry.install(packageFor('9007199254740994.0.0+build.2'))).rejects.toMatchObject({
      code: 'AGENT_REGISTRY_VERSION_CONFLICT',
    });
  });

  it('rejects non-canonical numeric prerelease identifiers', async () => {
    const registry = await createAgentRegistry({ digest: { sha256: async () => digestHex } });
    await expect(registry.install(manifest('1.0.0-01'))).rejects.toBeInstanceOf(Error);
  });

  it('degrades a denied browser storage getter to a usable memory-only registry', async () => {
    const modes: string[] = [];
    const registry = await createBrowserAgentRegistry({
      storageFactory: () => { throw new Error('storage denied'); },
      onPersistenceModeChange: (mode) => { modes.push(mode); },
      idFactory: () => 'installation-memory-only',
      digest: { sha256: async () => digestHex },
    });

    await expect(registry.install(manifest())).resolves.toMatchObject({ status: 'enabled' });
    await expect(registry.disable(manifest().id)).resolves.toMatchObject({ status: 'disabled' });
    expect(registry.list()).toHaveLength(1);
    expect(modes).toEqual(['memory-only']);
  });

  it('keeps the current mutation when browser persistence fails after startup', async () => {
    const modes: string[] = [];
    const registry = await createBrowserAgentRegistry({
      storageFactory: () => ({
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded'); },
      }),
      onPersistenceModeChange: (mode) => { modes.push(mode); },
      idFactory: () => 'installation-after-storage-failure',
      digest: { sha256: async () => digestHex },
    });

    await expect(registry.install(manifest())).resolves.toMatchObject({
      installationId: 'installation-after-storage-failure',
      status: 'enabled',
    });
    expect(registry.list()).toHaveLength(1);
    expect(modes).toEqual(['persistent', 'memory-only']);
  });
});
