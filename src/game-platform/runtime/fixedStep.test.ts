import { describe, expect, it } from 'vitest';
import { RATIONAL_STEP_60_HZ, consumeFixedSteps, getStepMilliseconds } from './fixedStep';

describe('parameterized rational fixed-step clock', () => {
  it('produces identical 60 Hz work for equivalent elapsed-time partitions', () => {
    const whole = consumeFixedSteps(0, 2_000);
    const first = consumeFixedSteps(0, 1_000);
    const second = consumeFixedSteps(first.remainderUnits, 1_000);

    expect(whole).toEqual({ steps: 120, remainderUnits: 0 });
    expect(first.steps + second.steps).toBe(whole.steps);
    expect(second.remainderUnits).toBe(whole.remainderUnits);
    expect(getStepMilliseconds(RATIONAL_STEP_60_HZ)).toBeCloseTo(1000 / 60, 12);
  });

  it('supports arbitrary rational step durations', () => {
    const step120Hz = { durationNumeratorMs: 1_000, durationDenominator: 120 } as const;
    const first = consumeFixedSteps(0, 4, step120Hz);
    const second = consumeFixedSteps(first.remainderUnits, 6, step120Hz);

    expect(first).toEqual({ steps: 0, remainderUnits: 480 });
    expect(second).toEqual({ steps: 1, remainderUnits: 200 });
  });

  it('preserves sub-step time until a complete tick is available', () => {
    const first = consumeFixedSteps(0, 10);
    const second = consumeFixedSteps(first.remainderUnits, 20 / 3);

    expect(first.steps).toBe(0);
    expect(second).toEqual({ steps: 1, remainderUnits: 0 });
  });

  it.each([
    [Number.NaN, 1, RATIONAL_STEP_60_HZ, TypeError],
    [0, Number.POSITIVE_INFINITY, RATIONAL_STEP_60_HZ, TypeError],
    [-1, 1, RATIONAL_STEP_60_HZ, RangeError],
    [0, -1, RATIONAL_STEP_60_HZ, RangeError],
    [1_000, 1, RATIONAL_STEP_60_HZ, RangeError],
    [0, 1, { durationNumeratorMs: 0, durationDenominator: 60 }, RangeError],
    [0, 1, { durationNumeratorMs: 1_000, durationDenominator: 1.5 }, RangeError],
  ])('rejects invalid clock input %#', (remainder, elapsed, step, errorType) => {
    expect(() => consumeFixedSteps(remainder as number, elapsed as number, step as typeof RATIONAL_STEP_60_HZ)).toThrow(
      errorType as typeof Error,
    );
  });
});
