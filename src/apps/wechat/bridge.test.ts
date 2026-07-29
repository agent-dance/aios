import { describe, expect, it, vi } from 'vitest';
import {
  describeWeChatViewError,
  isWeChatSurfaceActive,
  isWeChatViewState,
  resolveWeChatEmbeddedViewBridge,
  shouldShowWeChatNativeView,
  toWeChatViewBounds,
  type WeChatEmbeddedViewBridge,
} from './bridge';

function createBridge(): WeChatEmbeddedViewBridge {
  const state = { phase: 'ready', visible: true, canGoBack: false } as const;
  return {
    mount: vi.fn(async () => state),
    setBounds: vi.fn(async () => state),
    setVisible: vi.fn(async () => state),
    focus: vi.fn(async () => state),
    reload: vi.fn(async () => state),
    goBack: vi.fn(async () => state),
    unmount: vi.fn(async () => undefined),
    getState: vi.fn(async () => state),
    onState: vi.fn(() => () => undefined),
  };
}

describe('WeChat embedded-view bridge boundary', () => {
  it('accepts only the closed host state model', () => {
    expect(isWeChatViewState({ phase: 'idle', visible: false, canGoBack: false })).toBe(true);
    expect(isWeChatViewState({ phase: 'loading', visible: false, canGoBack: true })).toBe(true);
    expect(isWeChatViewState({ phase: 'ready', visible: true, canGoBack: true })).toBe(true);
    expect(isWeChatViewState({ phase: 'failed', visible: false, canGoBack: false, errorCode: 'NETWORK_ERROR' })).toBe(true);

    expect(isWeChatViewState({ phase: 'navigating', visible: true, canGoBack: false })).toBe(false);
    expect(isWeChatViewState({ phase: 'ready', visible: 'yes', canGoBack: false })).toBe(false);
    expect(isWeChatViewState({ phase: 'failed', visible: false, canGoBack: false, errorCode: 500 })).toBe(false);
    expect(isWeChatViewState({ phase: 'failed', visible: false, canGoBack: false })).toBe(false);
    expect(isWeChatViewState({ phase: 'ready', visible: true, canGoBack: false, errorCode: 'NETWORK_ERROR' })).toBe(false);
    expect(isWeChatViewState({ phase: 'ready', visible: true, canGoBack: false, extra: true })).toBe(false);
    expect(isWeChatViewState(null)).toBe(false);
  });

  it('exposes the exact preload bridge only when every method is present', () => {
    const bridge = createBridge();
    expect(resolveWeChatEmbeddedViewBridge({ alsniperDesktop: { wechat: bridge } })).toBe(bridge);
    expect(resolveWeChatEmbeddedViewBridge({ alsniperDesktop: {} })).toBeNull();
    expect(resolveWeChatEmbeddedViewBridge(undefined)).toBeNull();

    const malformed = { ...bridge, unmount: undefined };
    expect(resolveWeChatEmbeddedViewBridge({
      alsniperDesktop: { wechat: malformed as unknown as WeChatEmbeddedViewBridge },
    })).toBeNull();
  });

  it('converts CSS geometry to clipped integer device-independent bounds', () => {
    expect(toWeChatViewBounds(
      { left: 10.25, top: 20.75, right: 300.1, bottom: 500.2 },
      280,
      480,
    )).toEqual({ x: 10, y: 20, width: 270, height: 460 });

    expect(toWeChatViewBounds(
      { left: -30, top: -10, right: 80.2, bottom: 40.8 },
      1280,
      720,
    )).toEqual({ x: 0, y: 0, width: 81, height: 41 });
  });

  it('uses a hidden-safe minimum mount bound for invalid or collapsed geometry', () => {
    expect(toWeChatViewBounds(
      { left: Number.NaN, top: Number.POSITIVE_INFINITY, right: 0, bottom: 0 },
      1280,
      720,
    )).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('shows the native surface only for a ready, active, laid-out window', () => {
    const readyContext = {
      phase: 'ready' as const,
      isActive: true,
      isMinimized: false,
      documentVisible: true,
      surfaceWidth: 800,
      surfaceHeight: 600,
    };
    expect(shouldShowWeChatNativeView(readyContext)).toBe(true);
    expect(shouldShowWeChatNativeView({ ...readyContext, phase: 'loading' })).toBe(false);
    expect(shouldShowWeChatNativeView({ ...readyContext, phase: 'failed' })).toBe(false);
    expect(shouldShowWeChatNativeView({ ...readyContext, isActive: false })).toBe(false);
    expect(shouldShowWeChatNativeView({ ...readyContext, isMinimized: true })).toBe(false);
    expect(shouldShowWeChatNativeView({ ...readyContext, documentVisible: false })).toBe(false);
    expect(shouldShowWeChatNativeView({ ...readyContext, surfaceWidth: 0 })).toBe(false);
  });

  it('treats every shell overlay, including the assistant, as native-view occlusion', () => {
    const noOcclusion = {
      controlCenterOpen: false,
      clockOpen: false,
      assistantOpen: false,
    };
    expect(isWeChatSurfaceActive(true, noOcclusion)).toBe(true);
    expect(isWeChatSurfaceActive(false, noOcclusion)).toBe(false);
    expect(isWeChatSurfaceActive(true, { ...noOcclusion, controlCenterOpen: true })).toBe(false);
    expect(isWeChatSurfaceActive(true, { ...noOcclusion, clockOpen: true })).toBe(false);
    expect(isWeChatSurfaceActive(true, { ...noOcclusion, assistantOpen: true })).toBe(false);
  });

  it('maps security and availability failures to actionable, non-sensitive copy', () => {
    expect(describeWeChatViewError('NAVIGATION_BLOCKED')).toContain('宿主已阻止');
    expect(describeWeChatViewError('NETWORK_ERROR')).toContain('检查网络');
    expect(describeWeChatViewError('CERTIFICATE_ERROR')).toContain('安全证书');
    expect(describeWeChatViewError('VIEW_UNAVAILABLE')).toContain('桌面版');
    expect(describeWeChatViewError('RENDERER_CRASHED')).toContain('停止运行');
    expect(describeWeChatViewError('unknown')).toContain('重试');
  });
});
