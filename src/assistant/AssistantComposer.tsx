import { Send, Square } from 'lucide-react';
import type { FormEvent, RefObject } from 'react';

interface AssistantComposerProps {
  readonly draft: string;
  readonly pending: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onDraftChange: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

export function AssistantComposer({
  draft,
  pending,
  inputRef,
  onDraftChange,
  onSubmit,
  onCancel,
}: AssistantComposerProps) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="assistant-composer" onSubmit={handleSubmit}>
      <label htmlFor="assistant-prompt" className="assistant-sr-only">
        向 AlSniper 助手输入消息
      </label>
      <input
        ref={inputRef}
        id="assistant-prompt"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="让 Agent 帮你完成任务…"
        disabled={pending}
        autoComplete="off"
      />
      {pending ? (
        <button type="button" onClick={onCancel} aria-label="取消 Agent 请求">
          <Square size={15} fill="currentColor" />
        </button>
      ) : (
        <button type="submit" disabled={!draft.trim()} aria-label="发送消息">
          <Send size={16} />
        </button>
      )}
    </form>
  );
}
