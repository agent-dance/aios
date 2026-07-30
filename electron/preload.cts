const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Phase = 'idle' | 'loading' | 'ready' | 'failed';
type ErrorCode = 'NAVIGATION_BLOCKED' | 'NETWORK_ERROR' | 'CERTIFICATE_ERROR' | 'VIEW_UNAVAILABLE' | 'RENDERER_CRASHED';

interface State {
  readonly phase: Phase;
  readonly visible: boolean;
  readonly canGoBack: boolean;
  readonly errorCode?: ErrorCode;
}

const CHANNELS = Object.freeze({
  mount: 'alsniper-desktop:wechat:mount',
  setBounds: 'alsniper-desktop:wechat:set-bounds',
  setVisible: 'alsniper-desktop:wechat:set-visible',
  focus: 'alsniper-desktop:wechat:focus',
  reload: 'alsniper-desktop:wechat:reload',
  goBack: 'alsniper-desktop:wechat:go-back',
  unmount: 'alsniper-desktop:wechat:unmount',
  getState: 'alsniper-desktop:wechat:get-state',
  stateChanged: 'alsniper-desktop:wechat:state-changed',
});

const APPLICATION_CONTROL_CHANNELS = Object.freeze({
  listCapabilities: 'alsniper-desktop:application-control:list-capabilities',
  execute: 'alsniper-desktop:application-control:execute',
  getReceipt: 'alsniper-desktop:application-control:get-receipt',
});

const AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL = 'alsniper-desktop:agent-runtime:get-sidecar-config';

const APPLICATION_EFFECT_STATUSES = new Set<unknown>(['committed', 'rejected', 'failed', 'unknown', 'noop']);
const APPLICATION_RISK_LEVELS = new Set<unknown>(['R0', 'R1', 'R2', 'R3', 'R4']);
const APPLICATION_ERROR_CODES = new Set<unknown>([
  'ADAPTER_UNAVAILABLE',
  'ACTION_UNAVAILABLE',
  'APPROVAL_DENIED',
  'APPROVAL_UNAVAILABLE',
  'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_ARGUMENT',
  'JOURNAL_UNAVAILABLE',
  'PRECONDITION_FAILED',
  'RECONCILIATION_FAILED',
  'REPLAY_REJECTED',
]);

const PHASES = new Set<unknown>(['idle', 'loading', 'ready', 'failed']);
const ERROR_CODES = new Set<unknown>([
  'NAVIGATION_BLOCKED',
  'NETWORK_ERROR',
  'CERTIFICATE_ERROR',
  'VIEW_UNAVAILABLE',
  'RENDERER_CRASHED',
]);
const MAX_BOUND_COMPONENT = 32_768;
const MAX_APPLICATION_ARGUMENT_BYTES = 65_536;
const MAX_APPLICATION_JSON_DEPTH = 20;
const MAX_APPLICATION_ARRAY_ITEMS = 512;
const MAX_APPLICATION_OBJECT_PROPERTIES = 256;
const MAX_APPLICATION_STRING_LENGTH = 32_768;
const MIN_AGENT_RUNTIME_TOKEN_LENGTH = 32;
const MAX_AGENT_RUNTIME_TOKEN_LENGTH = 512;
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], allowed = required): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function cloneAgentRuntimeSidecarConfig(value: unknown): Readonly<{
  baseUrl: string;
  token: string;
  origin: string;
}> {
  const tokenByteLength = typeof value === 'object' && value !== null && 'token' in value && typeof value.token === 'string'
    ? textEncoder.encode(value.token).byteLength
    : 0;
  if (
    !isRecord(value)
    || !exactKeys(value, ['baseUrl', 'token', 'origin'])
    || typeof value.baseUrl !== 'string'
    || typeof value.token !== 'string'
    || typeof value.origin !== 'string'
    || tokenByteLength < MIN_AGENT_RUNTIME_TOKEN_LENGTH
    || tokenByteLength > MAX_AGENT_RUNTIME_TOKEN_LENGTH
    || value.token.trim() !== value.token
    || /[\u0000-\u001f\u007f]/u.test(value.token)
  ) throw new TypeError('Invalid Agent Runtime sidecar configuration.');

  let baseUrl: URL;
  try {
    baseUrl = new URL(value.baseUrl);
  } catch {
    throw new TypeError('Invalid Agent Runtime sidecar configuration.');
  }
  const port = Number(baseUrl.port);
  const validOrigin = value.origin === 'app://alsniper' || (() => {
    try {
      const origin = new URL(value.origin);
      return (
        value.origin === origin.origin
        && origin.protocol === 'http:'
        && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '[::1]')
        && origin.username === ''
        && origin.password === ''
        && Number.isInteger(Number(origin.port))
        && Number(origin.port) >= 1_024
        && Number(origin.port) <= 65_535
      );
    } catch {
      return false;
    }
  })();
  if (
    value.baseUrl !== baseUrl.origin
    || baseUrl.protocol !== 'http:'
    || baseUrl.hostname !== '127.0.0.1'
    || baseUrl.username !== ''
    || baseUrl.password !== ''
    || !Number.isInteger(port)
    || port < 1_024
    || port > 65_535
    || !validOrigin
  ) throw new TypeError('Invalid Agent Runtime sidecar configuration.');

  return Object.freeze({ baseUrl: value.baseUrl, token: value.token, origin: value.origin });
}

