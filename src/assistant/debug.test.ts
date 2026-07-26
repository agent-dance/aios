import { describe, expect, it } from 'vitest';
import {
  describeAssistantDebugEvent,
  normalizeAssistantDebugEvent,
  reduceAssistantDebugTimeline,
} from './debug';
import type { AssistantDebugEvent } from './types';

const eventFor = (index: number): AssistantDebugEvent => ({
  kind: 'trace',
  source: index % 2 === 0 ? 'runtime' : 'sidecar',
  stage: 'analysis',
  status: 'info',
  title: `event-${index}`,
  elapsedMs: index,
});

describe('Assistant Debug timeline model', () => {
  it('retains the newest 200 live events in chronological order', () => {
    const events = Array.from({ length: 205 }, (_, index) => eventFor(index)).reduce(
      (current, event) => reduceAssistantDebugTimeline(current, { type: 'append', event, enabled: true }),
      [] as readonly AssistantDebugEvent[],
    );

    expect(events).toHaveLength(200);
    expect(events[0]?.title).toBe('event-5');
    expect(events.at(-1)?.title).toBe('event-204');
  });

  it('clears the session timeline and creates a concise live summary', () => {
    const event = eventFor(3);
    const populated = reduceAssistantDebugTimeline([], { type: 'append', event, enabled: true });

    expect(describeAssistantDebugEvent(event)).toBe('event-3 · info · 3 ms');
    expect(reduceAssistantDebugTimeline(populated, { type: 'clear' })).toEqual([]);
  });

  it('ignores late events as soon as Debug is disabled', () => {
    const existing = [eventFor(1)];
    expect(reduceAssistantDebugTimeline(existing, {
      type: 'append',
      event: eventFor(2),
      enabled: false,
    })).toBe(existing);
  });

  it('normalizes bounded scalar fields and ignores untrusted invalid events', () => {
    const normalized = normalizeAssistantDebugEvent({
      ...eventFor(1),
      title: `  ${'t'.repeat(100)}  `,
      detail: `  ${'d'.repeat(300)}  `,
      elapsedMs: 900_000.8,
      traceId: 'allowed-extra-sidecar-metadata',
    });
    expect(normalized).toMatchObject({
      title: 't'.repeat(80),
      detail: 'd'.repeat(240),
      elapsedMs: 600_000,
    });

    const existing = [eventFor(1)];
    for (const invalid of [
      null,
      { ...eventFor(2), kind: 'raw-chain-of-thought' },
      { ...eventFor(2), source: 'attacker-controlled-class' },
      { ...eventFor(2), status: 'unknown' },
      { ...eventFor(2), title: '   ' },
      { ...eventFor(2), elapsedMs: Number.NaN },
      { ...eventFor(2), detail: { secret: true } },
    ]) {
      expect(reduceAssistantDebugTimeline(existing, {
        type: 'append',
        event: invalid,
        enabled: true,
      })).toBe(existing);
    }
  });
});
