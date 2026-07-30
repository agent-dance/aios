import {
  cloneAgentRuntimeSidecarConfig,
  type AgentRuntimeSidecarConfig,
} from '../../electron/shared/agentRuntimeProtocol';

interface AgentRuntimeBridge {
  readonly getSidecarConfig: () => Promise<unknown>;
}

export type AgentRuntimeHostWindow = Window & {
  readonly alsniperDesktop?: {
    readonly agentRuntime?: unknown;
  };
};

export interface DevelopmentSidecarFallback {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectedOrigin(hostWindow: Window): string {
  try {
    const currentUrl = new URL(hostWindow.location.href);
    if (
      currentUrl.protocol === 'app:'
      && currentUrl.hostname === 'alsniper'
      && currentUrl.username === ''
      && currentUrl.password === ''
      && currentUrl.port === ''
    ) return 'app://alsniper';
  } catch {
    // The value remains fail-closed: it cannot match a valid bootstrap origin.
  }
  return hostWindow.location.origin;
}

function resolveBridge(hostWindow: AgentRuntimeHostWindow): AgentRuntimeBridge | null {
  const candidate = hostWindow.alsniperDesktop?.agentRuntime;
  if (!isRecord(candidate) || typeof candidate.getSidecarConfig !== 'function') return null;
  return Object.freeze({
    getSidecarConfig: candidate.getSidecarConfig.bind(candidate) as () => Promise<unknown>,
  });
}

/**
 * Obtains an in-memory copy from the sandbox preload. Production never reads
 * Vite variables; the optional fallback exists only for a live dev server.
 */
export async function resolveAgentRuntimeSidecarConfig(
  hostWindow: AgentRuntimeHostWindow,
  developmentFallback?: DevelopmentSidecarFallback,
): Promise<AgentRuntimeSidecarConfig | undefined> {
  const origin = expectedOrigin(hostWindow);
  const bridge = resolveBridge(hostWindow);
  if (bridge !== null) {
    const value = await bridge.getSidecarConfig();
    if (value !== undefined) return cloneAgentRuntimeSidecarConfig(value, origin);
  }

  if (
    developmentFallback?.enabled !== true
    || developmentFallback.baseUrl === undefined
    || developmentFallback.token === undefined
  ) return undefined;

  return cloneAgentRuntimeSidecarConfig({
    baseUrl: developmentFallback.baseUrl,
    token: developmentFallback.token,
    origin,
  }, origin);
}
