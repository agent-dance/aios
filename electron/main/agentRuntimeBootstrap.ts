import {
  cloneAgentRuntimeSidecarConfig,
  type AgentRuntimeSidecarConfig,
} from '../shared/agentRuntimeProtocol.js';

export const AGENT_RUNTIME_BOOTSTRAP_ENV = Object.freeze({
  baseUrl: 'AIOS_DESKTOP_SIDECAR_URL',
  token: 'AIOS_DESKTOP_SIDECAR_TOKEN',
  origin: 'AIOS_DESKTOP_SIDECAR_ORIGIN',
} as const);

type MutableEnvironment = Record<string, string | undefined>;

/**
 * Consumes the launch capability before Electron creates a renderer process.
 * Every key is deleted on success, absence, and validation failure so child
 * processes can never inherit the bearer token through their environment.
 */
export function consumeAgentRuntimeBootstrap(
  environment: MutableEnvironment,
  expectedOrigin: string,
): AgentRuntimeSidecarConfig | undefined {
  const raw = {
    baseUrl: environment[AGENT_RUNTIME_BOOTSTRAP_ENV.baseUrl],
    token: environment[AGENT_RUNTIME_BOOTSTRAP_ENV.token],
    origin: environment[AGENT_RUNTIME_BOOTSTRAP_ENV.origin],
  };

  try {
    const values = Object.values(raw);
    if (values.every((value) => value === undefined)) return undefined;
    if (values.some((value) => value === undefined)) {
      throw new Error('Incomplete Agent Runtime bootstrap environment.');
    }
    return cloneAgentRuntimeSidecarConfig(raw, expectedOrigin);
  } finally {
    delete environment[AGENT_RUNTIME_BOOTSTRAP_ENV.baseUrl];
    delete environment[AGENT_RUNTIME_BOOTSTRAP_ENV.token];
    delete environment[AGENT_RUNTIME_BOOTSTRAP_ENV.origin];
  }
}
