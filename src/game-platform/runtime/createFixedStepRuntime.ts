import {
  RATIONAL_STEP_60_HZ,
  assertValidFixedStep,
  consumeFixedSteps,
  getStepMilliseconds,
  type RationalFixedStep,
} from './fixedStep';

export interface FixedStepContext {
  /** One-based tick being produced by this simulation call. */
  readonly tick: number;
  readonly deltaMs: number;
  /** Exact simulated time at the end of this tick. */
  readonly simulationTimeMs: number;
}

/**
 * A compile-time, shallow read-only view of a runtime-owned value.
 *
 * The runtime deliberately does not clone or recursively freeze game values.
 * Factories and replacement methods transfer ownership of their returned or
 * supplied values to the runtime. Callers and simulation functions must not
 * mutate a transferred value in place; return a new state value to commit a
 * change. Violating this ownership contract also voids batch atomicity.
 */
export type RuntimeValueView<Value> = Readonly<Value>;

export type FixedStepSimulation<State, Input> = (
  state: RuntimeValueView<State>,
  input: RuntimeValueView<Input>,
  context: FixedStepContext,
) => State;

export interface RuntimeClock {
  readonly tick: number;
  readonly simulationTimeMs: number;
  readonly remainderUnits: number;
}

export interface RuntimeSnapshot<State, Input> {
  readonly state: RuntimeValueView<State>;
  readonly input: RuntimeValueView<Input>;
  readonly clock: RuntimeClock;
}

export type PublishReason = 'advance' | 'replace-state' | 'reset';

export interface PublishMetadata<Input> {
  readonly reason: PublishReason;
  readonly steps: number;
  readonly input: RuntimeValueView<Input>;
  readonly clock: RuntimeClock;
}

export interface PublishFailure<State, Input> {
  readonly error: unknown;
  readonly state: RuntimeValueView<State>;
  readonly metadata: PublishMetadata<Input>;
}

export const DEFAULT_MAX_STEPS_PER_ADVANCE = 240;

export interface CreateFixedStepRuntimeOptions<State, Input> {
  readonly createInitialState: () => State;
  readonly createInitialInput: () => Input;
  readonly simulate: FixedStepSimulation<State, Input>;
  readonly step?: RationalFixedStep;
  /**
   * Maximum synchronous simulation work accepted by one `advance` call.
   * Defaults to 240 ticks (four seconds at 60 Hz). Exceeding the budget throws
   * before simulation or clock/state mutation begins.
   */
  readonly maxStepsPerAdvance?: number;
  /**
   * Called once after a committed batch, never once per individual tick.
   * Stateful runtime operations are forbidden from this observer. Observer
   * exceptions never escape the committing operation and are sent to
   * `onPublishError` when supplied.
   */
  readonly onPublish?: (state: RuntimeValueView<State>, metadata: PublishMetadata<Input>) => void;
  /**
   * Receives an `onPublish` exception after the associated state is committed.
   * This diagnostic observer must not throw or call stateful runtime methods;
   * either violation is isolated from the already-successful commit.
   */
  readonly onPublishError?: (failure: PublishFailure<State, Input>) => void;
}

export interface ResetRuntimeOptions<State, Input> {
  readonly state?: State;
  readonly input?: Input;
}

export interface AdvanceResult<State, Input> extends RuntimeSnapshot<State, Input> {
  readonly steps: number;
}

export interface FixedStepRuntime<State, Input> {
  /** Returns the runtime-owned value by reference as a shallow read-only view. */
  getState(): RuntimeValueView<State>;
  /** Returns the runtime-owned value by reference as a shallow read-only view. */
  getInput(): RuntimeValueView<Input>;
  getClock(): RuntimeClock;
  getSnapshot(): RuntimeSnapshot<State, Input>;
  advance(elapsedMs: number): AdvanceResult<State, Input>;
  replaceState(state: State): RuntimeSnapshot<State, Input>;
  replaceInput(input: Input): RuntimeSnapshot<State, Input>;
  reset(options?: ResetRuntimeOptions<State, Input>): RuntimeSnapshot<State, Input>;
  resetClock(): RuntimeSnapshot<State, Input>;
  resetInput(): RuntimeSnapshot<State, Input>;
}

const freezeClock = (tick: number, simulationTimeMs: number, remainderUnits: number): RuntimeClock =>
  Object.freeze({ tick, simulationTimeMs, remainderUnits });

const assertPositiveSafeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
};

export class FixedStepBudgetExceededError extends RangeError {
  readonly requestedSteps: number;
  readonly maxSteps: number;

  constructor(requestedSteps: number, maxSteps: number) {
    super(`advance requires ${requestedSteps} fixed steps, exceeding the configured budget of ${maxSteps}.`);
    this.name = 'FixedStepBudgetExceededError';
    this.requestedSteps = requestedSteps;
    this.maxSteps = maxSteps;
  }
}

