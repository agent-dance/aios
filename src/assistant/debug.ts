import type { AssistantDebugEvent } from './types';
import { appendBounded, ASSISTANT_DEBUG_EVENT_LIMIT } from './history';

const DEBUG_SOURCES = new Set<AssistantDebugEvent['source']>(['sidecar', 'runtime', 'broker']);
const DEBUG_STAGES = new Set<AssistantDebugEvent['stage']>([
  'request',
  'analysis',
  'decision',
  'authorization',
  'completion',
]);
const DEBUG_STATUSES = new Set<AssistantDebugEvent['status']>(['started', 'completed', 'info', 'failed']);
const DEBUG_TITLE_LIMIT = 80;
const DEBUG_DETAIL_LIMIT = 240;
const DEBUG_ELAPSED_LIMIT_MS = 600_000;

export const normalizeAssistantDebugEvent = (value: unknown): AssistantDebugEvent | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  if (
    event.kind !== 'trace' ||
    typeof event.source !== 'string' ||
    !DEBUG_SOURCES.has(event.source as AssistantDebugEvent['source']) ||
    typeof event.stage !== 'string' ||
    !DEBUG_STAGES.has(event.stage as AssistantDebugEvent['stage']) ||
    typeof event.status !== 'string' ||
    !DEBUG_STATUSES.has(event.status as AssistantDebugEvent['status']) ||
    typeof event.title !== 'string' ||
    typeof event.elapsedMs !== 'number' ||
    !Number.isFinite(event.elapsedMs) ||
    (event.detail !== undefined && typeof event.detail !== 'string')
  ) {
    return undefined;
  }
  const title = event.title.trim().slice(0, DEBUG_TITLE_LIMIT);
  if (!title) return undefined;
  const detail = typeof event.detail === 'string'
    ? event.detail.trim().slice(0, DEBUG_DETAIL_LIMIT)
    : undefined;
  return Object.freeze({
    kind: 'trace',
    source: event.source as AssistantDebugEvent['source'],
    stage: event.stage as AssistantDebugEvent['stage'],
    status: event.status as AssistantDebugEvent['status'],
    title,
    ...(detail ? { detail } : {}),
    elapsedMs: Math.min(DEBUG_ELAPSED_LIMIT_MS, Math.max(0, Math.round(event.elapsedMs))),
  });
};

export const appendAssistantDebugEvent = (
  events: readonly AssistantDebugEvent[],
  event: AssistantDebugEvent,
): readonly AssistantDebugEvent[] => {
  return appendBounded(events, event, ASSISTANT_DEBUG_EVENT_LIMIT);
};

export type AssistantDebugTimelineAction =
  | { readonly type: 'append'; readonly event: unknown; readonly enabled: boolean }
  | { readonly type: 'clear' };

export const reduceAssistantDebugTimeline = (
  events: readonly AssistantDebugEvent[],
  action: AssistantDebugTimelineAction,
): readonly AssistantDebugEvent[] => {
  if (action.type === 'clear') return [];
  if (!action.enabled) return events;
  const event = normalizeAssistantDebugEvent(action.event);
  return event ? appendAssistantDebugEvent(events, event) : events;
};

export const describeAssistantDebugEvent = (event: AssistantDebugEvent): string =>
  `${event.title} · ${event.status} · ${Math.max(0, Math.round(event.elapsedMs))} ms`;
