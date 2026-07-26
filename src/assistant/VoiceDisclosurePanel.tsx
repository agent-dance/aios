import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { VoiceDisclosureConsent } from './voiceDisclosure';

interface VoiceDisclosurePanelProps {
  readonly acceptButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onDecision: (consent: Exclude<VoiceDisclosureConsent, 'unknown'>) => void;
}

export function VoiceDisclosurePanel({
  acceptButtonRef,
  onDecision,
}: VoiceDisclosurePanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const declineButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
        acceptButtonRef.current?.focus();
      }
    };
    const blockBackgroundPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        acceptButtonRef.current?.focus();
      }
    };
    document.addEventListener('focusin', keepFocusInside, true);
    document.addEventListener('pointerdown', blockBackgroundPointer, true);
    return () => {
      document.removeEventListener('focusin', keepFocusInside, true);
      document.removeEventListener('pointerdown', blockBackgroundPointer, true);
    };
  }, [acceptButtonRef]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDecision('declined');
      return;
    }
    if (event.key !== 'Tab') return;
    const first = declineButtonRef.current;
    const last = acceptButtonRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section
      ref={panelRef}
      className="assistant-voice-disclosure"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="assistant-voice-disclosure-title"
      aria-describedby="assistant-voice-disclosure-description"
      onKeyDown={trapFocus}
    >
      <span className="assistant-voice-disclosure__trust">
        <ShieldCheck size={14} /> 系统隐私确认 · 非 Agent 生成内容
      </span>
      <h3 id="assistant-voice-disclosure-title">启用语音输入前请确认</h3>
      <p id="assistant-voice-disclosure-description">
        Web Speech 语音识别可能将麦克风音频交由浏览器、操作系统或其语音服务处理。
        AlSniper OS 不保存音频；识别文字只保留在当前打开的有界对话中，并可能随后续请求作为最近上下文发送，关闭或刷新后不会由本应用持久化。
      </p>
      <div className="assistant-voice-disclosure__actions">
        <button ref={declineButtonRef} type="button" onClick={() => onDecision('declined')}>
          暂不启用
        </button>
        <button
          ref={acceptButtonRef}
          type="button"
          className="assistant-voice-disclosure__accept"
          onClick={() => onDecision('accepted')}
        >
          我已了解并启用
        </button>
      </div>
    </section>
  );
}
