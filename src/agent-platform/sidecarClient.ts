import { validateA2uiSurface } from './a2ui';
import { AGENT_CONTRIBUTIONS, OS_CAPABILITIES } from './agentManifest';
import { validateOsIntent, validateSystemStatusSnapshot } from './intents';
import {
  AIOS_AGENT_PROTOCOL_VERSION,
  type ChatRequest,
  type ChatResponse,
  type GameDecisionRequest,
  type GameDecisionResponse,
  type HealthResponse,
  type OsContextSnapshot,
  type SidecarErrorEnvelope,
  type UsageSummary,
} from './protocol';
import {
  assertArray,
  assertBoolean,
  assertEnum,
  assertExactKeys,
  assertFiniteNumber,
  assertJsonValue,
  assertRecord,
  assertSafeInteger,
  assertString,
  type JsonValue,
  ValidationError,
} from './validation';

export type SidecarClientErrorCode =
  | 'SIDECAR_CONFIG_INVALID'
  | 'SIDECAR_ORIGIN_MISMATCH'
  | 'SIDECAR_ABORTED'
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_NETWORK_ERROR'
  | 'SIDECAR_HTTP_ERROR'
  | 'SIDECAR_PROTOCOL_MISMATCH'
  | 'SIDECAR_RESPONSE_AUTH_FAILED'
  | 'SIDECAR_INVALID_RESPONSE';

export class SidecarClientError extends Error {
  readonly code: SidecarClientErrorCode;
  readonly status?: number;
  readonly remoteCode?: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly cause?: unknown;

