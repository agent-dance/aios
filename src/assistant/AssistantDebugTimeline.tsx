import { Trash2 } from 'lucide-react';
import { describeAssistantDebugEvent } from './debug';
import type { AssistantDebugEvent } from './types';

export interface AssistantDebugTimelineProps {
  readonly events: readonly AssistantDebugEvent[];
  readonly onClear: () => void;
}

const label = (value: string) => value.replaceAll('-', ' ');

export function AssistantDebugTimeline({ events, onClear }: AssistantDebugTimelineProps) {
  const current = events.at(-1);
  return (
    <section className="assistant-debug" aria-labelledby="assistant-debug-title">
      <header className="assistant-debug__header">
        <div>
          <h3 id="assistant-debug-title">Agent Debug</h3>
          <p
            className="assistant-debug__summary"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {current ? describeAssistantDebugEvent(current) : 'Waiting for the next traced request'}
          </p>
        </div>
        <button
          type="button"
          className="assistant-debug__clear"
          onClick={onClear}
          disabled={events.length === 0}
          aria-label="Clear Agent Debug timeline"
        >
          <Trash2 size={13} aria-hidden="true" />
          Clear
        </button>
      </header>

      <ol
        className="assistant-debug__timeline"
        aria-label="Agent Debug event timeline"
        role="log"
        aria-relevant="additions text"
      >
        {events.length === 0 ? (
          <li className="assistant-debug__empty">Trace events will appear here in real time.</li>
        ) : events.map((event, index) => (
          <li
            key={`${index}-${event.source}-${event.stage}-${event.status}-${event.elapsedMs}`}
            className={`assistant-debug__event assistant-debug__event--${event.status}`}
          >
            <div className="assistant-debug__event-heading">
              <strong>{event.title}</strong>
              <time dateTime={`PT${Math.max(0, Math.round(event.elapsedMs)) / 1_000}S`}>
                {Math.max(0, Math.round(event.elapsedMs))} ms
              </time>
            </div>
            <div className="assistant-debug__badges" aria-label="Trace classification">
              <span>{label(event.source)}</span>
              <span>{label(event.stage)}</span>
              <span>{label(event.status)}</span>
            </div>
            {event.detail ? <p>{event.detail}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
