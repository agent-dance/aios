import { useEffect, useRef } from 'react';

export const RENDER_GAME_TO_TEXT_GLOBAL = 'render_game_to_text' as const;
export const ADVANCE_TIME_GLOBAL = 'advanceTime' as const;
export const VIRTUAL_TIME_MARKER = '__vt_pending' as const;
/**
 * Matches the runtime's default 240 fixed steps at 60 Hz (four seconds).
 * Kept explicit here so the browser adapter does not depend on the runtime.
 */
export const DEFAULT_ADVANCE_TIME_BUDGET_MS = 4_000;

export interface GameAutomationTarget {
  render_game_to_text?: () => string;
  advanceTime?: (milliseconds: number) => void;
  __vt_pending?: unknown;
}

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (milliseconds: number) => void;
    __vt_pending?: unknown;
  }
}

export interface GameAutomationBridgeOptions {
  readonly target: GameAutomationTarget;
  readonly renderGameToText: () => string;
  readonly advanceTime: (milliseconds: number) => void;
  readonly onManualClockRequested?: () => void;
  /** Maximum virtual duration accepted by one host call. */
  readonly maxAdvanceTimeMilliseconds?: number;
}

export interface GameAutomationBridge {
  readonly manualClockRequestedAtInstall: boolean;
  dispose(): void;
}

type AutomationRegistration = {
  readonly render: () => string;
  readonly advance: (milliseconds: number) => void;
  active: boolean;
};

type SavedProperty = {
  readonly existed: boolean;
  readonly value: unknown;
};

type TargetRegistry = {
  readonly savedRender: SavedProperty;
  readonly savedAdvance: SavedProperty;
  readonly registrations: AutomationRegistration[];
};

const registries = new WeakMap<object, TargetRegistry>();

function saveProperty(target: GameAutomationTarget, key: typeof RENDER_GAME_TO_TEXT_GLOBAL | typeof ADVANCE_TIME_GLOBAL): SavedProperty {
  return { existed: Object.prototype.hasOwnProperty.call(target, key), value: target[key] };
}

function restoreProperty(
  target: GameAutomationTarget,
  key: typeof RENDER_GAME_TO_TEXT_GLOBAL | typeof ADVANCE_TIME_GLOBAL,
  saved: SavedProperty,
  installedValue: unknown,
): void {
  // A host page or a newer, unrelated owner may replace either hook. Never
  // remove or overwrite a value that is no longer one of ours.
  if (target[key] !== installedValue) return;

  if (saved.existed) {
    Object.assign(target, { [key]: saved.value });
  } else {
    delete target[key];
  }
}

export function normalizeAdvanceTimeBudget(maximum: number | undefined): number {
  return maximum !== undefined && Number.isFinite(maximum) && maximum >= 0
    ? maximum
    : DEFAULT_ADVANCE_TIME_BUDGET_MS;
}

export function normalizeAdvanceTime(
  milliseconds: number,
  maximum = DEFAULT_ADVANCE_TIME_BUDGET_MS,
): number | null {
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= maximum ? milliseconds : null;
}

export function hasVirtualTimeMarker(target: Pick<GameAutomationTarget, '__vt_pending'>): boolean {
  return VIRTUAL_TIME_MARKER in target;
}

export function installGameAutomationBridge(options: GameAutomationBridgeOptions): GameAutomationBridge {
  const { target } = options;
  const maxAdvanceTimeMilliseconds = normalizeAdvanceTimeBudget(options.maxAdvanceTimeMilliseconds);
  let registry = registries.get(target);
  if (!registry) {
    registry = {
      savedRender: saveProperty(target, RENDER_GAME_TO_TEXT_GLOBAL),
      savedAdvance: saveProperty(target, ADVANCE_TIME_GLOBAL),
      registrations: [],
    };
    registries.set(target, registry);
  }

  const manualClockRequestedAtInstall = hasVirtualTimeMarker(target);
  if (manualClockRequestedAtInstall) options.onManualClockRequested?.();

  const registration: AutomationRegistration = {
    active: true,
    render: () => options.renderGameToText(),
    advance: (milliseconds) => {
      const safeMilliseconds = normalizeAdvanceTime(milliseconds, maxAdvanceTimeMilliseconds);
      if (safeMilliseconds === null) return;
      options.onManualClockRequested?.();
      options.advanceTime(safeMilliseconds);
    },
  };
  registry.registrations.push(registration);
  target.render_game_to_text = registration.render;
  target.advanceTime = registration.advance;

  let disposed = false;
  return {
    manualClockRequestedAtInstall,
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.active = false;

      const currentRegistry = registries.get(target);
      if (currentRegistry !== registry) return;
      const replacement = [...registry.registrations].reverse().find((candidate) => candidate.active);

      if (replacement) {
        if (target.render_game_to_text === registration.render) target.render_game_to_text = replacement.render;
        if (target.advanceTime === registration.advance) target.advanceTime = replacement.advance;
        return;
      }

      restoreProperty(target, RENDER_GAME_TO_TEXT_GLOBAL, registry.savedRender, registration.render);
      restoreProperty(target, ADVANCE_TIME_GLOBAL, registry.savedAdvance, registration.advance);
      registries.delete(target);
    },
  };
}

export interface UseGameAutomationBridgeOptions {
  readonly enabled?: boolean;
  readonly target?: GameAutomationTarget | null;
  readonly renderGameToText: () => string;
  readonly advanceTime: (milliseconds: number) => void;
  readonly onManualClockRequested?: () => void;
  readonly maxAdvanceTimeMilliseconds?: number;
}

export function resolveGameAutomationTarget(
  injected: GameAutomationTarget | null | undefined,
  ambient: GameAutomationTarget | null,
): GameAutomationTarget | null {
  return injected === undefined ? ambient : injected;
}

/** Installs stable automation globals while always calling the latest React callbacks. */
export function useGameAutomationBridge(options: UseGameAutomationBridgeOptions): void {
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const target = resolveGameAutomationTarget(
    options.target,
    typeof window === 'undefined' ? null : window,
  );
  const enabled = options.enabled ?? true;
  const maxAdvanceTimeMilliseconds = normalizeAdvanceTimeBudget(options.maxAdvanceTimeMilliseconds);

  useEffect(() => {
    if (!enabled || !target) return undefined;
    const bridge = installGameAutomationBridge({
      target,
      renderGameToText: () => callbacksRef.current.renderGameToText(),
      advanceTime: (milliseconds) => callbacksRef.current.advanceTime(milliseconds),
      onManualClockRequested: () => callbacksRef.current.onManualClockRequested?.(),
      maxAdvanceTimeMilliseconds,
    });
    return () => bridge.dispose();
  }, [enabled, maxAdvanceTimeMilliseconds, target]);
}