export const createFixedStepRuntime = <State, Input>(
  options: CreateFixedStepRuntimeOptions<State, Input>,
): FixedStepRuntime<State, Input> => {
  if (typeof options.createInitialState !== 'function') {
    throw new TypeError('createInitialState must be a function.');
  }
  if (typeof options.createInitialInput !== 'function') {
    throw new TypeError('createInitialInput must be a function.');
  }
  if (typeof options.simulate !== 'function') {
    throw new TypeError('simulate must be a function.');
  }

  const configuredStep = options.step ?? RATIONAL_STEP_60_HZ;
  assertValidFixedStep(configuredStep);
  // Snapshot the scalar configuration so a caller mutating its original
  // options object cannot change the runtime's clock halfway through a run.
  const step: RationalFixedStep = Object.freeze({
    durationNumeratorMs: configuredStep.durationNumeratorMs,
    durationDenominator: configuredStep.durationDenominator,
  });
  const maxStepsPerAdvance = options.maxStepsPerAdvance ?? DEFAULT_MAX_STEPS_PER_ADVANCE;
  assertPositiveSafeInteger(maxStepsPerAdvance, 'maxStepsPerAdvance');
  const deltaMs = getStepMilliseconds(step);

  let state = options.createInitialState();
  let input = options.createInitialInput();
  let tick = 0;
  let remainderUnits = 0;
  let isAdvancing = false;
  let isPublishing = false;

  const getClock = (): RuntimeClock => freezeClock(tick, tick * deltaMs, remainderUnits);
  const getSnapshot = (): RuntimeSnapshot<State, Input> => Object.freeze({ state, input, clock: getClock() });

  const assertCanMutate = (operation: string) => {
    if (isAdvancing) {
      throw new Error(`${operation} cannot run from inside the simulation callback.`);
    }
    if (isPublishing) {
      throw new Error(`${operation} cannot run from inside the publish observer.`);
    }
  };

  const publish = (reason: PublishReason, steps: number) => {
    if (!options.onPublish) return;
    const metadata: PublishMetadata<Input> = Object.freeze({
      reason,
      steps,
      input,
      clock: getClock(),
    });
    isPublishing = true;
    try {
      options.onPublish(state, metadata);
    } catch (error) {
      try {
        options.onPublishError?.(Object.freeze({ error, state, metadata }));
      } catch {
        // A diagnostic observer cannot roll back or obscure an already
        // committed state transition. Its error is intentionally isolated.
      }
    } finally {
      isPublishing = false;
    }
  };

  const advance = (elapsedMs: number): AdvanceResult<State, Input> => {
    assertCanMutate('advance');
    const batch = consumeFixedSteps(remainderUnits, elapsedMs, step);
    if (batch.steps > maxStepsPerAdvance) {
      throw new FixedStepBudgetExceededError(batch.steps, maxStepsPerAdvance);
    }
    if (batch.steps === 0) {
      remainderUnits = batch.remainderUnits;
      return Object.freeze({ ...getSnapshot(), steps: 0 });
    }

    let nextState = state;
    let nextTick = tick;
    isAdvancing = true;
    try {
      for (let stepIndex = 0; stepIndex < batch.steps; stepIndex += 1) {
        nextTick += 1;
        nextState = options.simulate(nextState, input, {
          tick: nextTick,
          deltaMs,
          simulationTimeMs: nextTick * deltaMs,
        });
      }
    } finally {
      isAdvancing = false;
    }

    // Commit references only after the full batch succeeds. This is atomic for
    // simulations honoring the ownership contract above; deliberately mutating
    // an input state object in place cannot be rolled back without full copies.
    state = nextState;
    tick = nextTick;
    remainderUnits = batch.remainderUnits;
    publish('advance', batch.steps);
    return Object.freeze({ ...getSnapshot(), steps: batch.steps });
  };

  const replaceState = (nextState: State): RuntimeSnapshot<State, Input> => {
    assertCanMutate('replaceState');
    state = nextState;
    publish('replace-state', 0);
    return getSnapshot();
  };

  const replaceInput = (nextInput: Input): RuntimeSnapshot<State, Input> => {
    assertCanMutate('replaceInput');
    input = nextInput;
    return getSnapshot();
  };

  const resetClock = (): RuntimeSnapshot<State, Input> => {
    assertCanMutate('resetClock');
    tick = 0;
    remainderUnits = 0;
    return getSnapshot();
  };

  const resetInput = (): RuntimeSnapshot<State, Input> => {
    assertCanMutate('resetInput');
    input = options.createInitialInput();
    return getSnapshot();
  };

  const reset = (resetOptions: ResetRuntimeOptions<State, Input> = {}): RuntimeSnapshot<State, Input> => {
    assertCanMutate('reset');
    const nextState = Object.prototype.hasOwnProperty.call(resetOptions, 'state')
      ? (resetOptions.state as State)
      : options.createInitialState();
    const nextInput = Object.prototype.hasOwnProperty.call(resetOptions, 'input')
      ? (resetOptions.input as Input)
      : options.createInitialInput();
    state = nextState;
    input = nextInput;
    tick = 0;
    remainderUnits = 0;
    publish('reset', 0);
    return getSnapshot();
  };

  return Object.freeze({
    getState: () => state,
    getInput: () => input,
    getClock,
    getSnapshot,
    advance,
    replaceState,
    replaceInput,
    reset,
    resetClock,
    resetInput,
  });
};
