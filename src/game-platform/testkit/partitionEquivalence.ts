import type { FixedStepRuntime, RuntimeSnapshot } from '../runtime';
import { stableHash, stableSerialize } from './stableSerialization';

export interface PartitionRun {
  readonly partition: readonly number[];
  readonly totalMs: number;
  readonly serialized: string;
  readonly hash: string;
}

export interface PartitionComparison {
  readonly equivalent: boolean;
  readonly baselineHash: string;
  readonly runs: readonly PartitionRun[];
}

export interface CompareAdvancePartitionsOptions<State, Input> {
  readonly createRuntime: () => FixedStepRuntime<State, Input>;
  readonly partitions: readonly (readonly number[])[];
  /** Defaults to state plus simulated tick; input and fractional carry are omitted. */
  readonly select?: (snapshot: RuntimeSnapshot<State, Input>) => unknown;
}

const defaultSelection = <State, Input>(snapshot: RuntimeSnapshot<State, Input>) => ({
  state: snapshot.state,
  tick: snapshot.clock.tick,
});

/** Runs fresh runtimes under alternate elapsed-time partitions and compares canonical state. */
export const compareAdvancePartitions = <State, Input>(
  options: CompareAdvancePartitionsOptions<State, Input>,
): PartitionComparison => {
  if (options.partitions.length < 2) {
    throw new RangeError('At least two partitions are required for an equivalence comparison.');
  }

  const runs = options.partitions.map((partition, partitionIndex): PartitionRun => {
    const runtime = options.createRuntime();
    let totalMs = 0;
    partition.forEach((elapsedMs, stepIndex) => {
      if (!Number.isFinite(elapsedMs)) {
        throw new TypeError(`partitions[${partitionIndex}][${stepIndex}] must be finite.`);
      }
      if (elapsedMs < 0) {
        throw new RangeError(`partitions[${partitionIndex}][${stepIndex}] must be non-negative.`);
      }
      totalMs += elapsedMs;
      runtime.advance(elapsedMs);
    });
    const snapshot = runtime.getSnapshot();
    const selected = options.select ? options.select(snapshot) : defaultSelection(snapshot);
    const serialized = stableSerialize(selected);
    return Object.freeze({ partition: Object.freeze([...partition]), totalMs, serialized, hash: stableHash(selected) });
  });

  const baseline = runs[0]!;
  return Object.freeze({
    equivalent: runs.every((run) => run.serialized === baseline.serialized),
    baselineHash: baseline.hash,
    runs: Object.freeze(runs),
  });
};

export const assertAdvancePartitionsEquivalent = <State, Input>(
  options: CompareAdvancePartitionsOptions<State, Input>,
): PartitionComparison => {
  const comparison = compareAdvancePartitions(options);
  if (!comparison.equivalent) {
    const summary = comparison.runs.map((run, index) => `#${index}:${run.hash}@${run.totalMs}ms`).join(', ');
    throw new Error(`Fixed-step partitions are not equivalent (${summary}).`);
  }
  return comparison;
};
