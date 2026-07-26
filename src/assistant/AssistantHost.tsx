import { Bug, Mic, Sparkles, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AssistantComposer } from './AssistantComposer';
import { AssistantDebugTimeline } from './AssistantDebugTimeline';
import { normalizeAssistantError } from './errors';
import { AssistantSurfaceView } from './AssistantSurfaceView';
import { reduceAssistantDebugTimeline } from './debug';
import {
  appendBounded,
  ASSISTANT_MESSAGE_HISTORY_LIMIT,
  ASSISTANT_RECEIPT_HISTORY_LIMIT,
  retainMostRecent,
} from './history';
import { LabubuAvatar } from './LabubuAvatar';
import { PushToTalkController } from './pushToTalk';
import { createBrowserSpeechPort, type SpeechPort } from './speech';
import { VoiceDisclosurePanel } from './VoiceDisclosurePanel';
import type {
  AssistantActionReceipt,
  AssistantClient,
  AssistantDebugEvent,
  AssistantInputSource,
  AssistantMessage,
  AssistantMood,
  AssistantSurface,
  AssistantSurfaceRenderer,
} from './types';
import {
  readVoiceDisclosureConsent,
  type VoiceDisclosureConsent,
  writeVoiceDisclosureConsent,
} from './voiceDisclosure';
import './assistant.css';

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const ASSISTANT_MODEL_HISTORY_LIMIT = 12;
const ASSISTANT_MODEL_HISTORY_CHARACTERS = 12_000;

const projectConversationHistory = (messages: readonly AssistantMessage[]) => {
  const projected: { role: 'user' | 'assistant'; content: string }[] = [];
  let characters = 0;
  for (const message of messages.slice().reverse()) {
    if (projected.length >= ASSISTANT_MODEL_HISTORY_LIMIT) break;
    const content = message.text.trim().slice(0, 2_000);
    if (!content || characters + content.length > ASSISTANT_MODEL_HISTORY_CHARACTERS) continue;
    characters += content.length;
    projected.push({ role: message.role, content });
  }
  return Object.freeze(projected.reverse().map((entry) => Object.freeze(entry)));
};

interface ReceiptEntry {
  readonly key: string;
  readonly receipt: AssistantActionReceipt;
}

const getBrowserStorage = () => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export interface AssistantHostProps<TSurface = AssistantSurface> {
  readonly client: AssistantClient<TSurface>;
  readonly activeAppId?: string | null;
  readonly activeGame?: boolean;
  readonly modalOpen?: boolean;
  readonly reduceMotion?: boolean;
  readonly speechPort?: SpeechPort;
  readonly renderSurface?: AssistantSurfaceRenderer<TSurface>;
  readonly onSurfaceAction?: (
    intentId: string,
  ) => AssistantActionReceipt | void | Promise<AssistantActionReceipt | void>;
  readonly onOpenChange?: (open: boolean) => void;
  readonly forceCanvasFallback?: boolean;
}

const isDefaultSurface = (value: unknown): value is AssistantSurface => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; nodes?: unknown };
  return typeof candidate.id === 'string' && Array.isArray(candidate.nodes);
};

