import { describe, expect, it } from 'vitest';
import { shouldIgnoreGameplayKeyEvent, type GameplayKeyboardEvent } from './gameKeyboard';

const event = (overrides: Partial<GameplayKeyboardEvent> = {}): GameplayKeyboardEvent => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  isComposing: false,
  target: null,
  ...overrides,
});

describe('shouldIgnoreGameplayKeyEvent', () => {
  it('allows an unmodified gameplay key from a noninteractive target', () => {
    expect(shouldIgnoreGameplayKeyEvent(event())).toBe(false);
  });

  it('rejects OS modifiers, handled events, and IME composition', () => {
    expect(shouldIgnoreGameplayKeyEvent(event({ altKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ metaKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ defaultPrevented: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ isComposing: true }))).toBe(true);
  });

  it('rejects editable, interactive, and hostile DOM-like targets', () => {
    const matchingTarget = {
      closest: (selector: string) => selector.includes('input') ? ({} as Element) : null,
    } as unknown as EventTarget;
    const contentEditableTarget = { isContentEditable: true } as unknown as EventTarget;
    const hostileTarget = { closest: () => { throw new Error('detached target'); } } as unknown as EventTarget;

    expect(shouldIgnoreGameplayKeyEvent(event({ target: matchingTarget }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ target: contentEditableTarget }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ target: hostileTarget }))).toBe(true);
  });
});
