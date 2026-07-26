export interface GameplayKeyboardEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing?: boolean;
  readonly target: EventTarget | null;
}

const INTERACTIVE_KEYBOARD_TARGETS =
  'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])';

/**
 * Fail-closed filter for window- or container-level gameplay shortcuts.
 * Release handlers may still clear a key that the game previously latched,
 * but an unrelated editor/OS key must never acquire a gameplay capability.
 */
export function shouldIgnoreGameplayKeyEvent(event: GameplayKeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  if (!target || typeof target !== 'object') return false;
  const candidate = target as EventTarget & {
    readonly isContentEditable?: boolean;
    closest?: (selectors: string) => Element | null;
  };
  if (candidate.isContentEditable === true) return true;
  if (typeof candidate.closest !== 'function') return false;
  try {
    return candidate.closest(INTERACTIVE_KEYBOARD_TARGETS) !== null;
  } catch {
    return true;
  }
}
