export const WECHAT_IPC_CHANNELS = Object.freeze({
  mount: 'alsniper-desktop:wechat:mount',
  setBounds: 'alsniper-desktop:wechat:set-bounds',
  setVisible: 'alsniper-desktop:wechat:set-visible',
  focus: 'alsniper-desktop:wechat:focus',
  reload: 'alsniper-desktop:wechat:reload',
  goBack: 'alsniper-desktop:wechat:go-back',
  unmount: 'alsniper-desktop:wechat:unmount',
  getState: 'alsniper-desktop:wechat:get-state',
  stateChanged: 'alsniper-desktop:wechat:state-changed',
} as const);

export const WECHAT_PHASES = ['idle', 'loading', 'ready', 'failed'] as const;

export const WECHAT_ERROR_CODES = [
  'NAVIGATION_BLOCKED',
  'NETWORK_ERROR',
  'CERTIFICATE_ERROR',
  'VIEW_UNAVAILABLE',
  'RENDERER_CRASHED',
] as const;

export interface WeChatBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type WeChatPhase = (typeof WECHAT_PHASES)[number];
export type WeChatErrorCode = (typeof WECHAT_ERROR_CODES)[number];

export interface WeChatState {
  readonly phase: WeChatPhase;
  readonly visible: boolean;
  readonly canGoBack: boolean;
  readonly errorCode?: WeChatErrorCode;
}

export class WeChatContractError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor(message = 'Invalid WeChat desktop bridge argument.') {
    super(message);
    this.name = 'WeChatContractError';
  }
}

const BOUNDS_KEYS = ['height', 'width', 'x', 'y'] as const;
const STATE_REQUIRED_KEYS = ['canGoBack', 'phase', 'visible'] as const;
const STATE_ALLOWED_KEYS = [...STATE_REQUIRED_KEYS, 'errorCode'] as const;
const MAX_BOUND_COMPONENT = 32_768;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[] = required,
): boolean {
  const keys = Object.keys(value).sort();
  const sortedAllowed = [...allowed].sort();

  if (keys.some((key) => !sortedAllowed.includes(key))) {
    return false;
  }

  return required.every((key) => Object.hasOwn(value, key));
}

function isBoundComponent(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= minimum
    && value <= MAX_BOUND_COMPONENT
  );
}

export function parseWeChatBounds(value: unknown): WeChatBounds {
  if (
    !isRecord(value)
    || !hasExactKeys(value, BOUNDS_KEYS)
    || !isBoundComponent(value.x, 0)
    || !isBoundComponent(value.y, 0)
    || !isBoundComponent(value.width, 1)
    || !isBoundComponent(value.height, 1)
  ) {
    throw new WeChatContractError('Bounds must contain only finite integer x, y, width, and height values.');
  }

  return Object.freeze({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  });
}

export function parseWeChatVisibility(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new WeChatContractError('Visibility must be a boolean.');
  }

  return value;
}

export function assertNoPayload(value: unknown): void {
  if (value !== undefined) {
    throw new WeChatContractError('This operation does not accept a payload.');
  }
}

export function cloneWeChatState(value: unknown): WeChatState {
  if (
    !isRecord(value)
    || !hasExactKeys(value, STATE_REQUIRED_KEYS, STATE_ALLOWED_KEYS)
    || typeof value.visible !== 'boolean'
    || typeof value.canGoBack !== 'boolean'
    || !WECHAT_PHASES.includes(value.phase as WeChatPhase)
  ) {
    throw new WeChatContractError('Invalid WeChat state payload.');
  }

  const errorCode = value.errorCode;
  if (errorCode !== undefined && !WECHAT_ERROR_CODES.includes(errorCode as WeChatErrorCode)) {
    throw new WeChatContractError('Invalid WeChat error code.');
  }

  if (value.phase === 'failed' && errorCode === undefined) {
    throw new WeChatContractError('Failed WeChat state requires an error code.');
  }

  if (value.phase !== 'failed' && errorCode !== undefined) {
    throw new WeChatContractError('Only failed WeChat state may contain an error code.');
  }

  return Object.freeze({
    phase: value.phase as WeChatPhase,
    visible: value.visible,
    canGoBack: value.canGoBack,
    ...(errorCode === undefined ? {} : { errorCode: errorCode as WeChatErrorCode }),
  });
}

export function createWeChatState(
  phase: WeChatPhase,
  visible: boolean,
  canGoBack: boolean,
  errorCode?: WeChatErrorCode,
): WeChatState {
  return cloneWeChatState({
    phase,
    visible,
    canGoBack,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}