function cloneBounds(value: unknown): Bounds {
  if (!isRecord(value) || !exactKeys(value, ['x', 'y', 'width', 'height'])) {
    throw new TypeError('Invalid WeChat bounds.');
  }

  const values = [value.x, value.y, value.width, value.height];
  if (
    values.some((item) => typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item))
    || (value.x as number) < 0
    || (value.y as number) < 0
    || (value.width as number) < 1
    || (value.height as number) < 1
    || values.some((item) => (item as number) > MAX_BOUND_COMPONENT)
  ) {
    throw new TypeError('Invalid WeChat bounds.');
  }

  return Object.freeze({
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  });
}

function cloneState(value: unknown): State {
  if (
    !isRecord(value)
    || !exactKeys(value, ['phase', 'visible', 'canGoBack'], ['phase', 'visible', 'canGoBack', 'errorCode'])
    || !PHASES.has(value.phase)
    || typeof value.visible !== 'boolean'
    || typeof value.canGoBack !== 'boolean'
    || (value.errorCode !== undefined && !ERROR_CODES.has(value.errorCode))
    || (value.phase === 'failed') !== (value.errorCode !== undefined)
  ) {
    throw new TypeError('Invalid WeChat state.');
  }

  return Object.freeze({
    phase: value.phase as Phase,
    visible: value.visible,
    canGoBack: value.canGoBack,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as ErrorCode }),
  });
}

function cloneApplicationJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_APPLICATION_JSON_DEPTH) throw new TypeError('Application action arguments are too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_APPLICATION_STRING_LENGTH) throw new TypeError('Application action argument string is too long.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Application action arguments contain a non-finite number.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_APPLICATION_ARRAY_ITEMS) throw new TypeError('Application action argument array is too large.');
    return Object.freeze(value.map((entry) => cloneApplicationJson(entry, depth + 1)));
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_APPLICATION_OBJECT_PROPERTIES) {
    throw new TypeError('Application action argument must be a bounded JSON object.');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TypeError('Application action argument contains an invalid key.');
    }
    result[key] = cloneApplicationJson(entry, depth + 1);
  }
  return Object.freeze(result);
}

function cloneApplicationPrincipal(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'instanceId', 'packageId', 'userId']) || value.kind !== 'agent') {
    throw new TypeError('Invalid application-control principal provenance.');
  }
  const result = {
    kind: 'agent',
    instanceId: value.instanceId,
    packageId: value.packageId,
    userId: value.userId,
  };
  if (Object.values(result).some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 512)) {
    throw new TypeError('Invalid application-control principal provenance.');
  }
  return Object.freeze(result as Record<string, string>);
}

function cloneApplicationExecuteRequest(value: unknown): Readonly<Record<string, unknown>> {
  const required = ['protocolVersion', 'intentId', 'idempotencyKey', 'principal', 'appId', 'actionId', 'arguments', 'expectedRevision'];
  if (!isRecord(value) || !exactKeys(value, required) || value.protocolVersion !== 1 || !isRecord(value.arguments)) {
    throw new TypeError('Invalid application-control execute request.');
  }
  const argumentsClone = cloneApplicationJson(value.arguments);
  if (new TextEncoder().encode(JSON.stringify(argumentsClone)).byteLength > MAX_APPLICATION_ARGUMENT_BYTES) {
    throw new TypeError('Application action arguments exceed 64 KiB.');
  }
  return Object.freeze({
    protocolVersion: 1,
    intentId: value.intentId,
    idempotencyKey: value.idempotencyKey,
    principal: cloneApplicationPrincipal(value.principal),
    appId: value.appId,
    actionId: value.actionId,
    arguments: argumentsClone,
    expectedRevision: value.expectedRevision,
  });
}

function cloneApplicationCapability(value: unknown): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value)
    || !exactKeys(value, ['appId', 'actionId', 'adapterVersion', 'risk', 'requiresApproval'])
    || typeof value.appId !== 'string'
    || typeof value.actionId !== 'string'
    || typeof value.adapterVersion !== 'string'
    || !APPLICATION_RISK_LEVELS.has(value.risk)
    || typeof value.requiresApproval !== 'boolean'
  ) throw new TypeError('Invalid application-control capability.');
  return Object.freeze({ ...value });
}

