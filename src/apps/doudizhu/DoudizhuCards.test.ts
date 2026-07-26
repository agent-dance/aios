import { describe, expect, it, vi } from 'vitest';
import {
  createChaCha20Block,
  createDoudizhuSeed,
  DOU_DIZHU_DECK,
  shuffleDoudizhuDeck,
} from './DoudizhuCards';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));

describe('Doudizhu cards', () => {
  it('defines exactly 54 unique canonical cards', () => {
    expect(DOU_DIZHU_DECK).toHaveLength(54);
    expect(new Set(DOU_DIZHU_DECK.map((card) => card.id))).toHaveLength(54);
    expect(DOU_DIZHU_DECK).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'joker:small', strength: 13 }),
      expect.objectContaining({ id: 'joker:big', strength: 14 }),
    ]));
    expect(Object.isFrozen(DOU_DIZHU_DECK)).toBe(true);
  });

  it('uses deterministic Fisher-Yates without Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called');
    });
    const first = shuffleDoudizhuDeck(testSeed(0x12345678));
    const repeated = shuffleDoudizhuDeck(testSeed(0x12345678));
    const other = shuffleDoudizhuDeck(testSeed(0x12345679));
    expect(first).toEqual(repeated);
    expect(first.cards).not.toEqual(other.cards);
    expect(new Set(first.cards)).toHaveLength(54);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('matches the RFC 8439 ChaCha20 zero-key block and requires 256-bit seeds', () => {
    const block = createChaCha20Block(createDoudizhuSeed('0'.repeat(64)), 0);
    const hex = block.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(
      '76b8e0ada0f13d90405d6ae55386bd28'
      + 'bdd219b8a08ded1aa836efcc8b770dc7'
      + 'da41597c5157488d7724e03fb8d84a37'
      + '6a43b8f41518a11cc387b669b2ee6586',
    );
    expect(() => createDoudizhuSeed('12345678')).toThrow(/exactly 64 hexadecimal/);
    expect(() => createDoudizhuSeed('g'.repeat(64))).toThrow(/exactly 64 hexadecimal/);
  });
});
