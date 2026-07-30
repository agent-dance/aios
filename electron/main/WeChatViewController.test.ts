import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  WeChatViewController,
  WECHAT_DOCUMENT_READY_TIMEOUT_MS,
} from './WeChatViewController.js';
import { WECHAT_ENTRY_URL } from '../shared/navigationPolicy.js';

class FakeWebContents extends EventEmitter {
  readonly loadURL = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  readonly reload = vi.fn();
  readonly focus = vi.fn();
  readonly stop = vi.fn();
  readonly insertCSS = vi.fn(async () => 'layout-key');
  readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => ({ ok: true }));
  readonly mainFrame = {
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => this.destroyed,
  };
  readonly close = vi.fn(() => {
    this.destroyed = true;
  });
  readonly navigationHistory = {
    entries: [] as Array<{ url: string }>,
    activeIndex: -1,
    getAllEntries: () => this.navigationHistory.entries,
    getActiveIndex: () => this.navigationHistory.activeIndex,
    goBack: vi.fn(),
  };

  currentUrl = '';
  destroyed = false;
  loading = false;
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }

  getURL(): string {
    return this.currentUrl;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    return this.loading;
  }
}

class FakeView {
  readonly webContents = new FakeWebContents();
  readonly setBounds = vi.fn();
  readonly setVisible = vi.fn();
}

