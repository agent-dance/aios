import {
  assertUniqueCards,
  getCard,
  sortCards,
  type CardId,
} from './DoudizhuCards';

export type CombinationKind =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple-single'
  | 'triple-pair'
  | 'straight'
  | 'pair-straight'
  | 'airplane'
  | 'airplane-singles'
  | 'airplane-pairs'
  | 'four-two-singles'
  | 'four-two-pairs'
  | 'bomb'
  | 'rocket';

export const FOUR_WITH_TWO_POLICY = Object.freeze({
  singlesMayShareRank: true,
  bothJokersMayBeSingleWings: true,
  pairWingsMustUseDistinctRanks: true,
} as const);

export interface Combination {
  readonly kind: CombinationKind;
  readonly cards: readonly CardId[];
  readonly mainRank: number;
  readonly sequenceLength: number;
}

export class InvalidCombinationError extends Error {
  readonly code = 'INVALID_COMBINATION';

  constructor(message = 'The selected cards do not form a legal combination') {
    super(message);
    this.name = 'InvalidCombinationError';
  }
}

interface RankGroup {
  readonly strength: number;
  readonly cards: readonly CardId[];
}

function groupCards(cards: readonly CardId[]): readonly RankGroup[] {
  const byRank = new Map<number, CardId[]>();
  for (const cardId of cards) {
    const strength = getCard(cardId).strength;
    const group = byRank.get(strength) ?? [];
    group.push(cardId);
    byRank.set(strength, group);
  }
  return [...byRank.entries()]
    .sort(([left], [right]) => left - right)
    .map(([strength, groupedCards]) => ({ strength, cards: sortCards(groupedCards) }));
}

function createCombination(
  kind: CombinationKind,
  cards: readonly CardId[],
  mainRank: number,
  sequenceLength = 1,
): Combination {
  return Object.freeze({ kind, cards: sortCards(cards), mainRank, sequenceLength });
}

function isConsecutive(strengths: readonly number[]): boolean {
  return strengths.length > 0
    && strengths.every((strength, index) => strength <= 11
      && (index === 0 || strength === strengths[index - 1]! + 1));
}

function findAirplane(
  cards: readonly CardId[],
  groups: readonly RankGroup[],
  wing: 'none' | 'singles' | 'pairs',
): Combination | null {
  const unitSize = wing === 'none' ? 3 : wing === 'singles' ? 4 : 5;
  if (cards.length % unitSize !== 0) return null;
  const sequenceLength = cards.length / unitSize;
  if (sequenceLength < 2) return null;

  const tripleStrengths = groups
    .filter((group) => group.cards.length >= 3 && group.strength <= 11)
    .map((group) => group.strength);

  for (let start = 0; start <= tripleStrengths.length - sequenceLength; start += 1) {
    const core = tripleStrengths.slice(start, start + sequenceLength);
    if (!isConsecutive(core)) continue;
    const coreSet = new Set(core);
    const remainder = groups.filter((group) => !coreSet.has(group.strength));

    // Wings may never reuse a rank from the airplane's main triples. This also
    // prevents the fourth card of a four-of-a-kind from becoming its own wing.
    if (groups.some((group) => coreSet.has(group.strength) && group.cards.length !== 3)) continue;
    if (wing === 'none' && remainder.length === 0) {
      return createCombination('airplane', cards, core.at(-1)!, sequenceLength);
    }
    if (wing === 'singles'
      && remainder.reduce((total, group) => total + group.cards.length, 0) === sequenceLength) {
      return createCombination('airplane-singles', cards, core.at(-1)!, sequenceLength);
    }
    if (wing === 'pairs'
      && remainder.length === sequenceLength
      && remainder.every((group) => group.cards.length === 2)) {
      return createCombination('airplane-pairs', cards, core.at(-1)!, sequenceLength);
    }
  }
  return null;
}

