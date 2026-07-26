import { describe, expect, it, vi } from 'vitest';
import type { SpeechObserver, SpeechPort } from './speech';
import {
  isAssistantPushToTalkShortcut,
  PushToTalkController,
  type AssistantShortcutContext,
} from './pushToTalk';

const keyboardEvent = (patch: Partial<KeyboardEvent> = {}) =>
  ({
    code: 'Space',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    preventDefault: vi.fn(),
    ...patch,
  }) as unknown as KeyboardEvent;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.listeners.get(type)?.delete(callback);
  }

  dispatch(type: string, event: Event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

class FakeSpeechPort implements SpeechPort {
  readonly available = true;
  starts = 0;
  stops = 0;
  cancels = 0;
  observer: SpeechObserver | null = null;

  start(observer: SpeechObserver) {
    this.starts += 1;
    this.observer = observer;
  }

  stop() {
    this.stops += 1;
  }

  cancel() {
    this.cancels += 1;
    this.observer = null;
  }
}

describe('assistant push-to-talk routing', () => {
  it('uses Space on the desktop but never steals plain Space from an active game', () => {
    const desktop: AssistantShortcutContext = { activeGame: false, modalOpen: false };
    const game: AssistantShortcutContext = { activeGame: true, modalOpen: false };
    expect(isAssistantPushToTalkShortcut(keyboardEvent(), desktop)).toBe(true);
    expect(isAssistantPushToTalkShortcut(keyboardEvent(), game)).toBe(false);
    expect(isAssistantPushToTalkShortcut(keyboardEvent({ altKey: true }), game)).toBe(true);
  });

  it('ignores editable, composing, repeated, and modal key events', () => {
    const context = { activeGame: false, modalOpen: false };
    expect(
      isAssistantPushToTalkShortcut(
        keyboardEvent({ target: { tagName: 'INPUT' } as unknown as EventTarget }),
        context,
      ),
    ).toBe(false);
    expect(isAssistantPushToTalkShortcut(keyboardEvent({ isComposing: true }), context)).toBe(false);
    expect(isAssistantPushToTalkShortcut(keyboardEvent({ repeat: true }), context)).toBe(false);
    expect(
      isAssistantPushToTalkShortcut(keyboardEvent(), { ...context, modalOpen: true }),
    ).toBe(false);
  });

  it('starts on keydown, stops on keyup, and cancels on blur and disposal', () => {
    const windowTarget = new FakeEventTarget();
    const documentTarget = new FakeEventTarget() as FakeEventTarget & { visibilityState: string };
    documentTarget.visibilityState = 'visible';
    const speech = new FakeSpeechPort();
    const listening: boolean[] = [];
    const controller = new PushToTalkController({
      windowObject: windowTarget as unknown as Window,
      documentObject: documentTarget as unknown as Document,
      speechPort: speech,
      getContext: () => ({ activeGame: false, modalOpen: false }),
      observer: {
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
      onListeningChange: (value) => listening.push(value),
    });

    windowTarget.dispatch('keydown', keyboardEvent() as unknown as Event);
    windowTarget.dispatch('keyup', keyboardEvent() as unknown as Event);
    expect(speech.starts).toBe(1);
    expect(speech.stops).toBe(1);
    expect(listening).toEqual([true]);

    windowTarget.dispatch('blur', new Event('blur'));
    expect(speech.cancels).toBe(1);
    expect(listening).toEqual([true, false]);

    controller.dispose();
    expect(speech.cancels).toBe(2);
    windowTarget.dispatch('keydown', keyboardEvent() as unknown as Event);
    expect(speech.starts).toBe(1);
  });

  it('does not access the microphone until the disclosure gate permits it', () => {
    const windowTarget = new FakeEventTarget();
    const documentTarget = new FakeEventTarget() as FakeEventTarget & { visibilityState: string };
    documentTarget.visibilityState = 'visible';
    const speech = new FakeSpeechPort();
    let accepted = false;
    const onListeningChange = vi.fn();
    const controller = new PushToTalkController({
      windowObject: windowTarget as unknown as Window,
      documentObject: documentTarget as unknown as Document,
      speechPort: speech,
      getContext: () => ({ activeGame: false, modalOpen: false }),
      canStart: () => accepted,
      observer: {
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
      },
      onListeningChange,
    });

    windowTarget.dispatch('keydown', keyboardEvent() as unknown as Event);
    expect(speech.starts).toBe(0);
    expect(onListeningChange).not.toHaveBeenCalled();

    accepted = true;
    windowTarget.dispatch('keydown', keyboardEvent() as unknown as Event);
    expect(speech.starts).toBe(1);

    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatch('visibilitychange', new Event('visibilitychange'));
    expect(speech.cancels).toBe(1);
    expect(onListeningChange).toHaveBeenLastCalledWith(false);

    controller.dispose();
  });
});