function createHarness(contentSize = { width: 1000, height: 700 }) {
  const view = new FakeView();
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const checkpointStorage = vi.fn(async () => undefined);
  const states: unknown[] = [];
  const hostWindow = {
    contentView: { addChildView, removeChildView },
    getContentBounds: () => ({ x: 50, y: 80, ...contentSize }),
    isVisible: () => true,
    isFocused: () => true,
    isMinimized: () => false,
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;

  const logger = { error: vi.fn(), warn: vi.fn() };
  const controller = new WeChatViewController({
    hostWindow,
    createView: () => view as unknown as WebContentsView,
    checkpointStorage,
    publishState: (state) => states.push(state),
    logger,
  });

  return { controller, view, addChildView, removeChildView, checkpointStorage, states, logger };
}

describe('WeChatViewController', () => {
  it('mounts the fixed entry hidden and clips bounds to the host content area', () => {
    const { controller, view, addChildView } = createHarness();

    const state = controller.mount({ x: 900, y: 650, width: 500, height: 500 });

    expect(addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 900, y: 650, width: 100, height: 50 });
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(WECHAT_ENTRY_URL);
    expect(state).toEqual({ phase: 'loading', visible: false, canGoBack: false });
  });

  it('does not let mount or IPC select a URL and only shows when ready after an explicit visibility command', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });

    expect(controller.setVisible(true)).toEqual({ phase: 'loading', visible: false, canGoBack: false });
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => {
      expect(controller.getState()).toEqual({ phase: 'ready', visible: true, canGoBack: false });
    });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    controller.mount({ x: 20, y: 30, width: 700, height: 500 });
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
  });

  it('becomes ready at an allowlisted DOM without waiting for a never-ending load event', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });

    view.webContents.emit('dom-ready');

    await vi.waitFor(() => {
      expect(controller.getState()).toEqual({ phase: 'ready', visible: false, canGoBack: false });
    });
    expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('.main_inner'), {
      cssOrigin: 'user',
    });
  });

  it('fails closed when an initial document never reaches dom-ready', () => {
    vi.useFakeTimers();
    const { controller, logger } = createHarness();
    try {
      controller.mount({ x: 0, y: 0, width: 800, height: 600 });

      vi.advanceTimersByTime(WECHAT_DOCUMENT_READY_TIMEOUT_MS);

      expect(controller.getState()).toEqual({
        phase: 'failed',
        visible: false,
        canGoBack: false,
        errorCode: 'NETWORK_ERROR',
      });
      expect(logger.error).toHaveBeenCalledWith(
        'The embedded WeChat document did not become ready before the loading deadline.',
      );
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('does not expose a remote document until full-bleed layout is installed', async () => {
    let resolveLayout!: (key: string) => void;
    const layoutReady = new Promise<string>((resolve) => {
      resolveLayout = resolve;
    });
    const { controller, view } = createHarness();
    view.webContents.insertCSS.mockImplementationOnce(() => layoutReady);
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);

    view.webContents.emit('dom-ready');
    expect(controller.getState()).toEqual({ phase: 'loading', visible: false, canGoBack: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    resolveLayout('layout-key');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));
    expect(controller.getState().visible).toBe(true);
  });

  it('atomically hides a ready view throughout reload layout preparation', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    }));

    let resolveReloadLayout!: (key: string) => void;
    const reloadLayout = new Promise<string>((resolve) => {
      resolveReloadLayout = resolve;
    });
    view.webContents.insertCSS.mockImplementationOnce(() => reloadLayout);

    controller.reload();
    expect(controller.getState()).toEqual({ phase: 'loading', visible: false, canGoBack: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    view.webContents.emit(
      'did-start-navigation',
      {},
      WECHAT_ENTRY_URL,
      false,
      true,
    );
    view.webContents.emit('dom-ready');
    expect(controller.getState()).toEqual({ phase: 'loading', visible: false, canGoBack: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    resolveReloadLayout('reload-layout-key');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    }));
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('reapplies the layout after navigation and fails closed if insertion fails', async () => {
    const { controller, view, logger } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });

    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));
    expect(view.webContents.insertCSS).toHaveBeenCalledTimes(1);

    view.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: WECHAT_ENTRY_URL,
    });
    view.webContents.insertCSS.mockRejectedValueOnce(new Error('insertion failed'));
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'failed',
      visible: false,
      canGoBack: false,
      errorCode: 'VIEW_UNAVAILABLE',
    }));
    expect(view.webContents.insertCSS).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to apply the embedded WeChat document layout.',
      expect.any(Error),
    );
  });

  it('reattests a completed main navigation when its start event was unavailable', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));

    view.webContents.loading = true;
    view.webContents.emit('did-navigate');
    expect(controller.getState()).toEqual({
      phase: 'loading',
      visible: false,
      canGoBack: false,
    });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    }));
    expect(view.webContents.insertCSS).toHaveBeenCalledTimes(2);
  });

  it('keeps an attested view ready during spinner, subframe, and same-document activity', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    }));

    view.webContents.emit('did-start-loading');
    view.webContents.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
      url: 'https://wx.qq.com/frame',
    });
    view.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
      url: `${WECHAT_ENTRY_URL}#chat`,
    });

    expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    });
    expect(view.webContents.insertCSS).toHaveBeenCalledTimes(1);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('does not remain loading after an aborted reload produces no replacement document', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));

    vi.useFakeTimers();
    try {
      controller.reload();
      view.webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: WECHAT_ENTRY_URL,
      });
      view.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', WECHAT_ENTRY_URL, true);

      vi.advanceTimersByTime(WECHAT_DOCUMENT_READY_TIMEOUT_MS);

      expect(controller.getState()).toEqual({
        phase: 'failed',
        visible: false,
        canGoBack: false,
        errorCode: 'NETWORK_ERROR',
      });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('times out a back navigation that never produces a document', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));
    view.webContents.navigationHistory.entries = [
      { url: WECHAT_ENTRY_URL },
      { url: 'https://wx2.qq.com/chat' },
    ];
    view.webContents.navigationHistory.activeIndex = 1;

    vi.useFakeTimers();
    try {
      controller.goBack();
      vi.advanceTimersByTime(WECHAT_DOCUMENT_READY_TIMEOUT_MS);

      expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
      expect(controller.getState()).toEqual({
        phase: 'failed',
        visible: false,
        canGoBack: true,
        errorCode: 'NETWORK_ERROR',
      });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it('cannot become visible from a stale layout completion after an unresponsive event', async () => {
    let resolveStaleLayout!: (key: string) => void;
    const staleLayout = new Promise<string>((resolve) => {
      resolveStaleLayout = resolve;
    });
    const { controller, view } = createHarness();
    view.webContents.insertCSS.mockImplementationOnce(() => staleLayout);
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);

    view.webContents.emit('dom-ready');
    view.webContents.emit('unresponsive');
    expect(controller.getState()).toMatchObject({ phase: 'failed', visible: false });

    resolveStaleLayout('stale-key');
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ phase: 'failed', visible: false });

    view.webContents.emit('responsive');
    await vi.waitFor(() => expect(controller.getState()).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    }));
    expect(view.webContents.insertCSS).toHaveBeenCalledTimes(2);
  });

  it('issues an exact-document automation lease and revokes it on unresponsive state', async () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));

    const target = controller.getAutomationTarget();
    expect(target).not.toBeNull();
    expect(target?.binding).toMatchObject({
      controllerGeneration: 1,
      origin: 'https://wx.qq.com',
    });
    expect(target?.binding.documentSequence).toBeGreaterThan(0);
    await expect(target?.prepareMessage({ operation: 'prepare', rootToken: 'fixed-token' })).resolves.toEqual({ ok: true });
    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      1_004,
      [{ code: expect.stringContaining('"rootToken":"fixed-token"') }],
      false,
    );

    view.webContents.emit('unresponsive');
    expect(target?.isCurrent()).toBe(false);
    expect(controller.getAutomationTarget()).toBeNull();
    await expect(target?.prepareMessage({ operation: 'prepare', rootToken: 'fixed-token' })).rejects.toThrow(
      'document lease is no longer current',
    );
  });

  it('blocks popup and navigation escape attempts', () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });

    expect(view.webContents.windowOpenHandler?.({ url: 'https://wx.qq.com/' })).toEqual({ action: 'deny' });
    expect(view.webContents.windowOpenHandler?.({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });

    const event = {
      url: 'https://wx.qq.com.evil.example/',
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    view.webContents.emit('will-frame-navigate', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('hides the native view and publishes a closed error on load failure', () => {
    const { controller, view, states } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');

    view.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', WECHAT_ENTRY_URL, true);

    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(controller.getState()).toEqual({
      phase: 'failed',
      visible: false,
      canGoBack: false,
      errorCode: 'NETWORK_ERROR',
    });
    expect(states.at(-1)).toEqual(controller.getState());
  });

  it('maps certificate failures, checkpoints renderer crashes, and hides raw details', async () => {
    const { controller, view, checkpointStorage } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');

    controller.handleCertificateError(view.webContents as unknown as WebContents);
    expect(controller.getState()).toEqual({
      phase: 'failed',
      visible: false,
      canGoBack: false,
      errorCode: 'CERTIFICATE_ERROR',
    });

    view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(controller.getState().errorCode).toBe('RENDERER_CRASHED');
    await vi.waitFor(() => expect(checkpointStorage).toHaveBeenCalledOnce());
  });

  it('only goes back to a previously validated WeChat entry', () => {
    const { controller, view } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.navigationHistory.entries = [
      { url: 'https://wx.qq.com/' },
      { url: 'https://wx2.qq.com/chat' },
    ];
    view.webContents.navigationHistory.activeIndex = 1;

    expect(controller.getState().canGoBack).toBe(true);
    controller.goBack();
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledOnce();

    view.webContents.navigationHistory.entries[0] = { url: 'https://evil.example/' };
    expect(controller.getState().canGoBack).toBe(false);
    controller.goBack();
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
  });

  it('hides on host visibility loss, reconciles requested visibility, and checkpoints released ownership', async () => {
    const { controller, view, removeChildView, checkpointStorage } = createHarness();
    controller.mount({ x: 0, y: 0, width: 800, height: 600 });
    controller.setVisible(true);
    view.webContents.emit('dom-ready');
    await vi.waitFor(() => expect(controller.getState().phase).toBe('ready'));

    controller.handleHostVisibilityLoss();
    expect(controller.getState().visible).toBe(false);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);

    controller.reconcileHostVisibility();
    expect(controller.getState().visible).toBe(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    await controller.unmount();
    expect(removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(checkpointStorage).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ phase: 'idle', visible: false, canGoBack: false });
  });
});
