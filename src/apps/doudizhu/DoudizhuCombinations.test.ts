import { describe, expect, it } from 'vitest';
import {
  canBeatCombination,
  classifyCombination,
  enumerateStrategicPlays,
  InvalidCombinationError,
  type CombinationKind,
} from './DoudizhuCombinations';
import { getCard, type CardId, type StandardRank } from './DoudizhuCards';

const suits = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
const rank = (value: StandardRank, count = 1): CardId[] =>
  suits.slice(0, count).map((suit) => `${suit}:${value}` as CardId);
const ranks = (...values: StandardRank[]): CardId[] => values.map((value) => `clubs:${value}` as CardId);

describe('classic combination classification', () => {
  const cases: readonly [CombinationKind, CardId[]][] = [
    ['single', rank('3')],
    ['pair', rank('3', 2)],
    ['triple', rank('3', 3)],
    ['triple-single', [...rank('3', 3), ...rank('4')]],
    ['triple-pair', [...rank('3', 3), ...rank('4', 2)]],
    ['straight', ranks('3', '4', '5', '6', '7')],
    ['pair-straight', [...rank('3', 2), ...rank('4', 2), ...rank('5', 2)]],
    ['airplane', [...rank('3', 3), ...rank('4', 3)]],
    ['airplane-singles', [...rank('3', 3), ...rank('4', 3), ...ranks('5', '6')]],
    ['airplane-pairs', [...rank('3', 3), ...rank('4', 3), ...rank('5', 2), ...rank('6', 2)]],
    ['four-two-singles', [...rank('3', 4), ...ranks('4', '5')]],
    ['four-two-pairs', [...rank('3', 4), ...rank('4', 2), ...rank('5', 2)]],
    ['bomb', rank('3', 4)],
    ['rocket', ['joker:small', 'joker:big']],
  ];

  it.each(cases)('recognizes %s', (kind, cards) => {
    expect(classifyCombination(cards)).toMatchObject({ kind, cards: expect.any(Array) });
  });

  it('rejects forbidden sequences and airplane wing reuse', () => {
    expect(() => classifyCombination(ranks('10', 'J', 'Q', 'K', 'A', '2')))
      .toThrow(InvalidCombinationError);
    expect(() => classifyCombination([
      ...rank('3', 4), ...rank('4', 3), ...rank('5'),
    ])).toThrow(InvalidCombinationError);
  });

  it('applies the frozen four-with-two attachment policy', () => {
    expect(classifyCombination([...rank('3', 4), ...rank('4', 2)]).kind).toBe('four-two-singles');
    expect(classifyCombination([...rank('3', 4), 'joker:small', 'joker:big']).kind)
      .toBe('four-two-singles');
    expect(() => classifyCombination([...rank('3', 4), ...rank('4', 4)]))
      .toThrow(InvalidCombinationError);
  });

  it('compares only compatible shapes, with bombs and rocket overrides', () => {
    const pair3 = classifyCombination(rank('3', 2));
    const pair4 = classifyCombination(rank('4', 2));
    const singleA = classifyCombination(rank('A'));
    const bomb3 = classifyCombination(rank('3', 4));
    const rocket = classifyCombination(['joker:small', 'joker:big']);
    expect(canBeatCombination(pair4, pair3)).toBe(true);
    expect(canBeatCombination(pair3, pair4)).toBe(false);
    expect(canBeatCombination(singleA, pair3)).toBe(false);
    expect(canBeatCombination(bomb3, pair4)).toBe(true);
    expect(canBeatCombination(rocket, bomb3)).toBe(true);
    expect(canBeatCombination(bomb3, rocket)).toBe(false);
  });

  it('enumerates every distinct airplane wing rank choice', () => {
    const hand = [
      ...rank('3', 3), ...rank('4', 3),
      ...rank('5', 2), ...rank('6', 2), ...rank('7', 2),
    ];
    const wings = enumerateStrategicPlays(hand, null)
      .filter((play) => play.kind === 'airplane-pairs' && play.mainRank === 1)
      .map((play) => play.cards
        .filter((card) => getCard(card).strength >= 2)
        .map((card) => getCard(card).rank)
        .join(','));
    expect(new Set(wings).size).toBe(3);
  });

  it('enumerates all rank-multiset choices for single wings and four attachments', () => {
    const hand = [
      ...rank('3', 3), ...rank('4', 3), ...rank('5', 2), ...rank('6'), ...rank('7'),
    ];
    const airplaneWings = enumerateStrategicPlays(hand, null)
      .filter((play) => play.kind === 'airplane-singles' && play.mainRank === 1)
      .map((play) => play.cards.filter((card) => getCard(card).strength >= 2)
        .map((card) => getCard(card).strength).join(','));
    expect(new Set(airplaneWings)).toEqual(new Set(['2,2', '2,3', '2,4', '3,4']));

    const quadHand = [...rank('8', 4), ...rank('9', 2), ...rank('10'), ...rank('J')];
    const fourWings = enumerateStrategicPlays(quadHand, null)
      .filter((play) => play.kind === 'four-two-singles')
      .map((play) => play.cards.filter((card) => getCard(card).rank !== '8')
        .map((card) => getCard(card).strength).join(','));
    expect(new Set(fourWings)).toEqual(new Set(['6,6', '6,7', '6,8', '7,8']));
  });

  it('matches brute-force legal rank-multisets for a compact hand', () => {
    const hand = [...rank('3', 3), ...rank('4', 3), ...rank('5', 2), ...rank('6', 2)];
    const signature = (cards: readonly CardId[]) => {
      const combination = classifyCombination(cards);
      const counts = new Map<number, number>();
      for (const card of cards) counts.set(getCard(card).strength, (counts.get(getCard(card).strength) ?? 0) + 1);
      return `${combination.kind}:${combination.mainRank}:${combination.sequenceLength}:${[...counts].sort(([a], [b]) => a - b).map(([key, value]) => `${key}x${value}`).join(',')}`;
    };
    const bruteForce = new Set<string>();
    for (let mask = 1; mask < 2 ** hand.length; mask += 1) {
      const selection = hand.filter((_, index) => mask & (1 << index));
      try { bruteForce.add(signature(selection)); } catch (error) {
        if (!(error instanceof InvalidCombinationError)) throw error;
      }
    }
    const enumerated = new Set(enumerateStrategicPlays(hand, null).map((play) => signature(play.cards)));
    expect([...bruteForce].filter((entry) => !enumerated.has(entry))).toEqual([]);
  });
});