  constructor(
    code: SidecarClientErrorCode,
    message: string,
    options: { status?: number; remoteCode?: string; retryable?: boolean; requestId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'SidecarClientError';
    this.code = code;
    this.status = options.status;
    this.remoteCode = options.remoteCode;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.cause = options.cause;
  }
}

export interface SidecarClient {
  health(options?: RequestOptions): Promise<HealthResponse>;
  chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse>;
  decide(request: GameDecisionRequest, options?: RequestOptions): Promise<GameDecisionResponse>;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface SidecarClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly origin: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly getOrigin?: () => string;
  readonly crypto?: Crypto;
  readonly now?: () => number;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AGENT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HEX_NONCE = /^[0-9a-f]{32}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_SIGNATURE_CONTEXT = 'AIOS1-REQUEST';
const RESPONSE_SIGNATURE_CONTEXT = 'AIOS1-RESPONSE';
const RESPONSE_BODY_LIMIT = 4 * 1024 * 1024;
const AUTHENTICATION_WINDOW_MS = 30_000;
const NONCE_CACHE_CAPACITY = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const validateStringList = (value: unknown, path: string, max: number): readonly string[] =>
  Object.freeze(assertArray(value, path, { max, item: (entry, itemPath) => assertString(entry, itemPath, { min: 1, max: 128 }) }));

const validateUniqueStringList = (value: unknown, path: string, max: number): readonly string[] => {
  const result = validateStringList(value, path, max);
  if (new Set(result).size !== result.length) throw new ValidationError(path, 'duplicate value');
  return result;
};

const validateEnabledAgents = (value: unknown, path: string): OsContextSnapshot['enabledAgents'] => {
  let instructionCharacters = 0;
  const agents = Object.freeze(assertArray(value, path, {
    max: 16,
    item: (entry, itemPath) => {
      const agent = assertRecord(entry, itemPath);
      assertExactKeys(agent, ['id', 'name', 'description', 'instructions', 'capabilities', 'contributions'], [], itemPath);
      const instructions = assertString(agent.instructions, `${itemPath}.instructions`, { min: 1, max: 12_000 });
      instructionCharacters += instructions.length;
      const capabilities = Object.freeze(assertArray(agent.capabilities, `${itemPath}.capabilities`, {
        max: OS_CAPABILITIES.length,
        item: (capability, capabilityPath) => assertEnum(capability, OS_CAPABILITIES, capabilityPath),
      }));
      if (new Set(capabilities).size !== capabilities.length) throw new ValidationError(`${itemPath}.capabilities`, 'duplicate capability');
      const contributions = Object.freeze(assertArray(agent.contributions, `${itemPath}.contributions`, {
        max: AGENT_CONTRIBUTIONS.length,
        item: (contribution, contributionPath) => assertEnum(contribution, AGENT_CONTRIBUTIONS, contributionPath),
      }));
      if (new Set(contributions).size !== contributions.length) throw new ValidationError(`${itemPath}.contributions`, 'duplicate contribution');
      if (!contributions.includes('domain-agent')) throw new ValidationError(`${itemPath}.contributions`, 'domain-agent contribution is required');
      return Object.freeze({
        id: assertString(agent.id, `${itemPath}.id`, { min: 3, max: 128, pattern: AGENT_ID }),
        name: assertString(agent.name, `${itemPath}.name`, { min: 1, max: 80 }),
        description: assertString(agent.description, `${itemPath}.description`, { min: 1, max: 500 }),
        instructions,
        capabilities,
        contributions,
      });
    },
  }));
  if (instructionCharacters > 48_000) throw new ValidationError(path, 'total instructions exceed 48000 characters');
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) throw new ValidationError(path, 'duplicate Agent id');
  return agents;
};

export const validateChatRequest = (value: unknown): ChatRequest => {
  const record = assertRecord(value, 'request');
  assertExactKeys(record, ['requestId', 'threadId', 'message', 'context'], ['history'], 'request');
  const context = assertRecord(record.context, 'request.context');
  assertExactKeys(context, ['osRevision'], [
    'locale',
    'activeAppId',
    'theme',
    'installedAppIds',
    'installedAgentIds',
    'systemStatus',
    'runningGameIds',
    'enabledAgents',
    'runningGames',
  ], 'request.context');
  return Object.freeze({
    requestId: assertString(record.requestId, 'request.requestId', { min: 1, max: 128, pattern: REQUEST_ID }),
    threadId: assertString(record.threadId, 'request.threadId', { min: 1, max: 128, pattern: REQUEST_ID }),
    message: assertString(record.message, 'request.message', { min: 1, max: 12_000 }),
    ...(record.history === undefined ? {} : {
      history: (() => {
        const history = Object.freeze(assertArray(record.history, 'request.history', {
          max: 12,
          item: (entry, path) => {
            const historyEntry = assertRecord(entry, path);
            assertExactKeys(historyEntry, ['role', 'content'], [], path);
            if (historyEntry.role !== 'user' && historyEntry.role !== 'assistant') {
              throw new ValidationError(`${path}.role`, 'must be user or assistant');
            }
            return Object.freeze({
              role: historyEntry.role,
              content: assertString(historyEntry.content, `${path}.content`, { min: 1, max: 2_000 }),
            });
          },
        }));
        if (history.reduce((total, entry) => total + entry.content.length, 0) > 12_000) {
          throw new ValidationError('request.history', 'aggregate content exceeds 12000 characters');
        }
        return history;
      })(),
    }),
    context: Object.freeze({
      osRevision: assertSafeInteger(context.osRevision, 'request.context.osRevision', { min: 0 }),
      ...(context.locale === undefined ? {} : { locale: assertString(context.locale, 'request.context.locale', { min: 2, max: 32 }) }),
      ...(context.activeAppId === undefined ? {} : { activeAppId: assertString(context.activeAppId, 'request.context.activeAppId', { min: 1, max: 128 }) }),
      ...(context.theme === undefined ? {} : { theme: assertString(context.theme, 'request.context.theme', { min: 1, max: 64 }) }),
      ...(context.installedAppIds === undefined ? {} : { installedAppIds: validateStringList(context.installedAppIds, 'request.context.installedAppIds', 256) }),
      ...(context.installedAgentIds === undefined ? {} : { installedAgentIds: validateStringList(context.installedAgentIds, 'request.context.installedAgentIds', 128) }),
      ...(context.systemStatus === undefined ? {} : { systemStatus: validateSystemStatusSnapshot(context.systemStatus, 'request.context.systemStatus') }),
      ...(context.runningGameIds === undefined ? {} : { runningGameIds: validateUniqueStringList(context.runningGameIds, 'request.context.runningGameIds', 32) }),
      ...(context.enabledAgents === undefined ? {} : { enabledAgents: validateEnabledAgents(context.enabledAgents, 'request.context.enabledAgents') }),
      ...(context.runningGames === undefined ? {} : {
        runningGames: Object.freeze(assertArray(context.runningGames, 'request.context.runningGames', {
          max: 32,
          item: (entry, path) => {
            const game = assertRecord(entry, path);
            assertExactKeys(game, ['gameId', 'matchId', 'controlledSeatIds'], [], path);
            return Object.freeze({
              gameId: assertString(game.gameId, `${path}.gameId`, { min: 1, max: 128 }),
              matchId: assertString(game.matchId, `${path}.matchId`, { min: 1, max: 128 }),
              controlledSeatIds: validateStringList(game.controlledSeatIds, `${path}.controlledSeatIds`, 32),
            });
          },
        })),
      }),
    }),
  });
};

export const validateGameDecisionRequest = (value: unknown): GameDecisionRequest => {
  const record = assertRecord(value, 'request');
  assertExactKeys(record, ['requestId', 'gameId', 'gameVersion', 'matchId', 'seatId', 'observation', 'legalActions'], [], 'request');
  const observation = assertRecord(record.observation, 'request.observation');
  assertExactKeys(observation, ['revision', 'terminal', 'decision', 'observation'], [], 'request.observation');
  const decision = assertRecord(observation.decision, 'request.observation.decision');
  assertExactKeys(decision, ['mode', 'phase', 'activeSeatIds', 'turnNonce'], [], 'request.observation.decision');
  const seatId = assertString(record.seatId, 'request.seatId', { min: 1, max: 128 });
  const terminal = assertBoolean(observation.terminal, 'request.observation.terminal');
  if (terminal) throw new ValidationError('request.observation.terminal', 'terminal observations do not have Agent decisions');
  const activeSeatIds = validateStringList(decision.activeSeatIds, 'request.observation.decision.activeSeatIds', 32);
  if (activeSeatIds.length === 0 || !activeSeatIds.includes(seatId)) {
    throw new ValidationError('request.observation.decision.activeSeatIds', 'request seat must be active');
  }
  const legalActions = Object.freeze(assertArray(record.legalActions, 'request.legalActions', {
    min: 1,
    max: 20_000,
    item: (entry, path) => {
      const action = assertRecord(entry, path);
      assertExactKeys(action, ['id', 'label', 'action'], [], path);
      return Object.freeze({
        id: assertString(action.id, `${path}.id`, { min: 1, max: 128 }),
        label: assertString(action.label, `${path}.label`, { min: 1, max: 240 }),
        action: assertJsonValue(action.action, `${path}.action`),
      });
    },
  }));
  if (new Set(legalActions.map((action) => action.id)).size !== legalActions.length) {
    throw new ValidationError('request.legalActions', 'duplicate action id');
  }
  return Object.freeze({
    requestId: assertString(record.requestId, 'request.requestId', { min: 1, max: 128, pattern: REQUEST_ID }),
    gameId: assertString(record.gameId, 'request.gameId', { min: 1, max: 128 }),
    gameVersion: assertString(record.gameVersion, 'request.gameVersion', { min: 1, max: 64 }),
    matchId: assertString(record.matchId, 'request.matchId', { min: 1, max: 128 }),
    seatId,
    observation: Object.freeze({
      revision: assertSafeInteger(observation.revision, 'request.observation.revision', { min: 0 }),
      terminal,
      decision: Object.freeze({
        mode: assertEnum(decision.mode, ['sequential', 'simultaneous'], 'request.observation.decision.mode'),
        phase: assertString(decision.phase, 'request.observation.decision.phase', { min: 1, max: 128 }),
        activeSeatIds,
        turnNonce: assertString(decision.turnNonce, 'request.observation.decision.turnNonce', { min: 1, max: 256 }),
      }),
      observation: assertJsonValue(observation.observation, 'request.observation.observation'),
    }),
    legalActions,
  });
};

const validateBaseUrl = (raw: string): string => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar URL is invalid.'); }
  if (url.protocol !== 'http:') {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar URL must use the configured loopback HTTP transport.');
  }
  if (url.hostname !== '127.0.0.1') {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Browser sidecar transport must use the CSP-authorized IPv4 loopback host 127.0.0.1.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar URL cannot contain credentials, query, or fragment.');
  }
  if (url.pathname !== '/') throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar URL must not contain a path.');
  return url.href.replace(/\/$/, '');
};

