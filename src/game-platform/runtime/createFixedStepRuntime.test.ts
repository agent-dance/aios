import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DEFAULT_MAX_STEPS_PER_ADVANCE,
  FixedStepBudgetExceededError,
  createFixedStepRuntime,
  type FixedStepRuntime,
} from './createFixedStepRuntime';

interface CounterState {
  value: number;
  ticks: number[];
}

interface CounterInput {
  direction: number;
}

const createCounterRuntime = (onPublish?: Parameters<typeof createFixedStepRuntime<CounterState, CounterInput>>[0]['onPublish']) =>
  createFixedStepRuntime<CounterState, CounterInput>({
    createInitialState: () => ({ value: 0, ticks: [] }),
    createInitialInput: () => ({ direction: 1 }),
    simulate: (state, input, context) => ({
      value: state.value + input.direction,
      ticks: [...state.ticks, context.tick],
    }),
    onPublish,
  });

describe('createFixedStepRuntime', () => {
  it('advances a deterministic simulation and publishes once per batch', () => {
    const onPublish = vi.fn();
    const runtime = createCounterRuntime(onPublish);

    expect(runtime.advance(10)).toMatchObject({ steps: 0, state: { value: 0, ticks: [] } });
    expect(onPublish).not.toHaveBeenCalled();

    const result = runtime.advance(90);
    expect(result.steps).toBe(6);
    expect(result.state).toEqual({ value: 6, ticks: [1, 2, 3, 4, 5, 6] });
    expect(result.clock).toEqual({ tick: 6, simulationTimeMs: 100, remainderUnits: 0 });
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenLastCalledWith(result.state, {
      reason: 'advance',
      steps: 6,
      input: { direction: 1 },
      clock: result.clock,
    });
  });

  it('keeps the standard two-second 60 Hz automation interval within the default budget', () => {
    const runtime = createCounterRuntime();
    const result = runtime.advance(2_000);

    expect(DEFAULT_MAX_STEPS_PER_ADVANCE).toBeGreaterThanOrEqual(120);
    expect(result.steps).toBe(120);
    expect(result.clock.tick).toBe(120);
  });

  it('rejects over-budget work before simulation and preserves the complete clock/state snapshot', () => {
    const simulate = vi.fn((state: number) => state + 1);
    const runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate,
      maxStepsPerAdvance: 2,
    });
    runtime.advance(10);
    const before = runtime.getSnapshot();

    expect(() => runtime.advance(100)).toThrow(FixedStepBudgetExceededError);
    expect(runtime.getSnapshot()).toEqual(before);
    expect(simulate).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid synchronous step budget: %s',
    (maxStepsPerAdvance) => {
      expect(() =>
        createFixedStepRuntime({
          createInitialState: () => 0,
          createInitialInput: () => null,
          simulate: (state) => state,
          maxStepsPerAdvance,
        }),
      ).toThrow(RangeError);
    },
  );

  it('copies and freezes fixed-step scalars at construction time', () => {
    const step = { durationNumeratorMs: 1_000, durationDenominator: 60 };
    const runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate: (state) => state + 1,
      step,
    });

    step.durationDenominator = 1;
    expect(runtime.advance(1_000).steps).toBe(60);
  });

  it('uses the current input snapshot and supports explicit state/input/clock resets', () => {
    const runtime = createCounterRuntime();
    runtime.replaceInput({ direction: -2 });
    runtime.advance(1000 / 60);
    expect(runtime.getState().value).toBe(-2);

    runtime.replaceState({ value: 40, ticks: [] });
    runtime.advance(1000 / 60);
    expect(runtime.getState().value).toBe(38);
    expect(runtime.getClock().tick).toBe(2);

    runtime.resetClock();
    expect(runtime.getClock()).toEqual({ tick: 0, simulationTimeMs: 0, remainderUnits: 0 });
    expect(runtime.getState().value).toBe(38);

    runtime.resetInput();
    expect(runtime.getInput()).toEqual({ direction: 1 });

    runtime.reset({ state: { value: 9, ticks: [99] }, input: { direction: 3 } });
    expect(runtime.getSnapshot()).toEqual({
      state: { value: 9, ticks: [99] },
      input: { direction: 3 },
      clock: { tick: 0, simulationTimeMs: 0, remainderUnits: 0 },
    });

    runtime.reset();
    expect(runtime.getState()).toEqual({ value: 0, ticks: [] });
    expect(runtime.getInput()).toEqual({ direction: 1 });
  });

  it('commits a multi-step batch atomically when simulation throws', () => {
    const failure = new Error('simulation failed');
    const runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate: (state, _input, context) => {
        if (context.tick === 3) throw failure;
        return state + 1;
      },
    });

    expect(() => runtime.advance(100)).toThrow(failure);
    expect(runtime.getState()).toBe(0);
    expect(runtime.getClock()).toEqual({ tick: 0, simulationTimeMs: 0, remainderUnits: 0 });
  });

  it('blocks stateful runtime operations from a simulation callback', () => {
    let runtime: FixedStepRuntime<number, null>;
    runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate: (state) => {
        runtime.replaceState(99);
        return state + 1;
      },
    });

    expect(() => runtime.advance(1000 / 60)).toThrow('cannot run from inside the simulation callback');
    expect(runtime.getState()).toBe(0);
  });

  it('isolates publish failures after commit and rejects publish-observer reentry', () => {
    const publishFailure = new Error('render subscriber failed');
    const onPublishError = vi.fn();
    let runtime: FixedStepRuntime<number, null>;
    runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate: (state) => state + 1,
      onPublish: () => {
        runtime.advance(1000 / 60);
        throw publishFailure;
      },
      onPublishError,
    });

    const result = runtime.advance(1000 / 60);
    expect(result).toMatchObject({ state: 1, steps: 1, clock: { tick: 1 } });
    expect(runtime.getState()).toBe(1);
    expect(onPublishError).toHaveBeenCalledTimes(1);
    expect(onPublishError.mock.calls[0]?.[0]).toMatchObject({
      error: expect.objectContaining({ message: 'advance cannot run from inside the publish observer.' }),
      state: 1,
      metadata: { reason: 'advance', steps: 1 },
    });
  });

  it('never lets publish or publish-diagnostic exceptions make a committed mutation appear to fail', () => {
    const runtime = createFixedStepRuntime({
      createInitialState: () => 0,
      createInitialInput: () => null,
      simulate: (state) => state + 1,
      onPublish: () => {
        throw new Error('publish failed');
      },
      onPublishError: () => {
        throw new Error('diagnostic failed');
      },
    });

    expect(runtime.advance(1000 / 60)).toMatchObject({ state: 1, steps: 1 });
    expect(runtime.replaceState(4)).toMatchObject({ state: 4 });
    expect(runtime.reset({ state: 9 })).toMatchObject({ state: 9 });
  });

  it('exposes transferred values by reference through an explicit shallow read-only contract', () => {
    const initialState = { nested: { value: 1 } };
    const initialInput = { direction: 1 };
    let stateSeenBySimulation: Readonly<typeof initialState> | undefined;
    const runtime = createFixedStepRuntime({
      createInitialState: () => initialState,
      createInitialInput: () => initialInput,
      simulate: (state) => {
        stateSeenBySimulation = state;
        return { nested: { value: state.nested.value + 1 } };
      },
    });

    expectTypeOf(runtime.getState()).toEqualTypeOf<Readonly<typeof initialState>>();
    expectTypeOf(runtime.getInput()).toEqualTypeOf<Readonly<typeof initialInput>>();
    expect(runtime.getState()).toBe(initialState);
    expect(runtime.getInput()).toBe(initialInput);
    expect(Object.isFrozen(runtime.getState())).toBe(false);
    runtime.advance(1000 / 60);
    expect(stateSeenBySimulation).toBe(initialState);
  });

  it('supports undefined as an intentional state or input reset value', () => {
    const runtime = createFixedStepRuntime<number | undefined, string | undefined>({
      createInitialState: () => 1,
      createInitialInput: () => 'active',
      simulate: (state) => state,
    });
    runtime.reset({ state: undefined, input: undefined });
    expect(runtime.getState()).toBeUndefined();
    expect(runtime.getInput()).toBeUndefined();
  });
});
