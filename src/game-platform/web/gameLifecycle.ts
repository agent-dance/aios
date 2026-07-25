import { useEffect, useRef, useState } from 'react';

export type GameSuspensionReason = 'inactive' | 'blurred' | 'hidden';

export interface GameLifecycleState {
  readonly active: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
}

export interface GameLifecycleSnapshot extends GameLifecycleState {
  readonly suspended: boolean;
  readonly reasons: readonly GameSuspensionReason[];
}

export interface GameLifecyclePolicy {
  readonly suspendOnInactive?: boolean;
  readonly suspendOnBlur?: boolean;
  readonly suspendWhenHidden?: boolean;
  readonly resetInputOnSuspend?: boolean;
  readonly resetInputOnResume?: boolean;
}

export interface GameLifecycleCallbacks {
  readonly onResetInput?: () => void;
  /** Clear a frame timestamp/accumulator at both suspension boundaries. */
  readonly onResetClock?: () => void;
  readonly onSuspend?: (snapshot: GameLifecycleSnapshot) => void;
  readonly onResume?: (snapshot: GameLifecycleSnapshot) => void;
}

export interface GameLifecycleController {
  getSnapshot(): GameLifecycleSnapshot;
  /** Runs initial suspension callbacks once. Safe to call repeatedly. */
  initialize(): void;
  setActive(active: boolean): void;
  setFocused(focused: boolean): void;
  setVisible(visible: boolean): void;
  configure(policy: GameLifecyclePolicy): void;
  subscribe(listener: (snapshot: GameLifecycleSnapshot) => void): () => void;
}

export interface GameLifecycleControllerOptions {
  /** Allows React effects to initialize without render-phase callbacks. */
  readonly deferInitialCallbacks?: boolean;
}

const DEFAULT_POLICY: Required<GameLifecyclePolicy> = {
  suspendOnInactive: true,
  suspendOnBlur: true,
  suspendWhenHidden: true,
  resetInputOnSuspend: true,
  resetInputOnResume: false,
};

function completePolicy(policy: GameLifecyclePolicy): Required<GameLifecyclePolicy> {
  return {
    suspendOnInactive: policy.suspendOnInactive ?? DEFAULT_POLICY.suspendOnInactive,
    suspendOnBlur: policy.suspendOnBlur ?? DEFAULT_POLICY.suspendOnBlur,
    suspendWhenHidden: policy.suspendWhenHidden ?? DEFAULT_POLICY.suspendWhenHidden,
    resetInputOnSuspend: policy.resetInputOnSuspend ?? DEFAULT_POLICY.resetInputOnSuspend,
    resetInputOnResume: policy.resetInputOnResume ?? DEFAULT_POLICY.resetInputOnResume,
  };
}

export function deriveGameLifecycleSnapshot(
  state: GameLifecycleState,
  policy: GameLifecyclePolicy = {},
): GameLifecycleSnapshot {
  const complete = completePolicy(policy);
  const reasons: GameSuspensionReason[] = [];
  if (complete.suspendOnInactive && !state.active) reasons.push('inactive');
  if (complete.suspendOnBlur && !state.focused) reasons.push('blurred');
  if (complete.suspendWhenHidden && !state.visible) reasons.push('hidden');
  return { ...state, suspended: reasons.length > 0, reasons };
}