const canonicalSidecarAuthority = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  return `http://127.0.0.1:${url.port || '80'}`;
};

const validateUsage = (value: unknown, path: string): UsageSummary => {
  const record = assertRecord(value, path);
  assertExactKeys(record, ['inputTokens', 'outputTokens', 'cachedInputTokens', 'estimatedCostMilli'], [], path);
  return Object.freeze({
    inputTokens: assertSafeInteger(record.inputTokens, `${path}.inputTokens`, { min: 0 }),
    outputTokens: assertSafeInteger(record.outputTokens, `${path}.outputTokens`, { min: 0 }),
    cachedInputTokens: assertSafeInteger(record.cachedInputTokens, `${path}.cachedInputTokens`, { min: 0 }),
    estimatedCostMilli: assertFiniteNumber(record.estimatedCostMilli, `${path}.estimatedCostMilli`),
  });
};

export const validateHealthResponse = (value: unknown): HealthResponse => {
  const record = assertRecord(value, 'response');
  assertExactKeys(record, ['protocolVersion', 'status', 'agent', 'limits', 'checks'], [], 'response');
  if (record.protocolVersion !== AIOS_AGENT_PROTOCOL_VERSION) throw new ValidationError('response.protocolVersion', 'protocol mismatch');
  const agent = assertRecord(record.agent, 'response.agent');
  assertExactKeys(agent, ['driver', 'authMode', 'profileIsolated'], [], 'response.agent');
  if (agent.driver !== 'codex' || agent.authMode !== 'linked' || agent.profileIsolated !== true) {
    throw new ValidationError('response.agent', 'unsupported or insecure agent configuration');
  }
  const limits = assertRecord(record.limits, 'response.limits');
  assertExactKeys(limits, ['maxBodyBytes', 'maxConcurrentRuns'], [], 'response.limits');
  return Object.freeze({
    protocolVersion: AIOS_AGENT_PROTOCOL_VERSION,
    status: assertEnum(record.status, ['ready', 'not_ready'], 'response.status'),
    agent: Object.freeze({ driver: 'codex', authMode: 'linked', profileIsolated: true }),
    limits: Object.freeze({
      maxBodyBytes: assertSafeInteger(limits.maxBodyBytes, 'response.limits.maxBodyBytes', { min: 1 }),
      maxConcurrentRuns: assertSafeInteger(limits.maxConcurrentRuns, 'response.limits.maxConcurrentRuns', { min: 1 }),
    }),
    checks: Object.freeze(assertArray(record.checks, 'response.checks', {
      max: 32,
      item: (entry, path) => {
        const check = assertRecord(entry, path);
        assertExactKeys(check, ['code', 'status', 'message'], [], path);
        return Object.freeze({
          code: assertString(check.code, `${path}.code`, { min: 1, max: 64 }),
          status: assertEnum(check.status, ['pass', 'warn', 'fail'], `${path}.status`),
          message: assertString(check.message, `${path}.message`, { max: 500 }),
        });
      },
    })),
  });
};

