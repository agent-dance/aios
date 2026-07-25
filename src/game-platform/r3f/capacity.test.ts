import { describe, expect, it } from 'vitest';
import { MAX_POWER_OF_TWO_CAPACITY, nextPowerOfTwoCapacity } from './capacity';

describe('nextPowerOfTwoCapacity', () => {
  it('grows pool capacities geometrically', () => {
    expect(nextPowerOfTwoCapacity(0)).toBe(1);
    expect(nextPowerOfTwoCapacity(1)).toBe(1);
    expect(nextPowerOfTwoCapacity(2)).toBe(2);
    expect(nextPowerOfTwoCapacity(3)).toBe(4);
    expect(nextPowerOfTwoCapacity(257)).toBe(512);
    expect(nextPowerOfTwoCapacity(3, 64)).toBe(64);
  });

  it('supports the largest safe power-of-two boundary', () => {
    expect(nextPowerOfTwoCapacity(MAX_POWER_OF_TWO_CAPACITY)).toBe(MAX_POWER_OF_TWO_CAPACITY);
  });

  it.each([49, 50, 51])('never rounds down immediately above 2^%i', (exponent) => {
    const required = 2 ** exponent + 1;
    const capacity = nextPowerOfTwoCapacity(required);

    expect(capacity).toBe(2 ** (exponent + 1));
    expect(capacity).toBeGreaterThanOrEqual(required);
  });

  it('honors a large minimum without returning an undersized capacity', () => {
    const minimum = 2 ** 50 + 1;
    expect(nextPowerOfTwoCapacity(1, minimum)).toBe(2 ** 51);
  });

  it('rejects ambiguous or unsafe requests', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextPowerOfTwoCapacity(value)).toThrow(RangeError);
    }
  });
});
