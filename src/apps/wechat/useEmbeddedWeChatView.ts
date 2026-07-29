import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isWeChatViewState,
  resolveWeChatEmbeddedViewBridge,
  shouldShowWeChatNativeView,
  toWeChatViewBounds,
  type WeChatEmbeddedViewBridge,
  type WeChatViewBounds,
  type WeChatViewState,
} from './bridge';
import { enqueueWeChatBridgeOperation } from './bridgeOperations';

export type WeChatViewAction = 'back' | 'reload' | 'retry';

export interface EmbeddedWeChatViewModel {
  readonly bridgeAvailable: boolean;
  readonly hostState: WeChatViewState;
  readonly commandPending: WeChatViewAction | null;
  readonly errorMessage: string | null;
  readonly surfaceRef: React.RefObject<HTMLDivElement | null>;
  readonly runAction: (action: WeChatViewAction) => Promise<void>;
  readonly requestFocus: () => void;
}

interface UseEmbeddedWeChatViewOptions {
  readonly bridge?: WeChatEmbeddedViewBridge | null;
  readonly isActive: boolean;
  readonly isMinimized: boolean;
}

const INITIAL_STATE: WeChatViewState = Object.freeze({
  phase: 'idle',
  visible: false,
  canGoBack: false,
});

export function useEmbeddedWeChatView({
  bridge: injectedBridge,
  isActive,
  isMinimized,
}: UseEmbeddedWeChatViewOptions): EmbeddedWeChatViewModel {
  const bridge = useMemo(
    () => injectedBridge === undefined ? resolveWeChatEmbeddedViewBridge() : injectedBridge,
    [injectedBridge],
  );
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const activeRef = useRef(isActive);
  const minimizedRef = useRef(isMinimized);
  const stateRef = useRef<WeChatViewState>(INITIAL_STATE);
  const desiredVisibilityRef = useRef<boolean | null>(null);
  const pendingBoundsRef = useRef<WeChatViewBounds | null>(null);
  const boundsSyncRunningRef = useRef(false);
  const boundsSyncTokenRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const lifecycleRef = useRef(0);
  const commandPendingRef = useRef<WeChatViewAction | null>(null);
  const commandTokenRef = useRef(0);
  const [hostState, setHostState] = useState<WeChatViewState>(INITIAL_STATE);
  const [commandPending, setCommandPending] = useState<WeChatViewAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  activeRef.current = isActive;
  minimizedRef.current = isMinimized;

  const acceptState = useCallback((candidate: unknown): candidate is WeChatViewState => {
    if (!isWeChatViewState(candidate)) {
      setErrorMessage('桌面宿主返回了无效的微信视图状态。请重启 AlSniper OS 桌面版。');
      return false;
    }

    const previous = stateRef.current;
    stateRef.current = candidate;
    if (!sameState(previous, candidate)) setHostState(candidate);
    return true;
  }, []);

  const reportBridgeFailure = useCallback(() => {
    setErrorMessage('无法与桌面宿主通信。请重启 AlSniper OS 桌面版后重试。');
  }, []);

  const readBounds = useCallback((): WeChatViewBounds | null => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    return toWeChatViewBounds(
      surface.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    );
  }, []);

  const synchronizeBounds = useCallback(() => {
    if (!bridge || !mountedRef.current) return;
    const bounds = readBounds();
    if (!bounds) return;
    pendingBoundsRef.current = bounds;
    if (boundsSyncRunningRef.current) return;

    boundsSyncRunningRef.current = true;
    const lifecycle = lifecycleRef.current;
    const syncToken = boundsSyncTokenRef.current + 1;
    boundsSyncTokenRef.current = syncToken;
    const drain = async () => {
      while (
        mountedRef.current
        && lifecycleRef.current === lifecycle
        && boundsSyncTokenRef.current === syncToken
        && pendingBoundsRef.current
      ) {
        const nextBounds = pendingBoundsRef.current;
        pendingBoundsRef.current = null;
        try {
          const nextState = await enqueueWeChatBridgeOperation(bridge, () => bridge.setBounds(nextBounds));
          if (
            mountedRef.current
            && lifecycleRef.current === lifecycle
            && boundsSyncTokenRef.current === syncToken
          ) acceptState(nextState);
        } catch {
          if (
            mountedRef.current
            && lifecycleRef.current === lifecycle
            && boundsSyncTokenRef.current === syncToken
          ) reportBridgeFailure();
        }
      }
      if (boundsSyncTokenRef.current === syncToken) boundsSyncRunningRef.current = false;
    };
    void drain();
  }, [acceptState, bridge, readBounds, reportBridgeFailure]);

  const scheduleBoundsSynchronization = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      synchronizeBounds();
    });
  }, [synchronizeBounds]);

  const shouldShowNativeView = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return false;
    const rect = surface.getBoundingClientRect();
    return shouldShowWeChatNativeView({
      phase: stateRef.current.phase,
      isActive: activeRef.current,
      isMinimized: minimizedRef.current,
      documentVisible: document.visibilityState !== 'hidden',
      surfaceWidth: rect.width,
      surfaceHeight: rect.height,
    });
  }, []);

  const synchronizeVisibility = useCallback(() => {
    if (!bridge || !mountedRef.current) return;
    const visible = shouldShowNativeView();
    // desiredVisibilityRef is the renderer's request, while state.visible is
    // the host's authoritative result. A blurred/minimized BrowserWindow may
    // force state.visible=false; do not immediately fight that host decision.
    if (desiredVisibilityRef.current === visible) return;
    desiredVisibilityRef.current = visible;
    const lifecycle = lifecycleRef.current;

    void enqueueWeChatBridgeOperation(bridge, () => bridge.setVisible(visible)).then(
      (nextState) => {
        if (mountedRef.current && lifecycleRef.current === lifecycle) acceptState(nextState);
      },
      () => {
        if (mountedRef.current && lifecycleRef.current === lifecycle) reportBridgeFailure();
      },
    );
  }, [acceptState, bridge, reportBridgeFailure, shouldShowNativeView]);

  const requestFocus = useCallback(() => {
    if (!bridge || !mountedRef.current || !shouldShowNativeView()) return;
    const lifecycle = lifecycleRef.current;
    void enqueueWeChatBridgeOperation(bridge, () => bridge.focus()).then(
      (nextState) => {
        if (mountedRef.current && lifecycleRef.current === lifecycle) acceptState(nextState);
      },
      () => {
        if (mountedRef.current && lifecycleRef.current === lifecycle) reportBridgeFailure();
      },
    );
  }, [acceptState, bridge, reportBridgeFailure, shouldShowNativeView]);

  useEffect(() => {
    if (!bridge) {
      stateRef.current = INITIAL_STATE;
      setHostState(INITIAL_STATE);
      setErrorMessage(null);
      return;
    }

    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    const surface = surfaceRef.current;
    const handleLayoutChange = () => {
      scheduleBoundsSynchronization();
      synchronizeVisibility();
    };
    const handleVisibilityChange = () => synchronizeVisibility();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(handleLayoutChange);

    try {
      unsubscribe = bridge.onState((nextState) => {
        if (disposed || lifecycleRef.current !== lifecycle || !mountedRef.current) return;
        if (acceptState(nextState)) synchronizeVisibility();
      });
    } catch {
      reportBridgeFailure();
    }

    if (surface) resizeObserver?.observe(surface);
    window.addEventListener('resize', handleLayoutChange);
    window.addEventListener('scroll', handleLayoutChange, true);
    document.addEventListener('pointermove', handleLayoutChange);
    document.addEventListener('pointerup', handleLayoutChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.visualViewport?.addEventListener('resize', handleLayoutChange);
    window.visualViewport?.addEventListener('scroll', handleLayoutChange);

    const initialBounds = readBounds() ?? { x: 0, y: 0, width: 1, height: 1 };
    setErrorMessage(null);
    void enqueueWeChatBridgeOperation(bridge, () => bridge.mount(initialBounds)).then(
      async (nextState) => {
        if (disposed || lifecycleRef.current !== lifecycle) return;
        mountedRef.current = true;
        acceptState(nextState);
        synchronizeVisibility();

        // A preload implementation may resolve mount before its first event.
        // getState makes the renderer converge even if that event was missed.
        try {
          const currentState = await enqueueWeChatBridgeOperation(bridge, () => bridge.getState());
          if (!disposed && lifecycleRef.current === lifecycle) acceptState(currentState);
        } catch {
          if (!disposed && lifecycleRef.current === lifecycle) reportBridgeFailure();
        }
        scheduleBoundsSynchronization();
      },
      () => {
        if (!disposed && lifecycleRef.current === lifecycle) reportBridgeFailure();
      },
    );

    return () => {
      disposed = true;
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1;
      mountedRef.current = false;
      boundsSyncTokenRef.current += 1;
      boundsSyncRunningRef.current = false;
      commandTokenRef.current += 1;
      commandPendingRef.current = null;
      setCommandPending(null);
      pendingBoundsRef.current = null;
      desiredVisibilityRef.current = null;
      resizeObserver?.disconnect();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      window.removeEventListener('resize', handleLayoutChange);
      window.removeEventListener('scroll', handleLayoutChange, true);
      document.removeEventListener('pointermove', handleLayoutChange);
      document.removeEventListener('pointerup', handleLayoutChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.visualViewport?.removeEventListener('resize', handleLayoutChange);
      window.visualViewport?.removeEventListener('scroll', handleLayoutChange);
      try {
        unsubscribe();
      } catch {
        // The native view is still unmounted below; listener cleanup is best effort.
      }
      void enqueueWeChatBridgeOperation(bridge, () => bridge.unmount()).catch(() => undefined);
    };
  }, [
    acceptState,
    bridge,
    readBounds,
    reportBridgeFailure,
    scheduleBoundsSynchronization,
    synchronizeVisibility,
  ]);

  useEffect(() => {
    synchronizeVisibility();
  }, [hostState.phase, isActive, isMinimized, synchronizeVisibility]);

  useEffect(() => {
    if (isActive && hostState.phase === 'ready' && hostState.visible) requestFocus();
  }, [hostState.phase, hostState.visible, isActive, requestFocus]);

  const runAction = useCallback(async (action: WeChatViewAction) => {
    if (!bridge || !mountedRef.current || commandPendingRef.current !== null) return;
    const commandToken = commandTokenRef.current + 1;
    commandTokenRef.current = commandToken;
    commandPendingRef.current = action;
    setCommandPending(action);
    setErrorMessage(null);
    try {
      const nextState = await enqueueWeChatBridgeOperation(
        bridge,
        action === 'back' ? () => bridge.goBack() : () => bridge.reload(),
      );
      if (commandTokenRef.current === commandToken && mountedRef.current) {
        acceptState(nextState);
        synchronizeVisibility();
      }
    } catch {
      if (commandTokenRef.current === commandToken && mountedRef.current) reportBridgeFailure();
    } finally {
      if (commandTokenRef.current === commandToken) {
        commandPendingRef.current = null;
        setCommandPending(null);
      }
    }
  }, [acceptState, bridge, reportBridgeFailure, synchronizeVisibility]);

  return {
    bridgeAvailable: bridge !== null,
    hostState,
    commandPending,
    errorMessage,
    surfaceRef,
    runAction,
    requestFocus,
  };
}

function sameState(left: WeChatViewState, right: WeChatViewState): boolean {
  return left.phase === right.phase
    && left.visible === right.visible
    && left.canGoBack === right.canGoBack
    && left.errorCode === right.errorCode;
}