export const validateChatResponse = (value: unknown): ChatResponse => {
  const record = assertRecord(value, 'response');
  assertExactKeys(record, ['requestId', 'runId', 'message', 'mood', 'intents'], ['activeAgentId', 'surface', 'usage'], 'response');
  const intents = Object.freeze(assertArray(record.intents, 'response.intents', {
    max: 1,
    item: (entry, path) => validateOsIntent(entry, path),
  }));
  const intentIds = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.id)) throw new ValidationError('response.intents', `duplicate intent id ${intent.id}`);
    intentIds.add(intent.id);
  }
  return Object.freeze({
    requestId: assertString(record.requestId, 'response.requestId', { min: 1, max: 128, pattern: REQUEST_ID }),
    runId: assertString(record.runId, 'response.runId', { min: 1, max: 128, pattern: REQUEST_ID }),
    message: assertString(record.message, 'response.message', { min: 1, max: 12_000 }),
    mood: assertEnum(record.mood, ['neutral', 'helpful', 'focused', 'celebratory', 'concerned'], 'response.mood'),
    ...(record.activeAgentId === undefined ? {} : {
      activeAgentId: assertString(record.activeAgentId, 'response.activeAgentId', { min: 3, max: 128, pattern: REQUEST_ID }),
    }),
    intents,
    ...(record.surface === undefined ? {} : { surface: validateA2uiSurface(record.surface, { validIntentIds: intentIds, path: 'response.surface' }) }),
    ...(record.usage === undefined ? {} : { usage: validateUsage(record.usage, 'response.usage') }),
  });
};

