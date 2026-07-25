import { describe, expect, it } from 'vitest';
import { stableHash, stableSerialize } from './stableSerialization';

describe('stable serialization', () => {
  it('canonicalizes recursively regardless of object insertion order', () => {
    const left = { z: 2, nested: { b: true, a: ['星', -0] }, a: 1 };
    const right = { a: 1, nested: { a: ['星', -0], b: true }, z: 2 };

    expect(stableSerialize(left)).toBe('{"a":1,"nested":{"a":["星",-0],"b":true},"z":2}');
    expect(stableSerialize(right)).toBe(stableSerialize(left));
    expect(stableHash(right)).toBe(stableHash(left));
    expect(stableHash(left)).toMatch(/^fnv1a64-[0-9a-f]{16}$/);
  });

  it('distinguishes meaningful value changes including Unicode text', () => {
    expect(stableHash({ value: '游戏' })).not.toBe(stableHash({ value: '遊戲' }));
    expect(stableHash({ value: 0 })).not.toBe(stableHash({ value: -0 }));
  });

  it.each([
    { value: { bad: undefined }, message: '$.bad' },
    { value: [1, , 3], message: '$[1]' },
    { value: { bad: Number.NaN }, message: 'non-finite' },
    { value: new Date(0), message: 'non-plain' },
    { value: Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }), message: 'accessor' },
  ])('rejects non-canonical state: $message', ({ value, message }) => {
    expect(() => stableSerialize(value)).toThrow(message);
  });

  it('reports cyclic state instead of overflowing', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => stableSerialize(cyclic)).toThrow('cyclic reference');
  });
});
