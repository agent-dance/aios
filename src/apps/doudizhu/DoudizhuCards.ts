export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export type Suit = (typeof SUITS)[number];

export const STANDARD_RANKS = [
  '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2',
] as const;
export type StandardRank = (typeof STANDARD_RANKS)[number];
export type Rank = StandardRank | 'small-joker' | 'big-joker';

export type CardId =
  | `${Suit}:${StandardRank}`
  | 'joker:small'
  | 'joker:big';

export interface Card {
  readonly id: CardId;
  readonly rank: Rank;
  readonly suit: Suit | 'joker';
  readonly strength: number;
}

const rankStrength = new Map<Rank, number>([
  ...STANDARD_RANKS.map((rank, index) => [rank, index] as const),
  ['small-joker', 13],
  ['big-joker', 14],
]);

const cards: Card[] = [];
for (const rank of STANDARD_RANKS) {
  for (const suit of SUITS) {
    cards.push(Object.freeze({
      id: `${suit}:${rank}` as CardId,
      rank,
      suit,
      strength: rankStrength.get(rank)!,
    }));
  }
}
cards.push(Object.freeze({ id: 'joker:small', rank: 'small-joker', suit: 'joker', strength: 13 }));
cards.push(Object.freeze({ id: 'joker:big', rank: 'big-joker', suit: 'joker', strength: 14 }));

export const DOU_DIZHU_DECK: readonly Card[] = Object.freeze(cards);

const cardsById = new Map(DOU_DIZHU_DECK.map((card) => [card.id, card]));

export function getCard(cardId: CardId): Card {
  const card = cardsById.get(cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  return card;
}

export function compareCards(left: CardId, right: CardId): number {
  const leftCard = getCard(left);
  const rightCard = getCard(right);
  return leftCard.strength - rightCard.strength
    || leftCard.suit.localeCompare(rightCard.suit);
}

export function sortCards(cardIds: readonly CardId[]): readonly CardId[] {
  return Object.freeze([...cardIds].sort(compareCards));
}

export function assertUniqueCards(cardIds: readonly CardId[]): void {
  const unique = new Set(cardIds);
  if (unique.size !== cardIds.length) throw new Error('Duplicate cards are not allowed');
  for (const cardId of cardIds) getCard(cardId);
}

declare const doudizhuSeedBrand: unique symbol;
export type DoudizhuSeed = string & { readonly [doudizhuSeedBrand]: true };

const SEED_HEX_LENGTH = 64;
const SEED_PATTERN = /^[0-9a-f]{64}$/;
const CHACHA_CONSTANTS = Object.freeze([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const);

/** Validates and normalizes a 256-bit seed encoded as 64 hexadecimal characters. */
export function createDoudizhuSeed(value: string): DoudizhuSeed {
  if (typeof value !== 'string') {
    throw new TypeError(`Doudizhu seed must contain exactly ${SEED_HEX_LENGTH} hexadecimal characters`);
  }
  const normalized = value.trim().toLowerCase();
  if (!SEED_PATTERN.test(normalized)) {
    throw new TypeError(`Doudizhu seed must contain exactly ${SEED_HEX_LENGTH} hexadecimal characters`);
  }
  return normalized as DoudizhuSeed;
}

export function createDoudizhuSeedFromBytes(bytes: Readonly<Uint8Array>): DoudizhuSeed {
  if (bytes.length !== 32) throw new TypeError('Doudizhu seed requires exactly 32 bytes');
  return createDoudizhuSeed(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

const rotateLeft = (value: number, amount: number): number => (
  ((value << amount) | (value >>> (32 - amount))) >>> 0
);

function quarterRound(words: Uint32Array, a: number, b: number, c: number, d: number): void {
  words[a] = (words[a]! + words[b]!) >>> 0;
  words[d] = rotateLeft(words[d]! ^ words[a]!, 16);
  words[c] = (words[c]! + words[d]!) >>> 0;
  words[b] = rotateLeft(words[b]! ^ words[c]!, 12);
  words[a] = (words[a]! + words[b]!) >>> 0;
  words[d] = rotateLeft(words[d]! ^ words[a]!, 8);
  words[c] = (words[c]! + words[d]!) >>> 0;
  words[b] = rotateLeft(words[b]! ^ words[c]!, 7);
}

function seedWords(seed: DoudizhuSeed): Uint32Array {
  const words = new Uint32Array(8);
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    let word = 0;
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      const offset = (wordIndex * 4 + byteIndex) * 2;
      word |= Number.parseInt(seed.slice(offset, offset + 2), 16) << (byteIndex * 8);
    }
    words[wordIndex] = word >>> 0;
  }
  return words;
}

function wordsToSeed(words: readonly number[]): DoudizhuSeed {
  const bytes: number[] = [];
  for (const word of words) {
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      bytes.push((word >>> (byteIndex * 8)) & 0xff);
    }
  }
  return createDoudizhuSeedFromBytes(Uint8Array.from(bytes));
}

/** RFC 8439 ChaCha20 block with a zero nonce; the 256-bit seed is the secret key. */
export function createChaCha20Block(seed: DoudizhuSeed, counter: number): readonly number[] {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new RangeError('ChaCha20 counter must be a uint32');
  }
  const key = seedWords(createDoudizhuSeed(seed));
  const initial = new Uint32Array(16);
  initial.set(CHACHA_CONSTANTS, 0);
  initial.set(key, 4);
  initial[12] = counter >>> 0;
  // words 13..15 are the fixed zero nonce. Every deal uses a fresh 256-bit key.
  const working = initial.slice();
  for (let round = 0; round < 10; round += 1) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }
  const bytes = new Uint8Array(64);
  for (let wordIndex = 0; wordIndex < working.length; wordIndex += 1) {
    const word = (working[wordIndex]! + initial[wordIndex]!) >>> 0;
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      bytes[wordIndex * 4 + byteIndex] = (word >>> (byteIndex * 8)) & 0xff;
    }
  }
  return Object.freeze(Array.from(bytes));
}

