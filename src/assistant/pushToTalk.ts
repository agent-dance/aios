import type { SpeechObserver, SpeechPort } from './speech';

export interface AssistantShortcutContext {
  readonly activeGame: boolean;
  readonly modalOpen: boolean;
}

export interface ShortcutKeyEvent {
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly target: EventTarget | null;
}

const isEditableTarget = (target: EventTarget | null) => {
  const candidate = target as {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
    getAttribute?(name: string): string | null;
  } | null;
  if (!candidate) return false;
  const tagName = candidate.tagName?.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    candidate.isContentEditable === true ||
    candidate.getAttribute?.('role') === 'textbox'
  );
};

export const isAssistantPushToTalkShortcut = (
  event: ShortcutKeyEvent,
  context: AssistantShortcutContext,
) => {
  if (
    event.code !== 'Space' ||
    event.ctrlKey ||
    event.metaKey ||
    event.repeat ||
    event.isComposing ||
    context.modalOpen ||
    isEditableTarget(event.target)
  ) {
    return false;
  }
  return context.activeGame ? event.altKey : !event.altKey;
};

export interface PushToTalkControllerOptions {
  readonly windowObject: Window;
  readonly documentObject: Document;
  readonly speechPort: SpeechPort;
  readonly getContext: () => AssistantShortcutContext;
  readonly observer: SpeechObserver;
  readonly onListeningChange: (listening: boolean) => void;
  readonly canStart?: () => boolean;
}

export class PushToTalkController {
  private listening = false;
  private disposed = false;

  constructor(private readonly options: PushToTalkControllerOptions) {
    options.windowObject.addEventListener('keydown', this.handleKeyDown);
    options.windowObject.addEventListener('keyup', this.handleKeyUp);
    options.windowObject.addEventListener('blur', this.handleRelease);
    options.documentObject.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private readonly setListening = (listening: boolean) => {
    if (this.listening === listening) return;
    this.listening = listening;
    this.options.onListeningChange(listening);
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (
      this.disposed ||
      !isAssistantPushToTalkShortcut(event, this.options.getContext())
    ) {
      return;
    }
    event.preventDefault();
    if (this.options.canStart && !this.options.canStart()) return;
    this.setListening(true);
    this.options.speechPort.start({
      ...this.options.observer,
      onEnd: () => {
        this.setListening(false);
        this.options.observer.onEnd();
      },
    });
  };

  private readonly handleKeyUp = (event: KeyboardEvent) => {
    if (event.code !== 'Space' || !this.listening) return;
    event.preventDefault();
    this.options.speechPort.stop();
  };

  private readonly handleVisibilityChange = () => {
    if (this.options.documentObject.visibilityState === 'hidden') this.cancel();
  };

  private readonly handleRelease = () => this.cancel();

  cancel() {
    this.options.speechPort.cancel();
    this.setListening(false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.options.windowObject.removeEventListener('keydown', this.handleKeyDown);
    this.options.windowObject.removeEventListener('keyup', this.handleKeyUp);
    this.options.windowObject.removeEventListener('blur', this.handleRelease);
    this.options.documentObject.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.cancel();
  }
}