export const validateGameDecisionResponse = (value: unknown): GameDecisionResponse => {
  const record = assertRecord(value, 'response');
  assertExactKeys(record, ['requestId', 'runId', 'actionId'], ['usage'], 'response');
  return Object.freeze({
    requestId: assertString(record.requestId, 'response.requestId', { min: 1, max: 128, pattern: REQUEST_ID }),
    runId: assertString(record.runId, 'response.runId', { min: 1, max: 128, pattern: REQUEST_ID }),
    actionId: assertString(record.actionId, 'response.actionId', { min: 1, max: 128 }),
    ...(record.usage === undefined ? {} : { usage: validateUsage(record.usage, 'response.usage') }),
  });
};

const validateErrorEnvelope = (value: unknown): SidecarErrorEnvelope | undefined => {
  try {
    const root = assertRecord(value, 'response');
    assertExactKeys(root, ['error'], [], 'response');
    const error = assertRecord(root.error, 'response.error');
    assertExactKeys(error, ['code', 'message', 'requestId', 'retryable'], [], 'response.error');
    return {
      error: {
        code: assertString(error.code, 'response.error.code', { min: 1, max: 64 }),
        message: assertString(error.message, 'response.error.message', { min: 1, max: 500 }),
        requestId: assertString(error.requestId, 'response.error.requestId', { min: 1, max: 128 }),
        retryable: assertBoolean(error.retryable, 'response.error.retryable'),
      },
    };
  } catch {
    return undefined;
  }
};

const linkedSignal = (source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } => {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(source?.reason);
  source?.addEventListener('abort', onAbort, { once: true });
  if (source?.aborted) controller.abort(source.reason);
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      source?.removeEventListener('abort', onAbort);
    },
  };
};

const bytesToHex = (value: Uint8Array): string => {
  let result = '';
  for (const byte of value) result += byte.toString(16).padStart(2, '0');
  return result;
};

const hexToBytes = (value: string): Uint8Array => {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
};

const asArrayBuffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;