export function AssistantHost<TSurface = AssistantSurface>({
  client,
  activeAppId = null,
  activeGame = false,
  modalOpen = false,
  reduceMotion = false,
  speechPort,
  renderSurface,
  onSurfaceAction,
  onOpenChange,
  forceCanvasFallback = false,
}: AssistantHostProps<TSurface>) {
  const [threadId] = useState(createId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<readonly AssistantMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: '你好，我是 AlSniper OS 助手。可以让我打开应用、调整系统、安装 Agent，或展示交互界面；使用 /agent <id> <需求> 可明确委托已安装的领域 Agent。',
    },
  ]);
  const [surface, setSurface] = useState<TSurface | null>(null);
  const [receipts, setReceipts] = useState<readonly ReceiptEntry[]>([]);
  const [mood, setMood] = useState<AssistantMood>('idle');
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState('助手已就绪');
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugEvents, dispatchDebugEvent] = useReducer(reduceAssistantDebugTimeline, []);
  const debugEnabledRef = useRef(false);
  const [voiceConsent, setVoiceConsent] = useState<VoiceDisclosureConsent>(() =>
    readVoiceDisclosureConsent(getBrowserStorage()),
  );
  const [voiceDisclosureOpen, setVoiceDisclosureOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const disclosureAcceptRef = useRef<HTMLButtonElement>(null);
  const disclosureReturnFocusRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const voiceFinalRef = useRef('');
  const voiceFailedRef = useRef(false);
  const submitRef = useRef<(text: string, source: AssistantInputSource) => void>(() => undefined);
  const defaultSpeechPort = useMemo(
    () => createBrowserSpeechPort(typeof window === 'undefined' ? undefined : window),
    [],
  );
  const effectiveSpeechPort = speechPort ?? defaultSpeechPort;

  const handleDebugEvent = useCallback((event: AssistantDebugEvent) => {
    dispatchDebugEvent({ type: 'append', event, enabled: debugEnabledRef.current });
  }, []);

  const setPanelOpen = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
      if (!nextOpen) {
        effectiveSpeechPort.cancel();
        setListening(false);
        queueMicrotask(() => buttonRef.current?.focus());
      }
    },
    [effectiveSpeechPort, onOpenChange],
  );

  const openVoiceDisclosure = useCallback(() => {
    disclosureReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setPanelOpen(true);
    setVoiceDisclosureOpen(true);
    setLiveStatus('请先确认语音隐私说明');
  }, [setPanelOpen]);

  useEffect(() => {
    if (!open) return;
    if (voiceDisclosureOpen) disclosureAcceptRef.current?.focus();
    else inputRef.current?.focus();
  }, [open, voiceDisclosureOpen]);

  const submitPrompt = useCallback(
    async (rawText: string, source: AssistantInputSource) => {
      const text = rawText.trim();
      if (!text || pending) return;
      const abortController = new AbortController();
      abortRef.current = abortController;
      setPanelOpen(true);
      setDraft('');
      setError(null);
      setSurface(null);
      setReceipts([]);
      setMessages((current) =>
        appendBounded(
          current,
          { id: createId(), role: 'user', text, source },
          ASSISTANT_MESSAGE_HISTORY_LIMIT,
        ),
      );
      setPending(true);
      setMood('thinking');
      setLiveStatus('Agent 正在思考');

      try {
        const response = await client.run({
          threadId,
          message: text,
          history: projectConversationHistory(messages),
          source,
          context: { activeAppId, activeGame },
          signal: abortController.signal,
          ...(debugEnabled ? { onDebugEvent: handleDebugEvent } : {}),
        });
        if (abortController.signal.aborted) return;
        const responseText = response.message.trim() || '操作已处理。';
        setMessages((current) =>
          appendBounded(
            current,
            { id: createId(), role: 'assistant', text: responseText },
            ASSISTANT_MESSAGE_HISTORY_LIMIT,
          ),
        );
        setSurface(response.surface ?? null);
        setReceipts(
          retainMostRecent(response.receipts ?? [], ASSISTANT_RECEIPT_HISTORY_LIMIT).map(
            (receipt) => ({ key: createId(), receipt }),
          ),
        );
        setMood(response.mood ?? 'speaking');
        setLiveStatus('Agent 已回复');
      } catch (requestError) {
        if (abortController.signal.aborted) {
          setLiveStatus('已取消本次请求');
          return;
        }
        const message = normalizeAssistantError(requestError);
        setError(message);
        setMood('error');
        setLiveStatus(message);
      } finally {
        if (abortRef.current === abortController) {
          abortRef.current = null;
          setPending(false);
        }
      }
    },
    [activeAppId, activeGame, client, debugEnabled, handleDebugEvent, messages, pending, setPanelOpen, threadId],
  );

  submitRef.current = (text, source) => {
    void submitPrompt(text, source);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const controller = new PushToTalkController({
      windowObject: window,
      documentObject: document,
      speechPort: effectiveSpeechPort,
      getContext: () => ({
        activeGame,
        modalOpen: modalOpen || open || voiceDisclosureOpen,
      }),
      canStart: () => {
        if (voiceConsent === 'accepted') return true;
        openVoiceDisclosure();
        return false;
      },
      observer: {
        onInterimTranscript: (text) => {
          setDraft(`${voiceFinalRef.current} ${text}`.trim());
          setLiveStatus(`正在聆听：${text}`);
        },
        onFinalTranscript: (text) => {
          voiceFinalRef.current = `${voiceFinalRef.current} ${text}`.trim();
          setDraft(voiceFinalRef.current);
        },
        onError: (message) => {
          voiceFailedRef.current = true;
          setError(message);
          setMood('error');
          setPanelOpen(true);
          setLiveStatus(message);
        },
        onEnd: () => {
          const transcript = voiceFinalRef.current.trim();
          if (!voiceFailedRef.current && transcript) submitRef.current(transcript, 'voice');
          voiceFinalRef.current = '';
        },
      },
      onListeningChange: (nextListening) => {
        if (nextListening) {
          voiceFinalRef.current = '';
          voiceFailedRef.current = false;
          setError(null);
          setMood('listening');
          setLiveStatus('正在聆听，松开快捷键发送');
        } else {
          setMood((current) => (current === 'listening' ? 'idle' : current));
        }
        setListening(nextListening);
      },
    });
    return () => controller.dispose();
  }, [
    activeGame,
    effectiveSpeechPort,
    modalOpen,
    open,
    openVoiceDisclosure,
    setPanelOpen,
    voiceConsent,
    voiceDisclosureOpen,
  ]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      effectiveSpeechPort.cancel();
    },
    [effectiveSpeechPort],
  );

  useEffect(() => {
    if (mood !== 'speaking') return;
    const timeoutId = window.setTimeout(() => setMood('idle'), 1_800);
    return () => window.clearTimeout(timeoutId);
  }, [mood]);

  const cancelRequest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
    setMood('idle');
    setLiveStatus('已取消本次请求');
  };

  const handlePanelKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setPanelOpen(false);
    }
  };

  const handleSurfaceAction = async (intentId: string) => {
    if (!onSurfaceAction) return;
    try {
      const receipt = await onSurfaceAction(intentId);
      if (receipt) {
        setReceipts((current) =>
          appendBounded(
            current,
            { key: createId(), receipt },
            ASSISTANT_RECEIPT_HISTORY_LIMIT,
          ),
        );
        setLiveStatus(`${receipt.label}：${receipt.detail ?? (receipt.status === 'accepted' ? '已完成' : '未执行')}`);
      }
    } catch (actionError) {
      setReceipts((current) =>
        appendBounded(
          current,
          {
            key: createId(),
            receipt: {
              id: createId(),
              label: '交互操作',
              status: 'failed',
              detail: normalizeAssistantError(actionError),
            },
          },
          ASSISTANT_RECEIPT_HISTORY_LIMIT,
        ),
      );
    }
  };

  const decideVoiceDisclosure = (consent: Exclude<VoiceDisclosureConsent, 'unknown'>) => {
    setVoiceConsent(consent);
    writeVoiceDisclosureConsent(getBrowserStorage(), consent);
    setVoiceDisclosureOpen(false);
    if (consent === 'accepted') {
      setLiveStatus('语音功能已启用，请再次按住快捷键说话');
      setPanelOpen(false);
    } else {
      effectiveSpeechPort.cancel();
      setListening(false);
      setLiveStatus('语音功能未启用，仍可使用文字输入');
      queueMicrotask(() => {
        const target = disclosureReturnFocusRef.current;
        if (target?.isConnected) target.focus();
        else inputRef.current?.focus();
      });
    }
    disclosureReturnFocusRef.current = null;
  };

  const shortcutLabel = activeGame
    ? '游戏中按住 Alt/Option + 空格，或点击助手'
    : '按住空格说话，或点击输入';

  return (
    <aside className="assistant-host" aria-label="AlSniper OS 智能助手">
      <div className="assistant-live-region" role="status" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </div>

      {open ? (
        <section
          className="assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="assistant-panel-title"
          onKeyDown={handlePanelKeyDown}
        >
          <header className="assistant-panel__header" inert={voiceDisclosureOpen || undefined} aria-hidden={voiceDisclosureOpen || undefined}>
            <div>
              <span className="assistant-panel__eyebrow"><Sparkles size={13} /> OS Agent</span>
              <h2 id="assistant-panel-title">AlSniper 助手</h2>
            </div>
            <div className="assistant-panel__header-actions">
              <button
                type="button"
                className={`assistant-debug-toggle${debugEnabled ? ' assistant-debug-toggle--active' : ''}`}
                aria-pressed={debugEnabled}
                aria-controls={debugEnabled ? 'assistant-debug-title' : undefined}
                onClick={() => {
                  const enabled = !debugEnabled;
                  debugEnabledRef.current = enabled;
                  setDebugEnabled(enabled);
                }}
              >
                <Bug size={14} aria-hidden="true" />
                Debug
              </button>
              <button type="button" className="assistant-icon-button" onClick={() => setPanelOpen(false)} aria-label="关闭助手">
                <X size={17} />
              </button>
            </div>
          </header>

          {voiceDisclosureOpen ? (
            <VoiceDisclosurePanel
              acceptButtonRef={disclosureAcceptRef}
              onDecision={decideVoiceDisclosure}
            />
          ) : null}

          {!voiceDisclosureOpen ? (
            <>
              <div className="assistant-messages" aria-label="对话记录">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`assistant-message assistant-message--${message.role}`}
                  >
                    <span>{message.role === 'user' ? '你' : 'Agent'}</span>
                    <p>{message.text}</p>
                  </article>
                ))}
                {pending ? (
                  <div className="assistant-thinking" aria-label="Agent 正在思考">
                    <i /><i /><i />
                  </div>
                ) : null}
              </div>

              {debugEnabled ? (
                <AssistantDebugTimeline
                  events={debugEvents}
                  onClear={() => dispatchDebugEvent({ type: 'clear' })}
                />
              ) : null}

              {surface ? (
                renderSurface ? (
                  renderSurface(surface, (intentId) => void handleSurfaceAction(intentId))
                ) : isDefaultSurface(surface) ? (
                  <AssistantSurfaceView
                    surface={surface}
                    onAction={(intentId) => void handleSurfaceAction(intentId)}
                  />
                ) : (
                  <p className="assistant-error" role="alert">
                    此交互界面需要受信任的系统渲染器。
                  </p>
                )
              ) : null}

              {receipts.length > 0 ? (
                <section className="assistant-receipts" aria-label="系统操作结果">
                  {receipts.map(({ key, receipt }) => (
                    <div
                      key={key}
                      className={`assistant-receipt assistant-receipt--${receipt.status}`}
                    >
                      <strong>{receipt.label}</strong>
                      <span>
                        {receipt.detail ??
                          (receipt.status === 'accepted' ? '已完成' : '未执行')}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}

              {error ? <p className="assistant-error" role="alert">{error}</p> : null}

              <AssistantComposer
                draft={draft}
                pending={pending}
                inputRef={inputRef}
                onDraftChange={setDraft}
                onSubmit={() => void submitPrompt(draft, 'text')}
                onCancel={cancelRequest}
              />

              <p className="assistant-shortcut-hint">
                <Mic size={12} />
                {effectiveSpeechPort.available
                  ? shortcutLabel
                  : '当前浏览器不支持语音识别，可继续使用文字输入'}
                {effectiveSpeechPort.available ? (
                  <button
                    type="button"
                    className="assistant-voice-privacy-link"
                    onClick={openVoiceDisclosure}
                  >
                    语音隐私
                  </button>
                ) : null}
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      <div className={`assistant-orb assistant-orb--${mood}`}>
        {listening ? <span className="assistant-orb__listening-ring" aria-hidden="true" /> : null}
        <button
          ref={buttonRef}
          type="button"
          className="assistant-avatar-button"
          aria-label={open ? '关闭 AlSniper 助手' : '打开 AlSniper 助手'}
          aria-expanded={open}
          disabled={voiceDisclosureOpen}
          onClick={() => setPanelOpen(!open)}
        >
          <LabubuAvatar mood={mood} reduceMotion={reduceMotion} forceFallback={forceCanvasFallback} />
        </button>
        <span className="assistant-orb__badge" aria-hidden="true"><Sparkles size={13} /></span>
      </div>
    </aside>
  );
}
