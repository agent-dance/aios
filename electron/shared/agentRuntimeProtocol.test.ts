import { describe, expect, it } from 'vitest';
import { cloneAgentRuntimeSidecarConfig } from './agentRuntimeProtocol.js';

const TOKEN = 's'.repeat(32);

describe('Agent Runtime sidecar protocol', () => {
  it('clones only an exact loopback capability bound to the expected origin', () => {
    const input = {
      baseUrl: 'http://127.0.0.1:4317',
      token: TOKEN,
      origin: 'app://alsniper',
    };
    const clone = cloneAgentRuntimeSidecarConfig(input, 'app://alsniper');
    expect(clone).toEqual(input);
    expect(clone).not.toBe(input);
    expect(Object.isFrozen(clone)).toBe(true);
  });

  it.each([
    { baseUrl: 'http://localhost:4317', token: TOKEN, origin: 'app://alsniper' },
    { baseUrl: 'https://127.0.0.1:4317', token: TOKEN, origin: 'app://alsniper' },
    { baseUrl: 'http://127.0.0.1:4317/', token: TOKEN, origin: 'app://alsniper' },
    { baseUrl: 'http://127.0.0.1:4317/path', token: TOKEN, origin: 'app://alsniper' },
    { baseUrl: 'http://127.0.0.1:4317', token: 'short', origin: 'app://alsniper' },
    { baseUrl: 'http://127.0.0.1:4317', token: '界'.repeat(171), origin: 'app://alsniper' },
    { baseUrl: 'http://127.0.0.1:4317', token: TOKEN, origin: 'app://other' },
    { baseUrl: 'http://127.0.0.1:4317', token: TOKEN, origin: 'app://alsniper', extra: true },
  ])('rejects malformed or overprivileged configuration %#', (input) => {
    expect(() => cloneAgentRuntimeSidecarConfig(input, 'app://alsniper')).toThrow('Invalid Agent Runtime');
  });
});