const sha256Hex = async (cryptoProvider: Crypto, value: Uint8Array): Promise<string> =>
  bytesToHex(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', asArrayBuffer(value))));

const importHmacKey = (cryptoProvider: Crypto, secret: string): Promise<CryptoKey> =>
  cryptoProvider.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const hmacHex = async (cryptoProvider: Crypto, key: CryptoKey, canonical: string): Promise<string> =>
  bytesToHex(new Uint8Array(await cryptoProvider.subtle.sign('HMAC', key, encoder.encode(canonical))));

const verifyHmac = (cryptoProvider: Crypto, key: CryptoKey, canonical: string, signature: string): Promise<boolean> =>
  cryptoProvider.subtle.verify('HMAC', key, asArrayBuffer(hexToBytes(signature)), encoder.encode(canonical));

export const canonicalSidecarRequest = (
  method: string,
  authority: string,
  path: string,
  origin: string,
  protocolVersion: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string => [REQUEST_SIGNATURE_CONTEXT, method, authority, path, origin, protocolVersion, timestamp, nonce, bodyHash].join('\n');

export const canonicalSidecarResponse = (
  nonce: string,
  requestId: string,
  status: number,
  bodyHash: string,
  protocolVersion: string,
): string => [RESPONSE_SIGNATURE_CONTEXT, nonce, requestId, String(status), bodyHash, protocolVersion].join('\n');

const readBoundedResponse = async (response: Response): Promise<Uint8Array> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > RESPONSE_BODY_LIMIT) {
      throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar response exceeds the accepted size.', { status: response.status });
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_BODY_LIMIT) {
        await reader.cancel('response body limit exceeded');
        throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar response exceeds the accepted size.', { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const parseJson = (response: Response, body: Uint8Array): unknown => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar response is not JSON.', { status: response.status });
  }
  try { return JSON.parse(decoder.decode(body)) as unknown; } catch (error) {
    throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar returned malformed JSON.', { status: response.status, cause: error });
  }
};

