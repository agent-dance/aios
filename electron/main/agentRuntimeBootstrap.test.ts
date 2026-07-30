import { describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_BOOTSTRAP_ENV,
  consumeAgentRuntimeBootstrap,
} from './agentRuntimeBootstrap.js';

const TOKEN = 't'.repeat(32);

function populatedEnvironment(): Record<string, string | undefined> {
  return {
    unrelated: 'preserved',
    [AGENT_RUNTIME_BOOTSTRAP_ENV.baseUrl]: 'http://127.0.0.1:4317',
    [AGENT_RUNTIME_BOOTSTRAP_ENV.token]: TOKEN,
    [AGENT_RUNTIME_BOOTSTRAP_ENV.origin]: 'app://alsniper',
  };
}

describe('Agent Runtime bootstrap environment', () => {
  it('consumes a complete capability and scrubs every sensitive key', () => {
    const environment = populatedEnvironment();
    expect(consumeAgentRuntimeBootstrap(environment, 'app://alsniper')).toEqual({
      baseUrl: 'http://127.0.0.1:4317',
      token: TOKEN,
      origin: 'app://alsniper',
    });
    expect(environment).toEqual({ unrelated: 'preserved' });
  });

  it('returns undefined when the launcher supplied no capability', () => {
    const environment = { unrelated: 'preserved' };
    expect(consumeAgentRuntimeBootstrap(environment, 'app://alsniper')).toBeUndefined();
    expect(environment).toEqual({ unrelated: 'preserved' });
  });

  it.each([
    { missing: AGENT_RUNTIME_BOOTSTRAP_ENV.baseUrl },
    { missing: AGENT_RUNTIME_BOOTSTRAP_ENV.token },
    { missing: AGENT_RUNTIME_BOOTSTRAP_ENV.origin },
  ])('fails closed and still scrubs an incomplete capability: $missing', ({ missing }) => {
    const environment = populatedEnvironment();
    delete environment[missing];
    expect(() => consumeAgentRuntimeBootstrap(environment, 'app://alsniper')).toThrow('Incomplete');
    expect(environment).toEqual({ unrelated: 'preserved' });
  });

  it('rejects an origin not bound to the selected shell and still scrubs secrets', () => {
    const environment = populatedEnvironment();
    environment[AGENT_RUNTIME_BOOTSTRAP_ENV.origin] = 'http://127.0.0.1:5173';
    expect(() => consumeAgentRuntimeBootstrap(environment, 'app://alsniper')).toThrow('Invalid Agent Runtime');
    expect(environment).toEqual({ unrelated: 'preserved' });
  });
});
