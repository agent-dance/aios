export const AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL = 'alsniper-desktop:agent-runtime:get-sidecar-config' as const;

export interface AgentRuntimeSidecarConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly origin: string;
}

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactLoopbackBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return (
      value === parsed.origin
      && parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && parsed.username === ''
      && parsed.password === ''
      && Number.isInteger(port)
      && port >= 1_024
      && port <= 65_535
    );
  } catch {
    return false;
  }
}

function isBoundedToken(value: string): boolean {
  const byteLength = encoder.encode(value).byteLength;
  return (
    byteLength >= MIN_TOKEN_LENGTH
    && byteLength <= MAX_TOKEN_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function cloneAgentRuntimeSidecarConfig(
  value: unknown,
  expectedOrigin: string,
): AgentRuntimeSidecarConfig {
  if (!isRecord(value)) throw new TypeError('Invalid Agent Runtime sidecar configuration.');
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || !Object.hasOwn(value, 'baseUrl')
    || !Object.hasOwn(value, 'token')
    || !Object.hasOwn(value, 'origin')
    || typeof value.baseUrl !== 'string'
    || typeof value.token !== 'string'
    || typeof value.origin !== 'string'
    || !isExactLoopbackBaseUrl(value.baseUrl)
    || !isBoundedToken(value.token)
    || value.origin !== expectedOrigin
  ) {
    throw new TypeError('Invalid Agent Runtime sidecar configuration.');
  }

  return Object.freeze({
    baseUrl: value.baseUrl,
    token: value.token,
    origin: value.origin,
  });
}