export const createSidecarClient = (config: SidecarClientConfig): SidecarClient => {
  const baseUrl = validateBaseUrl(config.baseUrl);
  const sidecarAuthority = canonicalSidecarAuthority(baseUrl);
  let token: string;
  try { token = assertString(config.token, 'config.token', { min: 32, max: 512 }); } catch (error) {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar shared secret is invalid.', { cause: error });
  }
  const origin = (() => {
    try { return new URL(config.origin).origin; } catch { throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Configured browser origin is invalid.'); }
  })();
  if (origin !== config.origin) throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Configured origin must be an exact origin without a path.');
  const fetcher = config.fetch ?? globalThis.fetch;
  if (!fetcher) throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Fetch is unavailable.');
  const defaultTimeout = config.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(defaultTimeout) || defaultTimeout < 100 || defaultTimeout > 300_000) {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Timeout must be between 100 and 300000ms.');
  }
  const getOrigin = config.getOrigin ?? (() => globalThis.location?.origin ?? origin);
  const cryptoProvider = config.crypto ?? globalThis.crypto;
  if (!cryptoProvider?.subtle || typeof cryptoProvider.getRandomValues !== 'function') {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Web Crypto is unavailable for authenticated sidecar transport.');
  }
  const tokenByteLength = encoder.encode(token).byteLength;
  if (tokenByteLength < 32 || tokenByteLength > 512) {
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Sidecar shared secret must contain between 32 and 512 UTF-8 bytes.');
  }
  const hmacKey = importHmacKey(cryptoProvider, token);
  const now = config.now ?? Date.now;
  const recentNonces = new Map<string, number>();

  const newNonce = (): string => {
    const current = now();
    for (const [candidate, createdAt] of recentNonces) {
      if (createdAt < current - AUTHENTICATION_WINDOW_MS) recentNonces.delete(candidate);
    }
    if (recentNonces.size >= NONCE_CACHE_CAPACITY) {
      throw new SidecarClientError('SIDECAR_NETWORK_ERROR', 'Sidecar authentication nonce capacity is temporarily exhausted.', { retryable: true });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = bytesToHex(cryptoProvider.getRandomValues(new Uint8Array(16)));
      if (!recentNonces.has(value)) {
        recentNonces.set(value, current);
        return value;
      }
    }
    throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Unable to generate a unique sidecar request nonce.');
  };

  const request = async <T>(path: string, init: RequestInit, validate: (value: unknown) => T, options: RequestOptions = {}): Promise<T> => {
    if (getOrigin() !== origin) throw new SidecarClientError('SIDECAR_ORIGIN_MISMATCH', 'Browser origin does not match the sidecar capability binding.');
    const timeoutMs = options.timeoutMs ?? defaultTimeout;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Request timeout must be between 100 and 300000ms.');
    }
    const linked = linkedSignal(options.signal, timeoutMs);
    try {
      const method = (init.method ?? 'GET').toUpperCase();
      const bodyBytes = init.body === undefined || init.body === null ? new Uint8Array() : encoder.encode(String(init.body));
      const bodyHash = await sha256Hex(cryptoProvider, bodyBytes);
      const timestamp = String(Math.trunc(now()));
      if (!/^\d{1,16}$/.test(timestamp)) throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'System time cannot be represented for sidecar authentication.');
      const nonce = newNonce();
      const key = await hmacKey;
      const signature = await hmacHex(
        cryptoProvider,
        key,
        canonicalSidecarRequest(method, sidecarAuthority, path, origin, AIOS_AGENT_PROTOCOL_VERSION, timestamp, nonce, bodyHash),
      );
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}${path}`, {
          ...init,
          mode: 'cors',
          cache: 'no-store',
          redirect: 'error',
          credentials: 'omit',
          headers: {
            'X-AIOS-Protocol-Version': AIOS_AGENT_PROTOCOL_VERSION,
            'X-AIOS-Timestamp': timestamp,
            'X-AIOS-Nonce': nonce,
            'X-AIOS-Content-SHA256': bodyHash,
            'X-AIOS-Signature': signature,
            Accept: 'application/json',
            ...init.headers,
          },
          signal: linked.signal,
        });
      } catch (error) {
        if (linked.timedOut()) throw new SidecarClientError('SIDECAR_TIMEOUT', 'Sidecar request timed out.', { retryable: true, cause: error });
        if (options.signal?.aborted) throw new SidecarClientError('SIDECAR_ABORTED', 'Sidecar request was cancelled.', { cause: error });
        throw new SidecarClientError('SIDECAR_NETWORK_ERROR', 'Sidecar could not be reached.', { retryable: true, cause: error });
      }
      const responseVersion = response.headers.get('x-aios-protocol-version') ?? '';
      const responseNonce = response.headers.get('x-aios-request-nonce') ?? '';
      const responseRequestId = response.headers.get('x-request-id') ?? '';
      const responseBodyHash = response.headers.get('x-aios-content-sha256') ?? '';
      const responseSignature = response.headers.get('x-aios-signature') ?? '';
      if (
        responseVersion.length > 32 || responseNonce !== nonce || !REQUEST_ID.test(responseRequestId) ||
        !HEX_SHA256.test(responseBodyHash) || !HEX_SHA256.test(responseSignature)
      ) {
        throw new SidecarClientError('SIDECAR_RESPONSE_AUTH_FAILED', 'Sidecar response authentication metadata is invalid.', { status: response.status });
      }
      let responseBody: Uint8Array;
      try {
        responseBody = await readBoundedResponse(response);
      } catch (error) {
        if (error instanceof SidecarClientError) throw error;
        if (linked.timedOut()) throw new SidecarClientError('SIDECAR_TIMEOUT', 'Sidecar response timed out.', { retryable: true, cause: error });
        if (options.signal?.aborted) throw new SidecarClientError('SIDECAR_ABORTED', 'Sidecar response was cancelled.', { cause: error });
        throw new SidecarClientError('SIDECAR_NETWORK_ERROR', 'Sidecar response could not be read.', { retryable: true, cause: error });
      }
      const actualResponseBodyHash = await sha256Hex(cryptoProvider, responseBody);
      if (actualResponseBodyHash !== responseBodyHash) {
        throw new SidecarClientError('SIDECAR_RESPONSE_AUTH_FAILED', 'Sidecar response body authentication failed.', { status: response.status });
      }
      const responseAuthenticated = await verifyHmac(
        cryptoProvider,
        key,
        canonicalSidecarResponse(nonce, responseRequestId, response.status, responseBodyHash, responseVersion),
        responseSignature,
      );
      if (!responseAuthenticated) {
        throw new SidecarClientError('SIDECAR_RESPONSE_AUTH_FAILED', 'Sidecar response signature is invalid.', { status: response.status });
      }
      if (linked.timedOut()) throw new SidecarClientError('SIDECAR_TIMEOUT', 'Sidecar response timed out.', { retryable: true });
      if (options.signal?.aborted) throw new SidecarClientError('SIDECAR_ABORTED', 'Sidecar response was cancelled.');
      if (responseVersion !== AIOS_AGENT_PROTOCOL_VERSION) {
        throw new SidecarClientError('SIDECAR_PROTOCOL_MISMATCH', 'Sidecar protocol version does not match.', { status: response.status });
      }
      const body = parseJson(response, responseBody);
      if (!response.ok) {
        const envelope = validateErrorEnvelope(body);
        throw new SidecarClientError('SIDECAR_HTTP_ERROR', envelope?.error.message ?? 'Sidecar rejected the request.', {
          status: response.status,
          remoteCode: envelope?.error.code,
          retryable: envelope?.error.retryable,
          requestId: envelope?.error.requestId,
        });
      }
      try { return validate(body); } catch (error) {
        if (error instanceof SidecarClientError) throw error;
        throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar returned a response outside the negotiated schema.', { status: response.status, cause: error });
      }
    } finally {
      linked.dispose();
    }
  };

  const post = <T>(path: string, body: unknown, validate: (value: unknown) => T, options?: RequestOptions): Promise<T> => {
    const json = JSON.stringify(assertJsonValue(body, 'request'));
    return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }, validate, options);
  };

  return Object.freeze({
    health: (options?: RequestOptions) => request('/v1/health', { method: 'GET' }, validateHealthResponse, options),
    chat: async (candidate: ChatRequest, options?: RequestOptions) => {
      let chatRequest: ChatRequest;
      try { chatRequest = validateChatRequest(candidate); } catch (error) {
        throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Chat request is outside the protocol schema.', { cause: error });
      }
      const response = await post('/v1/chat', chatRequest as unknown as JsonValue, validateChatResponse, options);
      if (response.requestId !== chatRequest.requestId) throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar response request ID does not match.');
      if (
        response.activeAgentId !== undefined &&
        !chatRequest.context.enabledAgents?.some((agent) => agent.id === response.activeAgentId)
      ) {
        throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar selected an Agent outside the enabled domain context.');
      }
      return response;
    },
    decide: async (candidate: GameDecisionRequest, options?: RequestOptions) => {
      let decisionRequest: GameDecisionRequest;
      try { decisionRequest = validateGameDecisionRequest(candidate); } catch (error) {
        throw new SidecarClientError('SIDECAR_CONFIG_INVALID', 'Game decision request is outside the protocol schema.', { cause: error });
      }
      const response = await post('/v1/game/decide', decisionRequest as unknown as JsonValue, validateGameDecisionResponse, options);
      if (response.requestId !== decisionRequest.requestId) throw new SidecarClientError('SIDECAR_INVALID_RESPONSE', 'Sidecar response request ID does not match.');
      return response;
    },
  });
};
