import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { applyWeChatDocumentLayout } from './documentLayoutPolicy.js';
import { fitBoundsToContent } from '../shared/layout.js';
import {
  isAllowedWeChatMainFrameUrl,
  isAllowedWeChatNavigation,
  WECHAT_ENTRY_URL,
} from '../shared/navigationPolicy.js';
import {
  cloneWeChatState,
  createWeChatState,
  type WeChatBounds,
  type WeChatErrorCode,
  type WeChatState,
} from '../shared/wechatProtocol.js';

export interface WeChatControllerLogger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

export interface WeChatViewControllerOptions {
  readonly hostWindow: BrowserWindow;
  readonly createView: () => WebContentsView;
  readonly checkpointStorage: () => Promise<void>;
  readonly publishState: (state: WeChatState) => void;
  readonly logger?: WeChatControllerLogger;
}

const defaultLogger: WeChatControllerLogger = {
  error: (message, error) => console.error(message, error),
  warn: (message) => console.warn(message),
};

export const WECHAT_DOCUMENT_READY_TIMEOUT_MS = 15_000;

export class WeChatViewController {
  readonly #hostWindow: BrowserWindow;
  readonly #createView: () => WebContentsView;
  readonly #checkpointStorage: () => Promise<void>;
  readonly #publishState: (state: WeChatState) => void;
  readonly #logger: WeChatControllerLogger;

