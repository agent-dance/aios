export const WECHAT_VIEW_PHASES = ['idle', 'loading', 'ready', 'failed'] as const;
export const WECHAT_VIEW_ERROR_CODES = [
  'NAVIGATION_BLOCKED',
  'NETWORK_ERROR',
  'CERTIFICATE_ERROR',
  'VIEW_UNAVAILABLE',
  'RENDERER_CRASHED',
] as const;

export type WeChatViewPhase = (typeof WECHAT_VIEW_PHASES)[number];
export type WeChatViewErrorCode = (typeof WECHAT_VIEW_ERROR_CODES)[number];

export interface WeChatViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WeChatViewState {
  readonly phase: WeChatViewPhase;
  readonly visible: boolean;
  readonly canGoBack: boolean;
  readonly errorCode?: WeChatViewErrorCode;
}

export type WeChatViewStateListener = (state: WeChatViewState) => void;

/**
 * Narrow preload capability for the single Tencent-owned WeChat surface.
 * The renderer never supplies a URL, session partition, or web preferences.
 */
export interface WeChatEmbeddedViewBridge {
  mount(bounds: WeChatViewBounds): Promise<WeChatViewState>;
  setBounds(bounds: WeChatViewBounds): Promise<WeChatViewState>;
  setVisible(visible: boolean): Promise<WeChatViewState>;
  focus(): Promise<WeChatViewState>;
  reload(): Promise<WeChatViewState>;
  goBack(): Promise<WeChatViewState>;
  unmount(): Promise<void>;
  getState(): Promise<WeChatViewState>;
  onState(listener: WeChatViewStateListener): () => void;
}

export interface WeChatViewVisibilityContext {
  readonly phase: WeChatViewPhase;
  readonly isActive: boolean;
  readonly isMinimized: boolean;
  readonly documentVisible: boolean;
  readonly surfaceWidth: number;
  readonly surfaceHeight: number;
}

export interface WeChatShellOcclusionState {
  readonly controlCenterOpen: boolean;
  readonly clockOpen: boolean;
  readonly assistantOpen: boolean;
}

declare global {
  interface Window {
    readonly alsniperDesktop?: {
      readonly wechat?: WeChatEmbeddedViewBridge;
    };
  }
}

const PHASES = new Set<string>(WECHAT_VIEW_PHASES);
const ERROR_CODES = new Set<string>(WECHAT_VIEW_ERROR_CODES);
const REQUIRED_METHODS = [
  'mount',
  'setBounds',
  'setVisible',
  'focus',
  'reload',
  'goBack',
  'unmount',
  'getState',
  'onState',
] as const;

export function isWeChatViewState(value: unknown): value is WeChatViewState {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['phase', 'visible', 'canGoBack', 'errorCode'].includes(key))) return false;
  if (!['phase', 'visible', 'canGoBack'].every((key) => Object.hasOwn(value, key))) return false;
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) return false;
  if (typeof value.visible !== 'boolean' || typeof value.canGoBack !== 'boolean') return false;
  const hasErrorCode = Object.hasOwn(value, 'errorCode');
  if ((value.phase === 'failed') !== hasErrorCode) return false;
  return !hasErrorCode || (typeof value.errorCode === 'string' && ERROR_CODES.has(value.errorCode));
}

export function resolveWeChatEmbeddedViewBridge(
  hostWindow: Pick<Window, 'alsniperDesktop'> | undefined = typeof window === 'undefined' ? undefined : window,
): WeChatEmbeddedViewBridge | null {
  const candidate = hostWindow?.alsniperDesktop?.wechat;
  if (!candidate || !isRecord(candidate)) return null;
  return REQUIRED_METHODS.every((method) => typeof candidate[method] === 'function')
    ? candidate
    : null;
}

export function toWeChatViewBounds(
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
): WeChatViewBounds {
  const safeViewportWidth = Math.min(32_768, nonNegativeFinite(viewportWidth));
  const safeViewportHeight = Math.min(32_768, nonNegativeFinite(viewportHeight));
  const left = clamp(finiteOrZero(rect.left), 0, safeViewportWidth);
  const top = clamp(finiteOrZero(rect.top), 0, safeViewportHeight);
  const right = clamp(finiteOrZero(rect.right), left, safeViewportWidth);
  const bottom = clamp(finiteOrZero(rect.bottom), top, safeViewportHeight);
  const x = Math.floor(left);
  const y = Math.floor(top);

  // Electron view bounds are integer device-independent pixels. A hidden or
  // not-yet-laid-out React surface still receives a harmless 1x1 mount bound;
  // visibility is synchronized independently and remains false.
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(right) - x),
    height: Math.max(1, Math.ceil(bottom) - y),
  };
}

export function shouldShowWeChatNativeView(context: WeChatViewVisibilityContext): boolean {
  return context.phase === 'ready'
    && context.isActive
    && !context.isMinimized
    && context.documentVisible
    && Number.isFinite(context.surfaceWidth)
    && Number.isFinite(context.surfaceHeight)
    && context.surfaceWidth > 0
    && context.surfaceHeight > 0;
}

export function isWeChatSurfaceActive(
  windowActive: boolean,
  occlusion: WeChatShellOcclusionState,
): boolean {
  return windowActive
    && !occlusion.controlCenterOpen
    && !occlusion.clockOpen
    && !occlusion.assistantOpen;
}

export function describeWeChatViewError(errorCode?: string): string {
  switch (errorCode) {
    case 'NAVIGATION_BLOCKED':
      return '微信页面尝试前往未获允许的地址，桌面宿主已阻止该导航。';
    case 'NETWORK_ERROR':
      return '无法连接微信服务。请检查网络后重试。';
    case 'CERTIFICATE_ERROR':
      return '无法验证微信服务的安全证书。请检查系统时间和网络后重试。';
    case 'RENDERER_CRASHED':
      return '微信视图意外停止运行。你可以重试恢复。';
    case 'VIEW_UNAVAILABLE':
      return '桌面宿主暂时无法创建微信视图。请重启 AlSniper OS 桌面版后重试。';
    default:
      return '微信视图加载失败。请重试；若仍然失败，请重启 AlSniper OS 桌面版。';
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonNegativeFinite(value: number): number {
  return Math.max(0, finiteOrZero(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
