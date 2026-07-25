import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FRAME_MS,
  assertAutomaticRenderPriority,
  assertPositiveFrameLimit,
  normalizeFrameElapsedMs,
} from './fixedStepDriver';

describe('assertAutomaticRenderPriority', () => {
  it('accepts observer priorities that preserve automatic rendering', () => {
    expect(assertAutomaticRenderPriority(-100)).toBe(-100);
    expect(assertAutomaticRenderPriority(0)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.001, 1])(
    'rejects a priority that would corrupt frame ordering or take over rendering: %s',
    (priority) => {
      expect(() => assertAutomaticRenderPriority(priority)).toThrow(RangeError);
    },
  );
});

describe('assertPositiveFrameLimit', () => {
  it('accepts a finite positive clamp and rejects invalid component configuration', () => {
    expect(assertPositiveFrameLimit(34)).toBe(34);
    for (const maxFrameMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertPositiveFrameLimit(maxFrameMs)).toThrow(RangeError);
    }
  });
});

describe('normalizeFrameElapsedMs', () => {
  it('converts seconds to milliseconds and clamps long frames', () => {
    expect(normalizeFrameElapsedMs(1 / 60)).toBeCloseTo(1000 / 60);
    expect(normalizeFrameElapsedMs(1)).toBe(DEFAULT_MAX_FRAME_MS);
    expect(normalizeFrameElapsedMs(1, 34)).toBe(34);
  });

  it('rejects invalid clock input and invalid limits', () => {
    expect(normalizeFrameElapsedMs(Number.NaN)).toBe(0);
    expect(normalizeFrameElapsedMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeFrameElapsedMs(-1)).toBe(0);
    expect(normalizeFrameElapsedMs(1 / 60, 0)).toBe(0);
  });
});
