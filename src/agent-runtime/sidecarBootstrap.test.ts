import { describe, expect, it, vi } from 'vitest';
import { resolveAgentRuntimeSidecarConfig, type AgentRuntimeHostWindow } from './sidecarBootstrap';

const TOKEN = 'v'.repeat(32);

function host(
  bridge: unknown,
  location: Partial<Location> = {
    href: 'app://alsniper/index.html',
    protocol: 'app:',
    hostname: 'alsniper',
    port: '',
    origin: 'null',
  },
): AgentRuntimeHostWindow {
  return {
    location,
    alsniperDesktop: { agentRuntime: bridge },
  } as unknown as AgentRuntimeHostWindow;
}

describe('renderer Agent Runtime bootstrap', () => {
  it('gets a fresh validated in-memory copy through the narrow preload bridge', async () => {
    const getSidecarConfig = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:4317',
      token: TOKEN,
      origin: 'app://alsniper',
    }));
    const first = await resolveAgentRuntimeSidecarConfig(host({ getSidecarConfig }));
    const second = await resolveAgentRuntimeSidecarConfig(host({ getSidecarConfig }));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(getSidecarConfig).toHaveBeenCalledTimes(2);
  });

  it('rejects a forged preload response not bound to the actual shell origin', async () => {
    await expect(resolveAgentRuntimeSidecarConfig(host({
      getSidecarConfig: async () => ({
        baseUrl: 'http://127.0.0.1:4317',
        token: TOKEN,
        origin: 'https://evil.example',
      }),
    }))).rejects.toThrow('Invalid Agent Runtime');
  });

  it('uses Vite values only behind an explicit development fallback', async () => {
    const developmentWindow = host({ getSidecarConfig: async () => undefined }, {
      href: 'http://127.0.0.1:5173/',
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '5173',
      origin: 'http://127.0.0.1:5173',
    });
    const values = { baseUrl: 'http://127.0.0.1:4317', token: TOKEN };
    await expect(resolveAgentRuntimeSidecarConfig(developmentWindow, {
      enabled: false,
      ...values,
    })).resolves.toBeUndefined();
    await expect(resolveAgentRuntimeSidecarConfig(developmentWindow, {
      enabled: true,
      ...values,
    })).resolves.toEqual({ ...values, origin: 'http://127.0.0.1:5173' });
  });
});
