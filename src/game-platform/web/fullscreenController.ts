import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface FullscreenElementTarget {
  requestFullscreen?: () => Promise<void>;
}

export interface FullscreenDocumentTarget {
  readonly fullscreenElement?: unknown | null;
  readonly fullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface FullscreenSnapshot {
  readonly supported: boolean;
  readonly active: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}

export interface FullscreenController {
  getSnapshot(): FullscreenSnapshot;
  refresh(): void;
  enter(): Promise<boolean>;
  exit(): Promise<boolean>;
  toggle(): Promise<boolean>;
  clearError(): void;
  subscribe(listener: (snapshot: FullscreenSnapshot) => void): () => void;
  dispose(): void;
}

export function isFullscreenCapable(
  documentTarget: FullscreenDocumentTarget | null,
  element: FullscreenElementTarget | null,
): boolean {
  return Boolean(
    documentTarget &&
    element &&
    documentTarget.fullscreenEnabled !== false &&
    typeof documentTarget.exitFullscreen === 'function' &&
    typeof element.requestFullscreen === 'function',
  );
}

function readFullscreenElement(getElement: () => FullscreenElementTarget | null): FullscreenElementTarget | null {
  try {
    return getElement();
  } catch {
    return null;
  }
}

function isTargetFullscreen(
  documentTarget: FullscreenDocumentTarget | null,
  element: FullscreenElementTarget | null,
): boolean {
  return element !== null && documentTarget?.fullscreenElement === element;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Fullscreen request failed';
}

export function createFullscreenController(
  documentTarget: FullscreenDocumentTarget | null,
  getElement: () => FullscreenElementTarget | null,
): FullscreenController {
  const getCurrentElement = () => readFullscreenElement(getElement);
  let disposed = false;
  let operation: Promise<boolean> | null = null;
  const initialElement = getCurrentElement();
  let snapshot: FullscreenSnapshot = {
    supported: isFullscreenCapable(documentTarget, initialElement),
    active: isTargetFullscreen(documentTarget, initialElement),
    pending: false,
    error: null,
  };
  const listeners = new Set<(next: FullscreenSnapshot) => void>();

  const publish = (patch: Partial<FullscreenSnapshot>) => {
    if (disposed) return;
    const next = { ...snapshot, ...patch };
    if (
      next.supported === snapshot.supported && next.active === snapshot.active &&
      next.pending === snapshot.pending && next.error === snapshot.error
    ) return;
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };

  const refresh = () => {
    const element = getCurrentElement();
    publish({
      supported: isFullscreenCapable(documentTarget, element),
      active: isTargetFullscreen(documentTarget, element),
    });
  };

  const onFullscreenChange = () => refresh();
  const onFullscreenError = () => publish({ pending: false, error: 'Fullscreen request failed' });
  documentTarget?.addEventListener('fullscreenchange', onFullscreenChange);
  documentTarget?.addEventListener('fullscreenerror', onFullscreenError);

  const run = (action: () => Promise<void>): Promise<boolean> => {
    if (operation) return operation;
    publish({ pending: true, error: null });
    let result: Promise<void>;
    try {
      // Fullscreen entry must run synchronously inside the user activation
      // handler. Catching here preserves that requirement without leaking
      // exceptions from browser shims.
      result = Promise.resolve(action());
    } catch (error: unknown) {
      publish({ pending: false, error: errorMessage(error) });
      operation = Promise.resolve(false).finally(() => {
        operation = null;
      });
      return operation;
    }
    operation = result
      .then(() => {
        refresh();
        publish({ pending: false });
        return true;
      })
      .catch((error: unknown) => {
        publish({ pending: false, error: errorMessage(error) });
        return false;
      })
      .finally(() => {
        operation = null;
      });
    return operation;
  };

  const unsupported = (): Promise<boolean> => {
    refresh();
    publish({ error: 'Fullscreen is not supported' });
    return Promise.resolve(false);
  };

  const occupied = (): Promise<boolean> => {
    refresh();
    publish({ error: 'Another element is already fullscreen' });
    return Promise.resolve(false);
  };

  const enter = () => {
    const element = getCurrentElement();
    if (isTargetFullscreen(documentTarget, element)) {
      refresh();
      return Promise.resolve(true);
    }
    if (documentTarget?.fullscreenElement != null) return occupied();
    if (!isFullscreenCapable(documentTarget, element) || !element?.requestFullscreen) return unsupported();
    const requestFullscreen = element.requestFullscreen.bind(element);
    return run(requestFullscreen);
  };

  const exit = () => {
    const element = getCurrentElement();
    if (!isTargetFullscreen(documentTarget, element)) {
      refresh();
      return Promise.resolve(true);
    }
    if (!documentTarget?.exitFullscreen) return unsupported();
    const exitFullscreen = documentTarget.exitFullscreen.bind(documentTarget);
    return run(exitFullscreen);
  };

  return {
    getSnapshot: () => snapshot,
    refresh,
    enter,
    exit,
    toggle: () => isTargetFullscreen(documentTarget, getCurrentElement()) ? exit() : enter(),
    clearError: () => publish({ error: null }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      documentTarget?.removeEventListener('fullscreenchange', onFullscreenChange);
      documentTarget?.removeEventListener('fullscreenerror', onFullscreenError);
      listeners.clear();
    },
  };
}

export type FullscreenTargetSource =
  | RefObject<FullscreenElementTarget | null>
  | (() => FullscreenElementTarget | null);

export interface UseFullscreenControllerOptions {
  readonly target: FullscreenTargetSource;
  readonly document?: FullscreenDocumentTarget | null;
}

export interface UseFullscreenControllerResult extends FullscreenSnapshot {
  refresh(): void;
  enter(): Promise<boolean>;
  exit(): Promise<boolean>;
  toggle(): Promise<boolean>;
  clearError(): void;
}

function resolveTarget(source: FullscreenTargetSource): FullscreenElementTarget | null {
  try {
    return typeof source === 'function' ? source() : source.current;
  } catch {
    return null;
  }
}

export function resolveFullscreenDocumentTarget(
  injected: FullscreenDocumentTarget | null | undefined,
  ambient: FullscreenDocumentTarget | null,
): FullscreenDocumentTarget | null {
  return injected === undefined ? ambient : injected;
}

export function useFullscreenController(options: UseFullscreenControllerOptions): UseFullscreenControllerResult {
  const controllerRef = useRef<FullscreenController | null>(null);
  const targetSourceRef = useRef(options.target);
  targetSourceRef.current = options.target;
  const documentTarget = resolveFullscreenDocumentTarget(
    options.document,
    typeof document === 'undefined' ? null : document,
  );
  const [snapshot, setSnapshot] = useState<FullscreenSnapshot>(() => {
    const element = resolveTarget(options.target);
    return {
      supported: isFullscreenCapable(documentTarget, element),
      active: isTargetFullscreen(documentTarget, element),
      pending: false,
      error: null,
    };
  });

  useEffect(() => {
    const controller = createFullscreenController(documentTarget, () => resolveTarget(targetSourceRef.current));
    controllerRef.current = controller;
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.refresh();
    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [documentTarget]);

  // RefObject.current changes are not React dependencies, and callers often
  // pass inline resolver functions. Refresh after each commit to observe both
  // without repeatedly rebuilding event subscriptions.
  useEffect(() => {
    controllerRef.current?.refresh();
  });

  const refresh = useCallback(() => controllerRef.current?.refresh(), []);
  const enter = useCallback(() => controllerRef.current?.enter() ?? Promise.resolve(false), []);
  const exit = useCallback(() => controllerRef.current?.exit() ?? Promise.resolve(false), []);
  const toggle = useCallback(() => controllerRef.current?.toggle() ?? Promise.resolve(false), []);
  const clearError = useCallback(() => controllerRef.current?.clearError(), []);

  return { ...snapshot, refresh, enter, exit, toggle, clearError };
}
