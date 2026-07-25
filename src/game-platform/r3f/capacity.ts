export const MAX_POWER_OF_TWO_CAPACITY = 2 ** 52;

function assertCapacity(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POWER_OF_TWO_CAPACITY) {
    throw new RangeError(`${name} must be a non-negative safe integer no greater than 2^52.`);
  }
}

/** Returns a stable geometric pool capacity greater than or equal to both arguments. */
export function nextPowerOfTwoCapacity(requiredCapacity: number, minimumCapacity = 1): number {
  assertCapacity(requiredCapacity, 'requiredCapacity');
  assertCapacity(minimumCapacity, 'minimumCapacity');
  const target = Math.max(1, requiredCapacity, minimumCapacity);

  // Do not derive the exponent with Math.log2: immediately above large exact
  // powers of two, floating-point rounding can report the lower exponent and
  // produce an undersized pool. This loop is bounded to 52 iterations and all
  // of its intermediate powers of two are represented exactly by Number.
  let capacity = 1;
  while (capacity < target) capacity *= 2;
  return capacity;
}
