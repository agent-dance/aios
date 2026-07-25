export interface RationalFixedStep {
  /** Numerator of the fixed-step duration, expressed in milliseconds. */
  readonly durationNumeratorMs: number;
  /** Denominator of the fixed-step duration. */
  readonly durationDenominator: number;
}

export interface FixedStepBatch {
  readonly steps: number;
  /**
   * Unconsumed time in `durationDenominator` units per millisecond.
   * This value is always in [0, durationNumeratorMs).
   */
  readonly remainderUnits: number;
}

export const RATIONAL_STEP_60_HZ: RationalFixedStep = Object.freeze({
  durationNumeratorMs: 1_000,
  durationDenominator: 60,
});

const assertPositiveSafeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
};

export const assertValidFixedStep = (step: RationalFixedStep): void => {
  assertPositiveSafeInteger(step.durationNumeratorMs, 'step.durationNumeratorMs');
  assertPositiveSafeInteger(step.durationDenominator, 'step.durationDenominator');
};

const assertFiniteNonNegative = (value: number, name: string) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite.`);
  }
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative.`);
  }
};

export const getStepMilliseconds = (step: RationalFixedStep = RATIONAL_STEP_60_HZ): number => {
  assertValidFixedStep(step);
  return step.durationNumeratorMs / step.durationDenominator;
};

/**
 * Converts elapsed milliseconds into an exact, parameterized rational-step
 * work batch. Keeping the carry in rational units prevents equivalent time
 * partitions from losing ticks through repeated floating-point subtraction.
 */
export const consumeFixedSteps = (
  remainderUnits: number,
  elapsedMs: number,
  step: RationalFixedStep = RATIONAL_STEP_60_HZ,
): FixedStepBatch => {
  assertValidFixedStep(step);
  assertFiniteNonNegative(remainderUnits, 'remainderUnits');
  assertFiniteNonNegative(elapsedMs, 'elapsedMs');

  if (remainderUnits >= step.durationNumeratorMs) {
    throw new RangeError('remainderUnits must be smaller than the fixed-step numerator.');
  }

  const elapsedUnits = elapsedMs * step.durationDenominator;
  const totalUnits = remainderUnits + elapsedUnits;
  if (!Number.isFinite(totalUnits) || totalUnits > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('The elapsed interval is too large to step safely.');
  }

  const tolerance = Number.EPSILON * Math.max(1, totalUnits) * 8;
  const steps = Math.floor((totalUnits + tolerance) / step.durationNumeratorMs);
  if (!Number.isSafeInteger(steps)) {
    throw new RangeError('The elapsed interval produces too many steps to represent safely.');
  }

  const rawRemainder = totalUnits - steps * step.durationNumeratorMs;
  const remainder = Math.abs(rawRemainder) <= tolerance ? 0 : rawRemainder;
  if (remainder < 0 || remainder >= step.durationNumeratorMs) {
    throw new RangeError('Unable to normalize the fixed-step remainder safely.');
  }

  return { steps, remainderUnits: remainder };
};
