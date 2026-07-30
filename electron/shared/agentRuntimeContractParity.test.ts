import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL } from './agentRuntimeProtocol.js';

describe('Agent Runtime preload contract parity', () => {
  const preloadSource = readFileSync(
    fileURLToPath(new URL('../preload.cts', import.meta.url)),
    'utf8',
  );

  it('keeps the sandbox preload channel aligned with the main-process protocol', () => {
    const match = /const AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL = '([^']+)'/.exec(preloadSource);
    expect(match?.[1]).toBe(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL);
  });

  it('exposes only a getter and never a raw sidecar configuration object', () => {
    expect(preloadSource).toContain('const agentRuntime = Object.freeze({');
    expect(preloadSource).toContain('getSidecarConfig: async');
    expect(preloadSource).not.toContain('__AIOS_SIDECAR_CONFIG__');
  });
});