export function classifyCombination(cardIds: readonly CardId[]): Combination {
  if (cardIds.length === 0) throw new InvalidCombinationError('At least one card is required');
  try {
    assertUniqueCards(cardIds);
  } catch (error) {
    throw new InvalidCombinationError(error instanceof Error ? error.message : undefined);
  }
  const cards = sortCards(cardIds);
  const groups = groupCards(cards);
  const counts = groups.map((group) => group.cards.length).sort((a, b) => b - a);
  const size = cards.length;

  if (size === 1) return createCombination('single', cards, groups[0]!.strength);
  if (size === 2 && cards.includes('joker:small') && cards.includes('joker:big')) {
    return createCombination('rocket', cards, 14);
  }
  if (size === 2 && groups.length === 1) return createCombination('pair', cards, groups[0]!.strength);
  if (size === 3 && groups.length === 1) return createCombination('triple', cards, groups[0]!.strength);
  if (size === 4 && groups.length === 1) return createCombination('bomb', cards, groups[0]!.strength);
  if (size === 4 && counts[0] === 3) {
    return createCombination('triple-single', cards, groups.find((group) => group.cards.length === 3)!.strength);
  }
  if (size === 5 && counts[0] === 3 && counts[1] === 2) {
    return createCombination('triple-pair', cards, groups.find((group) => group.cards.length === 3)!.strength);
  }

  if (size >= 5 && groups.length === size && isConsecutive(groups.map((group) => group.strength))) {
    return createCombination('straight', cards, groups.at(-1)!.strength, size);
  }
  if (size >= 6 && size % 2 === 0 && groups.every((group) => group.cards.length === 2)
    && isConsecutive(groups.map((group) => group.strength))) {
    return createCombination('pair-straight', cards, groups.at(-1)!.strength, groups.length);
  }

  const pureAirplane = findAirplane(cards, groups, 'none');
  if (pureAirplane) return pureAirplane;
  const singlesAirplane = findAirplane(cards, groups, 'singles');
  if (singlesAirplane) return singlesAirplane;
  const pairsAirplane = findAirplane(cards, groups, 'pairs');
  if (pairsAirplane) return pairsAirplane;

  if (size === 6 && counts[0] === 4) {
    return createCombination('four-two-singles', cards, groups.find((group) => group.cards.length === 4)!.strength);
  }
  if (size === 8 && counts[0] === 4) {
    const main = groups.find((group) => group.cards.length === 4)!;
    const wings = groups.filter((group) => group !== main);
    if (wings.length === 2 && wings.every((group) => group.cards.length === 2)) {
      return createCombination('four-two-pairs', cards, main.strength);
    }
  }

  throw new InvalidCombinationError();
}

export function canBeatCombination(
  candidate: Readonly<Combination>,
  incumbent: Readonly<Combination> | null,
): boolean {
  if (!incumbent) return true;
  if (candidate.kind === 'rocket') return incumbent.kind !== 'rocket';
  if (incumbent.kind === 'rocket') return false;
  if (candidate.kind === 'bomb') {
    return incumbent.kind !== 'bomb' || candidate.mainRank > incumbent.mainRank;
  }
  if (incumbent.kind === 'bomb') return false;
  return candidate.kind === incumbent.kind
    && candidate.sequenceLength === incumbent.sequenceLength
    && candidate.cards.length === incumbent.cards.length
    && candidate.mainRank > incumbent.mainRank;
}

function consecutiveWindows(groups: readonly RankGroup[], multiplicity: 1 | 2 | 3, minimum: number): CardId[][] {
  const eligible = groups.filter((group) => group.strength <= 11 && group.cards.length >= multiplicity);
  const results: CardId[][] = [];
  for (let start = 0; start < eligible.length; start += 1) {
    for (let end = start + minimum; end <= eligible.length; end += 1) {
      const window = eligible.slice(start, end);
      if (!isConsecutive(window.map((group) => group.strength))) break;
      results.push(window.flatMap((group) => group.cards.slice(0, multiplicity)));
    }
  }
  return results;
}

