import { describe, expect, it } from 'vitest';
import { createFixedStepRuntime } from '../runtime';
import { createTimeline, replayTimeline } from './timeline';

describe('input timeline replay', () => {
  const createRuntime = () =>
    createFixedStepRuntime({
      createInitialState: () => ({ position: 0, directions: [] as number[] }),
      createInitialInput: () => ({ direction: 0 }),
      simulate: (state, input) => ({
        position: state.position + input.direction,
        directions: [...state.directions, input.direction],
      }),
      step: { durationNumeratorMs: 100, durationDenominator: 1 },
    });

  it('applies each input from its exact timestamp onward', () => {
    const timeline = createTimeline(500, [
      { atMs: 0, input: { direction: 1 } },
      { atMs: 200, input: { direction: -1 } },
      { atMs: 400, input: { direction: 0 } },
    ]);
    const result = replayTimeline(createRuntime(), timeline);

    expect(result.eventsApplied).toBe(3);
    expect(result.snapshot.state).toEqual({ position: 0, directions: [1, 1, -1, -1, 0] });
    expect(result.snapshot.clock.tick).toBe(5);
  });

  it('preserves event order at a shared timestamp', () => {
    const timeline = createTimeline(100, [
      { atMs: 0, input: { direction: 1 } },
      { atMs: 0, input: { direction: 4 } },
    ]);
    expect(replayTimeline(createRuntime(), timeline).snapshot.state.position).toBe(4);
  });

  it('rejects unordered, out-of-range and invalid timeline times', () => {
    expect(() => createTimeline(100, [{ atMs: 101, input: null }])).toThrow('must not exceed');
    expect(() =>
      createTimeline(100, [
        { atMs: 50, input: null },
        { atMs: 49, input: null },
      ]),
    ).toThrow('ordered');
    expect(() => createTimeline(Number.NaN, [])).toThrow(TypeError);
  });
});
