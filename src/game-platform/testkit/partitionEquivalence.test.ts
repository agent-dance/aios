import { describe, expect, it } from 'vitest';
import { createFixedStepRuntime } from '../runtime';
import { assertAdvancePartitionsEquivalent, compareAdvancePartitions } from './partitionEquivalence';

const createCounterRuntime = () =>
  createFixedStepRuntime({
    createInitialState: () => ({ ticks: 0 }),
    createInitialInput: () => null,
    simulate: (state) => ({ ticks: state.ticks + 1 }),
  });

describe('partition equivalence helpers', () => {
  it('proves a whole elapsed interval equals alternate partitions', () => {
    const comparison = assertAdvancePartitionsEquivalent({
      createRuntime: createCounterRuntime,
      partitions: [[2_000], [1_000, 1_000], Array.from({ length: 120 }, () => 1000 / 60)],
    });

    expect(comparison.equivalent).toBe(true);
    expect(new Set(comparison.runs.map((run) => run.hash)).size).toBe(1);
    expect(comparison.runs.every((run) => run.serialized === '{"state":{"ticks":120},"tick":120}')).toBe(true);
  });

  it('returns diagnostics and throws when partitions diverge', () => {
    const options = {
      createRuntime: createCounterRuntime,
      partitions: [[1_000], [500]],
    };
    const comparison = compareAdvancePartitions(options);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.runs.map((run) => run.totalMs)).toEqual([1_000, 500]);
    expect(() => assertAdvancePartitionsEquivalent(options)).toThrow(/#0:.*#1:/);
  });

  it('supports custom snapshot selection', () => {
    const comparison = compareAdvancePartitions({
      createRuntime: createCounterRuntime,
      partitions: [[1_000], [500]],
      select: (snapshot) => ({ input: snapshot.input }),
    });
    expect(comparison.equivalent).toBe(true);
  });

  it('requires at least two valid partitions', () => {
    expect(() => compareAdvancePartitions({ createRuntime: createCounterRuntime, partitions: [[1]] })).toThrow(
      'At least two',
    );
    expect(() =>
      compareAdvancePartitions({ createRuntime: createCounterRuntime, partitions: [[1], [Number.NaN]] }),
    ).toThrow(TypeError);
  });
});
