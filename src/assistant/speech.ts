export interface SpeechObserver {
  onInterimTranscript(text: string): void;
  onFinalTranscript(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}

export interface SpeechPort {
  readonly available: boolean;
  start(observer: SpeechObserver): void;
  stop(): void;
  cancel(): void;
}

interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

type SpeechWindow = Window & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

const describeSpeechError = (error: string, message?: string) => {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return '麦克风权限未开启，请允许访问后重试。';
  }
  if (error === 'no-speech') {
    return '没有听清，请按住快捷键后再说一次。';
  }
  if (error === 'audio-capture') {
    return '没有检测到可用的麦克风。';
  }
  return message?.trim() || '语音识别暂时不可用，请改用文字输入。';
};

export class BrowserSpeechPort implements SpeechPort {
  readonly available: boolean;
  private recognition: BrowserSpeechRecognition | null = null;

  constructor(
    private readonly windowObject: SpeechWindow,
    private readonly locale = 'zh-CN',
  ) {
    this.available = Boolean(
      windowObject.SpeechRecognition ?? windowObject.webkitSpeechRecognition,
    );
  }

  start(observer: SpeechObserver) {
    this.cancel();
    const Recognition =
      this.windowObject.SpeechRecognition ?? this.windowObject.webkitSpeechRecognition;
    if (!Recognition) {
      observer.onError('此浏览器不支持语音识别，请点击助手并输入文字。');
      observer.onEnd();
      return;
    }

    const recognition = new Recognition();
    recognition.lang = this.locale;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim() ?? '';
        if (!transcript) continue;
        if (result?.isFinal) final += `${transcript} `;
        else interim += `${transcript} `;
      }
      if (interim.trim()) observer.onInterimTranscript(interim.trim());
      if (final.trim()) observer.onFinalTranscript(final.trim());
    };
    recognition.onerror = (event) => {
      observer.onError(describeSpeechError(event.error, event.message));
    };
    recognition.onend = () => {
      if (this.recognition === recognition) this.recognition = null;
      observer.onEnd();
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      observer.onError(error instanceof Error ? error.message : '无法启动语音识别。');
      observer.onEnd();
    }
  }

  stop() {
    try {
      this.recognition?.stop();
    } catch {
      this.cancel();
    }
  }

  cancel() {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // The browser may already have ended the recognition session.
    }
  }
}

export const createBrowserSpeechPort = (windowObject?: Window): SpeechPort => {
  if (!windowObject) {
    return {
      available: false,
      start(observer) {
        observer.onError('此浏览器不支持语音识别，请点击助手并输入文字。');
        observer.onEnd();
      },
      stop() {},
      cancel() {},
    };
  }
  return new BrowserSpeechPort(windowObject as SpeechWindow);
};