  #view: WebContentsView | null = null;
  #requestedBounds: WeChatBounds | null = null;
  #requestedVisible = false;
  #state: WeChatState = createWeChatState('idle', false, false);
  #generation = 0;
  #documentSequence = 0;
  #documentLayoutApplication: {
    readonly sequence: number;
    readonly operation: Promise<string>;
  } | null = null;
  #documentReadyTimer: ReturnType<typeof setTimeout> | null = null;
  #certificateFailureGeneration: number | null = null;
  #disposed = false;

  constructor(options: WeChatViewControllerOptions) {
    this.#hostWindow = options.hostWindow;
    this.#createView = options.createView;
    this.#checkpointStorage = options.checkpointStorage;
    this.#publishState = options.publishState;
    this.#logger = options.logger ?? defaultLogger;
  }

  getState(): WeChatState {
    return cloneWeChatState({
      ...this.#state,
      canGoBack: this.#hasSafeBackTarget(),
    });
  }

  mount(bounds: WeChatBounds): WeChatState {
    this.#assertActive();
    this.#requestedBounds = bounds;

    if (this.#getMountedView() !== null) {
      this.#applyBounds();
      return this.getState();
    }

    const generation = ++this.#generation;
    try {
      const view = this.#createView();
      const contents = view.webContents;
      this.#view = view;
      this.#invalidateRemoteDocument();
      this.#configureWebContents(contents, generation);
      this.#hostWindow.contentView.addChildView(view);
      this.#applyBounds();
      view.setVisible(false);
      this.#state = createWeChatState('loading', false, false);
      this.#emitState();
      this.#armDocumentReadyWatchdog(generation, contents);

      void contents.loadURL(WECHAT_ENTRY_URL).catch((error: unknown) => {
        if (!this.#isCurrent(generation, contents)) {
          return;
        }
        if (
          this.#state.phase === 'ready'
          && isAllowedWeChatMainFrameUrl(contents.getURL())
        ) {
          return;
        }
        this.#logger.error('The embedded WeChat entry page failed to load.', error);
        this.#transition(
          'failed',
          this.#certificateFailureGeneration === generation ? 'CERTIFICATE_ERROR' : 'NETWORK_ERROR',
        );
      });

      return this.getState();
    } catch (error) {
      this.#logger.error('Failed to create the embedded WeChat surface.', error);
      this.#releaseCurrentView();
      this.#state = createWeChatState('failed', false, false, 'VIEW_UNAVAILABLE');
      return this.#emitState();
    }
  }

  setBounds(bounds: WeChatBounds): WeChatState {
    this.#assertActive();
    this.#requestedBounds = bounds;
    if (this.#getMountedView() !== null) {
      this.#applyBounds();
    }
    return this.getState();
  }

  setVisible(visible: boolean): WeChatState {
    this.#assertActive();
    this.#requestedVisible = visible;
    const view = this.#getMountedView();
    if (view !== null) {
      const actualVisibility = visible && this.#canPresentView();
      view.setVisible(actualVisibility);
      this.#state = createWeChatState(
        this.#state.phase,
        actualVisibility,
        this.#hasSafeBackTarget(),
        this.#state.errorCode,
      );
      return this.#emitState();
    }
    return this.getState();
  }

  focus(): WeChatState {
    this.#assertActive();
    const view = this.#getMountedView();
    if (view !== null && this.#state.visible) {
      if (!this.#hostWindow.isVisible()) {
        this.#hostWindow.show();
      }
      this.#hostWindow.focus();
      view.webContents.focus();
    }
    return this.getState();
  }

  reload(): WeChatState {
    this.#assertActive();
    const view = this.#getMountedView();
    if (view === null) {
      return this.getState();
    }

    if (!isAllowedWeChatMainFrameUrl(view.webContents.getURL())) {
      this.#transition('failed', 'NAVIGATION_BLOCKED');
      return this.getState();
    }

    this.#transition('loading');
    this.#armDocumentReadyWatchdog(this.#generation, view.webContents);
    view.webContents.reload();
    return this.getState();
  }

  goBack(): WeChatState {
    this.#assertActive();
    const view = this.#getMountedView();
    if (view === null) {
      return this.getState();
    }

    const navigationHistory = view.webContents.navigationHistory;
    const target = this.#getSafeBackTarget();
    if (target === null) {
      return this.getState();
    }

    this.#transition('loading');
    this.#armDocumentReadyWatchdog(this.#generation, view.webContents);
    navigationHistory.goBack();
    return this.getState();
  }

  async unmount(): Promise<void> {
    this.#assertActive();
    ++this.#generation;
    this.#releaseCurrentView();
    this.#requestedBounds = null;
    this.#requestedVisible = false;
    this.#invalidateRemoteDocument();
    this.#certificateFailureGeneration = null;
    this.#state = createWeChatState('idle', false, false);
    this.#emitState();

    try {
      await this.#checkpointStorage();
    } catch (error) {
      // The view is already detached; persistence failure must not strand the
      // renderer-side operation or make the app impossible to close/reopen.
      this.#logger.error('Failed to checkpoint embedded WeChat storage after unmount.', error);
    }
  }

  handleHostResize(): void {
    if (!this.#disposed && this.#getMountedView() !== null) {
      this.#applyBounds();
    }
  }

  handleHostVisibilityLoss(): void {
    if (this.#disposed) {
      return;
    }
    const view = this.#getMountedView();
    if (view !== null && this.#state.visible) {
      view.setVisible(false);
      this.#state = createWeChatState(
        this.#state.phase,
        false,
        this.#hasSafeBackTarget(),
        this.#state.errorCode,
      );
      this.#emitState();
    }
  }

  reconcileHostVisibility(): void {
    if (this.#disposed) {
      return;
    }
    const view = this.#getMountedView();
    if (view === null) {
      return;
    }

    const shouldBeVisible = this.#requestedVisible && this.#canPresentView();
    if (this.#state.visible === shouldBeVisible) {
      return;
    }
    view.setVisible(shouldBeVisible);
    this.#state = createWeChatState(
      this.#state.phase,
      shouldBeVisible,
      this.#hasSafeBackTarget(),
      this.#state.errorCode,
    );
    this.#emitState();
  }

  ownsWebContents(contents: WebContents): boolean {
    return this.#view?.webContents === contents;
  }

  handleCertificateError(contents: WebContents): void {
    if (this.#disposed || !this.#isCurrent(this.#generation, contents)) {
      return;
    }
    this.#certificateFailureGeneration = this.#generation;
    this.#invalidateRemoteDocument();
    this.#transition('failed', 'CERTIFICATE_ERROR');
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    ++this.#generation;
    this.#releaseCurrentView();
    this.#requestedBounds = null;
    this.#requestedVisible = false;
    this.#invalidateRemoteDocument();
    this.#certificateFailureGeneration = null;
    this.#state = createWeChatState('idle', false, false);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('WeChatViewController is disposed.');
    }
  }

  #getMountedView(): WebContentsView | null {
    const view = this.#view;
    return view !== null && !view.webContents.isDestroyed() ? view : null;
  }

  #isCurrent(generation: number, contents: WebContents): boolean {
    return generation === this.#generation && this.#view?.webContents === contents && !contents.isDestroyed();
  }

  #canPresentView(): boolean {
    return (
      this.#state.phase === 'ready'
      && this.#hostWindow.isVisible()
      && this.#hostWindow.isFocused()
      && !this.#hostWindow.isMinimized()
    );
  }

  #applyBounds(): void {
    const view = this.#getMountedView();
    if (view === null || this.#requestedBounds === null) {
      return;
    }

    const contentBounds = this.#hostWindow.getContentBounds();
    const fittedBounds = fitBoundsToContent(this.#requestedBounds, {
      width: contentBounds.width,
      height: contentBounds.height,
    });
    if (fittedBounds !== null) {
      view.setBounds(fittedBounds);
    }
  }

  #configureWebContents(contents: WebContents, generation: number): void {
    contents.setWindowOpenHandler(({ url }) => {
      const classification = isAllowedWeChatMainFrameUrl(url) ? 'official' : 'untrusted';
      this.#logger.warn(`Blocked ${classification} popup from the embedded WeChat surface.`);
      return { action: 'deny' };
    });

    contents.on('will-frame-navigate', (event) => {
      if (!isAllowedWeChatNavigation(event.url, event.isMainFrame)) {
        event.preventDefault();
        this.#logger.warn('Blocked navigation outside the embedded WeChat allowlist.');
      }
    });

    contents.on('will-redirect', (event) => {
      if (!isAllowedWeChatNavigation(event.url, event.isMainFrame)) {
        event.preventDefault();
        this.#logger.warn('Blocked redirect outside the embedded WeChat allowlist.');
      }
    });

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    contents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      // Electron 43 exposes the modern fields on the first event argument, but
      // keeps the positional values for compatibility. Accept both shapes so a
      // full navigation can never retain an attestation from the previous page.
      const navigationIsMainFrame = details.isMainFrame ?? isMainFrame;
      const navigationIsSameDocument = details.isSameDocument ?? isInPlace;
      if (
        this.#isCurrent(generation, contents)
        && navigationIsMainFrame
        && !navigationIsSameDocument
      ) {
        this.#invalidateRemoteDocument();
        this.#certificateFailureGeneration = null;
        this.#transition('loading');
        this.#armDocumentReadyWatchdog(generation, contents);
      }
    });

    contents.on('dom-ready', () => {
      if (!this.#isCurrent(generation, contents)) {
        return;
      }
      if (!isAllowedWeChatMainFrameUrl(contents.getURL())) {
        contents.stop();
        this.#transition('failed', 'NAVIGATION_BLOCKED');
        return;
      }
      this.#prepareRemoteDocument(contents, generation);
    });

    contents.on('did-finish-load', () => {
      if (!this.#isCurrent(generation, contents)) {
        return;
      }
      if (!isAllowedWeChatMainFrameUrl(contents.getURL())) {
        contents.stop();
        this.#transition('failed', 'NAVIGATION_BLOCKED');
        return;
      }
      this.#prepareRemoteDocument(contents, generation);
    });

    contents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || !this.#isCurrent(generation, contents)) {
        return;
      }
      this.#invalidateRemoteDocument();
      this.#transition(
        'failed',
        this.#certificateFailureGeneration === generation ? 'CERTIFICATE_ERROR' : 'NETWORK_ERROR',
      );
    });

    contents.on('did-navigate', () => {
      if (!this.#isCurrent(generation, contents)) {
        return;
      }
      if (!isAllowedWeChatMainFrameUrl(contents.getURL())) {
        contents.stop();
        this.#transition('failed', 'NAVIGATION_BLOCKED');
        return;
      }
      // did-navigate is the defensive document boundary. Even if a Chromium
      // version omits modern fields on did-start-navigation, a completed main
      // navigation must discard the previous document's CSS and attestation.
      this.#invalidateRemoteDocument();
      this.#certificateFailureGeneration = null;
      this.#transition('loading');
      this.#armDocumentReadyWatchdog(generation, contents);
      if (!contents.isLoading()) {
        this.#prepareRemoteDocument(contents, generation);
      }
    });

    contents.on('did-navigate-in-page', () => {
      if (this.#isCurrent(generation, contents)) {
        this.#emitState();
      }
    });

    contents.on('render-process-gone', () => {
      if (generation === this.#generation && this.#view?.webContents === contents) {
        this.#invalidateRemoteDocument();
        this.#transition('failed', 'RENDERER_CRASHED');
      }
    });

    contents.on('unresponsive', () => {
      if (this.#isCurrent(generation, contents)) {
        this.#invalidateRemoteDocument();
        this.#transition('failed', 'RENDERER_CRASHED');
      }
    });

    contents.on('responsive', () => {
      if (
        this.#isCurrent(generation, contents)
        && this.#state.phase === 'failed'
        && this.#state.errorCode === 'RENDERER_CRASHED'
      ) {
        this.#transition('loading');
        this.#armDocumentReadyWatchdog(generation, contents);
        if (!contents.isLoading()) {
          this.#prepareRemoteDocument(contents, generation);
        }
      }
    });
  }

  #prepareRemoteDocument(contents: WebContents, generation: number): void {
    const sequence = this.#documentSequence;
    if (this.#documentLayoutApplication?.sequence === sequence) {
      return;
    }

    let operation: Promise<string>;
    try {
      operation = applyWeChatDocumentLayout(contents);
    } catch (error) {
      this.#logger.error('Failed to apply the embedded WeChat document layout.', error);
      this.#transition('failed', 'VIEW_UNAVAILABLE');
      return;
    }
    this.#documentLayoutApplication = { sequence, operation };
    void operation
      .then(() => {
        if (
          !this.#isCurrent(generation, contents)
          || sequence !== this.#documentSequence
        ) {
          return;
        }
        if (!isAllowedWeChatMainFrameUrl(contents.getURL())) {
          contents.stop();
          this.#transition('failed', 'NAVIGATION_BLOCKED');
          return;
        }
        this.#transition('ready');
      })
      .catch((error: unknown) => {
        if (!this.#isCurrent(generation, contents) || sequence !== this.#documentSequence) {
          return;
        }
        this.#logger.error('Failed to apply the embedded WeChat document layout.', error);
        this.#transition('failed', 'VIEW_UNAVAILABLE');
      });
  }

  #invalidateRemoteDocument(): void {
    this.#clearDocumentReadyWatchdog();
    ++this.#documentSequence;
    this.#documentLayoutApplication = null;
  }

  #armDocumentReadyWatchdog(generation: number, contents: WebContents): void {
    this.#clearDocumentReadyWatchdog();
    const sequence = this.#documentSequence;
    const timer = setTimeout(() => {
      if (
        this.#isCurrent(generation, contents)
        && sequence === this.#documentSequence
        && this.#state.phase === 'loading'
      ) {
        this.#logger.error('The embedded WeChat document did not become ready before the loading deadline.');
        this.#invalidateRemoteDocument();
        this.#transition('failed', 'NETWORK_ERROR');
      }
    }, WECHAT_DOCUMENT_READY_TIMEOUT_MS);
    timer.unref();
    this.#documentReadyTimer = timer;
  }

  #clearDocumentReadyWatchdog(): void {
    if (this.#documentReadyTimer !== null) {
      clearTimeout(this.#documentReadyTimer);
      this.#documentReadyTimer = null;
    }
  }

  #transition(phase: WeChatState['phase'], errorCode?: WeChatErrorCode): void {
    if (phase !== 'loading') {
      this.#clearDocumentReadyWatchdog();
    }
    const view = this.#getMountedView();
    if (phase !== 'ready' && view !== null) {
      view.setVisible(false);
    }
    this.#state = createWeChatState(
      phase,
      view !== null && phase === 'ready' ? this.#state.visible : false,
      this.#hasSafeBackTarget(),
      errorCode,
    );
    this.#emitState();
    if (phase === 'ready') {
      this.reconcileHostVisibility();
    }
  }

  #getSafeBackTarget(): string | null {
    const view = this.#getMountedView();
    if (view === null) {
      return null;
    }

    const navigationHistory = view.webContents.navigationHistory;
    const activeIndex = navigationHistory.getActiveIndex();
    if (activeIndex <= 0) {
      return null;
    }

    const target = navigationHistory.getAllEntries()[activeIndex - 1];
    return target !== undefined && isAllowedWeChatMainFrameUrl(target.url) ? target.url : null;
  }

  #hasSafeBackTarget(): boolean {
    return this.#getSafeBackTarget() !== null;
  }

  #releaseCurrentView(): void {
    this.#clearDocumentReadyWatchdog();
    const view = this.#view;
    this.#view = null;
    if (view === null) {
      return;
    }

    try {
      this.#hostWindow.contentView.removeChildView(view);
    } catch (error) {
      this.#logger.error('Failed to detach the embedded WeChat surface.', error);
    }

    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch (error) {
      this.#logger.error('Failed to close the embedded WeChat web contents.', error);
    }
  }

  #emitState(): WeChatState {
    const state = this.getState();
    this.#publishState(state);
    return state;
  }
}
