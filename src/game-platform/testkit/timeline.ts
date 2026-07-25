import type { FixedStepRuntime, RuntimeSnapshot } from '../runtime';

export interface TimelineEvent<Input> {
  readonly atMs: number;
  readonly input: Input;
}

export interface InputTimeline<Input> {
  readonly durationMs: number;
  readonly events: readonly TimelineEvent<Input>[];
}

const assertTimelineTime = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
  if (value < 0) throw new RangeError(`${name} must be non-negative.`);
};

/** Validates and freezes the timeline structure; input snapshots remain caller-owned. */
export const createTimeline = <Input>(
  durationMs: number,
  events: readonly TimelineEvent<Input>[],
): InputTimeline<Input> => {
  assertTimelineTime(durationMs, 'durationMs');
  let previousTime = 0;
  const copiedEvents = events.map((event, index) => {
    assertTimelineTime(event.atMs, `events[${index}].atMs`);
    if (event.atMs < previousTime) {
      throw new RangeError('Timeline events must be ordered by non-decreasing atMs.');
    }
    if (event.atMs > durationMs) {
      throw new RangeError(`events[${index}].atMs must not exceed durationMs.`);
    }
    previousTime = event.atMs;
    return Object.freeze({ atMs: event.atMs, input: event.input });
  });
  return Object.freeze({ durationMs, events: Object.freeze(copiedEvents) });
};

export interface TimelineReplayResult<State, Input> {
  readonly snapshot: RuntimeSnapshot<State, Input>;
  readonly eventsApplied: number;
}

/**
 * Replays input changes at exact timeline boundaries. Time before an event is
 * always simulated with the previous input; the event input applies from its
 * timestamp onward.
 */
export const replayTimeline = <State, Input>(
  runtime: Pick<FixedStepRuntime<State, Input>, 'advance' | 'replaceInput' | 'getSnapshot'>,
  timeline: InputTimeline<Input>,
): TimelineReplayResult<State, Input> => {
  let cursorMs = 0;
  for (const event of timeline.events) {
    runtime.advance(event.atMs - cursorMs);
    runtime.replaceInput(event.input);
    cursorMs = event.atMs;
  }
  runtime.advance(timeline.durationMs - cursorMs);
  return { snapshot: runtime.getSnapshot(), eventsApplied: timeline.events.length };
};
