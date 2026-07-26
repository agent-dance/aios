import { describe, expect, it } from 'vitest';
import { appendBounded, retainMostRecent } from './history';

describe('assistant bounded history', () => {
  it('retains the active user/assistant round while evicting the oldest records', () => {
    const full = Array.from({ length: 4 }, (_, index) => `old-${index}`);
    const withUser = appendBounded(full, 'active-user', 4);
    const withReply = appendBounded(withUser, 'active-assistant', 4);

    expect(withUser).toEqual(['old-1', 'old-2', 'old-3', 'active-user']);
    expect(withReply).toEqual(['old-2', 'old-3', 'active-user', 'active-assistant']);
  });

  it('bounds oversized response batches to their most recent records', () => {
    expect(retainMostRecent(['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
    expect(() => appendBounded([], 'x', 0)).toThrow(RangeError);
  });
});