function chooseRankMultisets(groups: readonly RankGroup[], size: number): CardId[][] {
  const results: CardId[][] = [];
  const visit = (index: number, remaining: number, selected: CardId[]): void => {
    if (remaining === 0) {
      results.push([...selected]);
      return;
    }
    if (index >= groups.length) return;
    const group = groups[index]!;
    for (let count = 0; count <= Math.min(group.cards.length, remaining); count += 1) {
      visit(index + 1, remaining - count, [...selected, ...group.cards.slice(0, count)]);
    }
  };
  visit(0, size, []);
  return results;
}

function choosePairRanks(groups: readonly RankGroup[], size: number): CardId[][] {
  const eligible = groups.filter((group) => group.cards.length >= 2);
  const results: CardId[][] = [];
  const visit = (index: number, remaining: number, selected: CardId[]): void => {
    if (remaining === 0) {
      results.push([...selected]);
      return;
    }
    if (eligible.length - index < remaining) return;
    for (let cursor = index; cursor < eligible.length; cursor += 1) {
      visit(cursor + 1, remaining - 1, [...selected, ...eligible[cursor]!.cards.slice(0, 2)]);
    }
  };
  visit(0, size, []);
  return results;
}

/**
 * Produces one strategically equivalent representative for each rank pattern.
 * Arbitrary suit-equivalent selections remain valid through classifyCombination.
 */
export function enumerateStrategicPlays(
  hand: readonly CardId[],
  incumbent: Readonly<Combination> | null,
): readonly Combination[] {
  assertUniqueCards(hand);
  const groups = groupCards(hand);
  const candidates: CardId[][] = [];
  const add = (cards: readonly CardId[]) => candidates.push([...cards]);

  for (const group of groups) {
    add(group.cards.slice(0, 1));
    if (group.cards.length >= 2) add(group.cards.slice(0, 2));
    if (group.cards.length >= 3) add(group.cards.slice(0, 3));
    if (group.cards.length === 4) add(group.cards);
  }
  if (hand.includes('joker:small') && hand.includes('joker:big')) add(['joker:small', 'joker:big']);

  for (const triple of groups.filter((group) => group.cards.length >= 3)) {
    const remainder = groups.filter((group) => group.strength !== triple.strength);
    for (const wing of remainder) add([...triple.cards.slice(0, 3), wing.cards[0]!]);
    for (const wing of remainder.filter((group) => group.cards.length >= 2)) {
      add([...triple.cards.slice(0, 3), ...wing.cards.slice(0, 2)]);
    }
  }

  candidates.push(...consecutiveWindows(groups, 1, 5));
  candidates.push(...consecutiveWindows(groups, 2, 3));
  const tripleRuns = consecutiveWindows(groups, 3, 2);
  candidates.push(...tripleRuns);
  for (const core of tripleRuns) {
    const coreRanks = new Set(core.map((card) => getCard(card).strength));
    const remainder = groups.filter((group) => !coreRanks.has(group.strength));
    const length = core.length / 3;
    for (const singleWings of chooseRankMultisets(remainder, length)) add([...core, ...singleWings]);
    for (const pairWings of choosePairRanks(remainder, length)) add([...core, ...pairWings]);
  }

  for (const quad of groups.filter((group) => group.cards.length === 4)) {
    const remainder = groups.filter((group) => group.strength !== quad.strength);
    for (const singles of chooseRankMultisets(remainder, 2)) add([...quad.cards, ...singles]);
    for (const pairs of choosePairRanks(remainder, 2)) add([...quad.cards, ...pairs]);
  }

  const unique = new Map<string, Combination>();
  for (const candidate of candidates) {
    try {
      const combination = classifyCombination(candidate);
      if (canBeatCombination(combination, incumbent)) {
        unique.set(combination.cards.join('|'), combination);
      }
    } catch (error) {
      if (!(error instanceof InvalidCombinationError)) throw error;
    }
  }
  return Object.freeze([...unique.values()].sort((left, right) =>
    left.cards.length - right.cards.length
      || left.mainRank - right.mainRank
      || left.kind.localeCompare(right.kind)));
}