function cloneApplicationReceipt(value: unknown): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value)
    || !exactKeys(
      value,
      ['protocolVersion', 'receiptId', 'intentId', 'idempotencyKey', 'appId', 'actionId', 'status', 'approvedByUser', 'retryable', 'occurredAt', 'journalSequence'],
      ['errorCode', 'reconcilesReceiptId'],
    )
    || value.protocolVersion !== 1
    || !APPLICATION_EFFECT_STATUSES.has(value.status)
    || typeof value.approvedByUser !== 'boolean'
    || typeof value.retryable !== 'boolean'
    || typeof value.occurredAt !== 'string'
    || !Number.isSafeInteger(value.journalSequence)
    || (value.journalSequence as number) < 0
    || (value.errorCode !== undefined && !APPLICATION_ERROR_CODES.has(value.errorCode))
  ) throw new TypeError('Invalid application-control receipt.');
  const hasError = value.errorCode !== undefined;
  if (
    ((value.status === 'committed' || value.status === 'noop')
      && (value.approvedByUser !== true || value.retryable !== false || hasError))
    || (value.status === 'unknown'
      && (value.approvedByUser !== true || value.retryable !== false || !hasError))
    || (value.status === 'rejected'
      && (value.approvedByUser !== false || value.retryable !== false || !hasError))
    || (value.status === 'failed' && !hasError)
  ) throw new TypeError('Impossible application-control receipt outcome.');
  if (
    ((value.journalSequence as number) === 0
      && !(value.status === 'rejected' && value.errorCode === 'JOURNAL_UNAVAILABLE'))
    || ((value.journalSequence as number) > 0
      && value.status === 'rejected' && value.errorCode === 'JOURNAL_UNAVAILABLE')
  ) throw new TypeError('Invalid journal-unavailable receipt sequence.');
  return Object.freeze({ ...value });
}

function cloneApplicationReceiptLookup(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !exactKeys(value, ['protocolVersion', 'idempotencyKey', 'principal']) || value.protocolVersion !== 1) {
    throw new TypeError('Invalid application-control receipt lookup.');
  }
  return Object.freeze({
    protocolVersion: 1,
    idempotencyKey: value.idempotencyKey,
    principal: cloneApplicationPrincipal(value.principal),
  });
}

async function invokeState(channel: string, ...args: unknown[]): Promise<State> {
  return cloneState(await ipcRenderer.invoke(channel, ...args));
}

const wechat = Object.freeze({
  mount: (bounds: Bounds): Promise<State> => invokeState(CHANNELS.mount, cloneBounds(bounds)),
  setBounds: (bounds: Bounds): Promise<State> => invokeState(CHANNELS.setBounds, cloneBounds(bounds)),
  setVisible: (visible: boolean): Promise<State> => {
    if (typeof visible !== 'boolean') {
      return Promise.reject(new TypeError('WeChat visibility must be a boolean.'));
    }
    return invokeState(CHANNELS.setVisible, visible);
  },
  focus: (): Promise<State> => invokeState(CHANNELS.focus),
  reload: (): Promise<State> => invokeState(CHANNELS.reload),
  goBack: (): Promise<State> => invokeState(CHANNELS.goBack),
  unmount: async (): Promise<void> => {
    const result: unknown = await ipcRenderer.invoke(CHANNELS.unmount);
    if (result !== undefined) {
      throw new TypeError('Invalid WeChat unmount result.');
    }
  },
  getState: (): Promise<State> => invokeState(CHANNELS.getState),
  onState: (listener: (state: State) => void): (() => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('WeChat state listener must be a function.');
    }

    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      try {
        listener(cloneState(payload));
      } catch (error) {
        console.error('Rejected invalid WeChat state event.', error);
      }
    };
    ipcRenderer.on(CHANNELS.stateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(CHANNELS.stateChanged, wrapped);
    };
  },
});

const applicationControl = Object.freeze({
  listCapabilities: async (): Promise<readonly Readonly<Record<string, unknown>>[]> => {
    const value: unknown = await ipcRenderer.invoke(APPLICATION_CONTROL_CHANNELS.listCapabilities);
    if (!Array.isArray(value)) throw new TypeError('Invalid application-control capability list.');
    return Object.freeze(value.map(cloneApplicationCapability));
  },
  execute: async (request: unknown): Promise<Readonly<Record<string, unknown>>> =>
    cloneApplicationReceipt(await ipcRenderer.invoke(
      APPLICATION_CONTROL_CHANNELS.execute,
      cloneApplicationExecuteRequest(request),
    )),
  getReceipt: async (lookup: unknown): Promise<Readonly<Record<string, unknown>> | null> => {
    const value: unknown = await ipcRenderer.invoke(
      APPLICATION_CONTROL_CHANNELS.getReceipt,
      cloneApplicationReceiptLookup(lookup),
    );
    return value === null ? null : cloneApplicationReceipt(value);
  },
});

const agentRuntime = Object.freeze({
  getSidecarConfig: async (): Promise<Readonly<{
    baseUrl: string;
    token: string;
    origin: string;
  }> | undefined> => {
    const value: unknown = await ipcRenderer.invoke(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL);
    return value === undefined ? undefined : cloneAgentRuntimeSidecarConfig(value);
  },
});

contextBridge.exposeInMainWorld('alsniperDesktop', Object.freeze({ wechat, applicationControl, agentRuntime }));