export function createGameLifecycleController(
  initialState: GameLifecycleState,
  policy: GameLifecyclePolicy = {},
  callbacks: GameLifecycleCallbacks = {},
  options: GameLifecycleControllerOptions = {},
): GameLifecycleController {
  let state = { ...initialState };
  let complete = completePolicy(policy);
  let snapshot = deriveGameLifecycleSnapshot(state, complete);
  let initialized = false;
  const listeners = new Set<(next: GameLifecycleSnapshot) => void>();

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    if (!snapshot.suspended) return;
    if (complete.resetInputOnSuspend) callbacks.onResetInput?.();
    callbacks.onResetClock?.();
    callbacks.onSuspend?.(snapshot);
  };

  const update = (nextState: GameLifecycleState, nextPolicy = complete) => {
    const previous = snapshot;
    state = nextState;
    complete = completePolicy(nextPolicy);
    const next = deriveGameLifecycleSnapshot(state, complete);
    const changed =
      previous.active !== next.active || previous.focused !== next.focused || previous.visible !== next.visible ||
      previous.reasons.join('|') !== next.reasons.join('|');
    if (!changed) return;
    snapshot = next;

    if (initialized && !previous.suspended && next.suspended) {
      if (complete.resetInputOnSuspend) callbacks.onResetInput?.();
      callbacks.onResetClock?.();
      callbacks.onSuspend?.(next);
    } else if (initialized && previous.suspended && !next.suspended) {
      if (complete.resetInputOnResume) callbacks.onResetInput?.();
      // Discard elapsed wall time before real-time simulation resumes.
      callbacks.onResetClock?.();
      callbacks.onResume?.(next);
    }
    listeners.forEach((listener) => listener(next));
  };

  const controller: GameLifecycleController = {
    getSnapshot: () => snapshot,
    initialize,
    setActive: (active) => update({ ...state, active }),
    setFocused: (focused) => update({ ...state, focused }),
    setVisible: (visible) => update({ ...state, visible }),
    configure: (nextPolicy) => update(state, completePolicy(nextPolicy)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  if (!options.deferInitialCallbacks) initialize();
  return controller;
}

export interface LifecycleEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface LifecycleDocumentTarget extends LifecycleEventTarget {
  readonly visibilityState?: DocumentVisibilityState;
  hasFocus?(): boolean;
}

export interface UseGameLifecycleOptions extends GameLifecyclePolicy, GameLifecycleCallbacks {
  readonly active: boolean;
  readonly targetWindow?: LifecycleEventTarget | null;
  readonly targetDocument?: LifecycleDocumentTarget | null;
}

function policyFromOptions(options: UseGameLifecycleOptions): GameLifecyclePolicy {
  return {
    suspendOnInactive: options.suspendOnInactive,
    suspendOnBlur: options.suspendOnBlur,
    suspendWhenHidden: options.suspendWhenHidden,
    resetInputOnSuspend: options.resetInputOnSuspend,
    resetInputOnResume: options.resetInputOnResume,
  };
}

export function resolveLifecycleTarget<T>(injected: T | null | undefined, ambient: T | null): T | null {
  return injected === undefined ? ambient : injected;
}

export function readLifecycleDocumentState(target: LifecycleDocumentTarget | null): Pick<GameLifecycleState, 'focused' | 'visible'> {
  let focused = true;
  try {
    focused = target?.hasFocus?.() ?? true;
  } catch {
    focused = true;
  }
  return { focused, visible: target?.visibilityState !== 'hidden' };
}

/**
 * Converts shell activity, browser focus and Page Visibility into one game
 * suspension signal. The clock reset callback must clear real-time remainder.
 */
export function useGameLifecycle(options: UseGameLifecycleOptions): GameLifecycleSnapshot {
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const targetWindow = resolveLifecycleTarget(
    options.targetWindow,
    typeof window === 'undefined' ? null : window,
  );
  const targetDocument = resolveLifecycleTarget(
    options.targetDocument,
    typeof document === 'undefined' ? null : document,
  );

  const controllerRef = useRef<GameLifecycleController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createGameLifecycleController(
      { active: options.active, ...readLifecycleDocumentState(targetDocument) },
      policyFromOptions(options),
      {
        onResetInput: () => callbacksRef.current.onResetInput?.(),
        onResetClock: () => callbacksRef.current.onResetClock?.(),
        onSuspend: (next) => callbacksRef.current.onSuspend?.(next),
        onResume: (next) => callbacksRef.current.onResume?.(next),
      },
      { deferInitialCallbacks: true },
    );
  }
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState<GameLifecycleSnapshot>(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    const handleBlur = () => controller.setFocused(false);
    const handleFocus = () => controller.setFocused(true);
    const handleVisibility = () => controller.setVisible(readLifecycleDocumentState(targetDocument).visible);
    targetWindow?.addEventListener('blur', handleBlur);
    targetWindow?.addEventListener('focus', handleFocus);
    targetDocument?.addEventListener('visibilitychange', handleVisibility);

    const documentState = readLifecycleDocumentState(targetDocument);
    controller.setFocused(documentState.focused);
    controller.setVisible(documentState.visible);
    controller.initialize();
    setSnapshot(controller.getSnapshot());

    return () => {
      unsubscribe();
      targetWindow?.removeEventListener('blur', handleBlur);
      targetWindow?.removeEventListener('focus', handleFocus);
      targetDocument?.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [controller, targetDocument, targetWindow]);

  useEffect(() => {
    controller.setActive(options.active);
  }, [controller, options.active]);

  useEffect(() => {
    controller.configure(policyFromOptions(options));
  }, [
    controller,
    options.resetInputOnResume,
    options.resetInputOnSuspend,
    options.suspendOnBlur,
    options.suspendOnInactive,
    options.suspendWhenHidden,
  ]);

  return snapshot;
}