export interface ShuffledDeck {
  readonly cards: readonly CardId[];
  readonly bidderStart: 0 | 1 | 2;
  readonly nextSeed: DoudizhuSeed;
}

/** 256-bit ChaCha20-seeded, rejection-sampled Fisher-Yates. The canonical deck is never mutated. */
export function shuffleDoudizhuDeck(seed: DoudizhuSeed): ShuffledDeck {
  const normalizedSeed = createDoudizhuSeed(seed);
  let counter = 0;
  let block = createChaCha20Block(normalizedSeed, counter);
  let byteOffset = 0;
  const nextUint32 = (): number => {
    if (byteOffset >= block.length) {
      counter += 1;
      block = createChaCha20Block(normalizedSeed, counter);
      byteOffset = 0;
    }
    const value = (
      block[byteOffset]!
      | (block[byteOffset + 1]! << 8)
      | (block[byteOffset + 2]! << 16)
      | (block[byteOffset + 3]! << 24)
    ) >>> 0;
    byteOffset += 4;
    return value;
  };
  const uniformBelow = (upperExclusive: number): number => {
    const limit = Math.floor(0x1_0000_0000 / upperExclusive) * upperExclusive;
    let value: number;
    do value = nextUint32(); while (value >= limit);
    return value % upperExclusive;
  };

  const bidderStart = uniformBelow(3) as 0 | 1 | 2;
  const shuffled = DOU_DIZHU_DECK.map((card) => card.id);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = uniformBelow(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  const nextSeedWords = Array.from({ length: 8 }, () => nextUint32());
  return Object.freeze({ cards: Object.freeze(shuffled), bidderStart, nextSeed: wordsToSeed(nextSeedWords) });
}
