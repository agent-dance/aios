import {
  classifyCombination,
  canBeatCombination,
  type Combination,
} from './DoudizhuCombinations';
import {
  createDoudizhuSeed,
  shuffleDoudizhuDeck,
  sortCards,
  type CardId,
  type DoudizhuSeed,
} from './DoudizhuCards';

export const DOUDIZHU_RULESET = 'classic-3p-score-bid@1' as const;
export type Seat = 0 | 1 | 2;
export type Triple<T> = readonly [T, T, T];
export type DoudizhuPhase =
  | 'bidding'
  | 'defender-double'
  | 'landlord-redouble'
  | 'playing'
  | 'complete';

export type DoudizhuAction =
  | Readonly<{ type: 'bid'; score: 0 | 1 | 2 | 3 }>
  | Readonly<{ type: 'commit-defender-double'; double: boolean }>
  | Readonly<{ type: 'landlord-redouble'; redouble: boolean }>
  | Readonly<{ type: 'play'; cards: readonly CardId[] }>
  | Readonly<{ type: 'pass' }>;

export interface DoudizhuActionRequest {
  readonly seat: Seat;
  readonly expectedRevision: number;
  readonly turnNonce: string;
  readonly action: DoudizhuAction;
}

export type DoudizhuRuleErrorCode =
  | 'MATCH_COMPLETE'
  | 'NOT_YOUR_TURN'
  | 'STALE_REVISION'
  | 'STALE_TURN_NONCE'
  | 'ACTION_NOT_ALLOWED'
  | 'INVALID_BID'
  | 'INVALID_CARDS'
  | 'MUST_BEAT_CURRENT_PLAY'
  | 'CANNOT_PASS';

export class DoudizhuRuleError extends Error {
  constructor(
    readonly code: DoudizhuRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DoudizhuRuleError';
  }
}

export type EventVisibility = 'public' | Readonly<{ seats: readonly Seat[] }>;

export interface DoudizhuEvent {
  readonly index: number;
  readonly revision: number;
  readonly type:
    | 'dealt'
    | 'bid'
    | 'redealt'
    | 'landlord-selected'
    | 'defender-double-committed'
    | 'defender-doubles-revealed'
    | 'landlord-redoubled'
    | 'bottom-revealed'
    | 'played'
    | 'passed'
    | 'trick-cleared'
    | 'settled';
  readonly visibility: EventVisibility;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TrickPlay {
  readonly seat: Seat;
  readonly cards: readonly CardId[];
  readonly combination: Combination;
}

export interface RoundSettlement {
  readonly winner: 'landlord' | 'defenders';
  readonly spring: 'spring' | 'anti-spring' | null;
  readonly baseBid: 1 | 2 | 3;
  readonly bombAndSpringMultiplier: number;
  readonly landlordRedoubleMultiplier: 1 | 2;
  readonly defenderStakeMultipliers: Triple<1 | 2>;
  readonly scoreDeltas: Triple<number>;
}

export interface DoudizhuState {
  readonly ruleset: typeof DOUDIZHU_RULESET;
  readonly matchId: string;
  readonly phase: DoudizhuPhase;
  readonly revision: number;
  readonly turnNonce: string;
  readonly currentSeat: Seat;
  readonly dealNumber: number;
  /** Authority-only random state. Never include this in a seat projection. */
  readonly rngState: DoudizhuSeed;
  /** Authority-only original deal order. Never include this in a seat projection. */
  readonly deck: readonly CardId[];
  readonly hands: Triple<readonly CardId[]>;
  readonly bottom: readonly CardId[];
  readonly bottomRevealed: boolean;
  readonly bidderStart: Seat;
  readonly bids: Triple<0 | 1 | 2 | 3 | null>;
  readonly currentBid: 0 | 1 | 2 | 3;
  readonly highestBidder: Seat | null;
  readonly bidActionsTaken: number;
  readonly landlordSeat: Seat | null;
  /** Commitments are authority-only until both defenders have committed. */
  readonly defenderCommitments: Triple<boolean | null>;
  readonly defenderDoubles: Triple<boolean | null>;
  readonly landlordRedoubled: boolean | null;
  readonly trickLeaderSeat: Seat | null;
  readonly currentTrick: TrickPlay | null;
  readonly consecutivePasses: 0 | 1;
  readonly playsBySeat: Triple<number>;
  readonly bombOrRocketCount: number;
  readonly settlement: RoundSettlement | null;
  readonly scores: Triple<number>;
  readonly history: readonly DoudizhuEvent[];
}

const nextSeat = (seat: Seat): Seat => ((seat + 1) % 3) as Seat;

function replaceAt<T>(tuple: Triple<T>, seat: Seat, value: T): Triple<T> {
  const copy: [T, T, T] = [tuple[0], tuple[1], tuple[2]];
  copy[seat] = value;
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function nonce(matchId: string, revision: number, phase: DoudizhuPhase, seat: Seat): string {
  return `${matchId}:${revision}:${phase}:${seat}`;
}

function appendEvent(
  history: readonly DoudizhuEvent[],
  revision: number,
  type: DoudizhuEvent['type'],
  payload: Readonly<Record<string, unknown>>,
  visibility: EventVisibility = 'public',
): readonly DoudizhuEvent[] {
  return [...history, { index: history.length, revision, type, payload, visibility }];
}

function createDeal(
  matchId: string,
  seed: DoudizhuSeed,
  dealNumber: number,
  revision: number,
  priorHistory: readonly DoudizhuEvent[],
  forcedBidderStart?: Seat,
): DoudizhuState {
  const shuffled = shuffleDoudizhuDeck(seed);
  const bidderStart = forcedBidderStart ?? shuffled.bidderStart;
  const hands: [CardId[], CardId[], CardId[]] = [[], [], []];
  for (let index = 0; index < 51; index += 1) {
    const seat = ((bidderStart + index) % 3) as Seat;
    hands[seat].push(shuffled.cards[index]!);
  }
  const bottom = shuffled.cards.slice(51);
  const history = appendEvent(
    priorHistory,
    revision,
    dealNumber === 0 ? 'dealt' : 'redealt',
    { dealNumber, bidderStart },
  );
  return deepFreeze({
    ruleset: DOUDIZHU_RULESET,
    matchId,
    phase: 'bidding',
    revision,
    turnNonce: nonce(matchId, revision, 'bidding', bidderStart),
    currentSeat: bidderStart,
    dealNumber,
    rngState: shuffled.nextSeed,
    deck: shuffled.cards,
    hands: [sortCards(hands[0]), sortCards(hands[1]), sortCards(hands[2])],
    bottom,
    bottomRevealed: false,
    bidderStart,
    bids: [null, null, null],
    currentBid: 0,
    highestBidder: null,
    bidActionsTaken: 0,
    landlordSeat: null,
    defenderCommitments: [null, null, null],
    defenderDoubles: [null, null, null],
    landlordRedoubled: null,
    trickLeaderSeat: null,
    currentTrick: null,
    consecutivePasses: 0,
    playsBySeat: [0, 0, 0],
    bombOrRocketCount: 0,
    settlement: null,
    scores: [0, 0, 0],
    history,
  });
}

export interface CreateDoudizhuOptions {
  readonly seed: DoudizhuSeed;
  readonly matchId: string;
}

export function createInitialDoudizhuState(options: CreateDoudizhuOptions): DoudizhuState {
  const seed = createDoudizhuSeed(options.seed);
  const matchId = options.matchId.trim();
  if (matchId.length === 0) throw new TypeError('matchId must be a non-empty opaque identifier');
  return createDeal(matchId, seed, 0, 0, []);
}

function withTurn(
  state: DoudizhuState,
  changes: Partial<DoudizhuState>,
  revision: number,
  phase: DoudizhuPhase,
  seat: Seat,
): DoudizhuState {
  return deepFreeze({
    ...state,
    ...changes,
    revision,
    phase,
    currentSeat: seat,
    turnNonce: nonce(state.matchId, revision, phase, seat),
  });
}

function defenderSeats(landlord: Seat): readonly [Seat, Seat] {
  return [nextSeat(landlord), nextSeat(nextSeat(landlord))];
}

function finalizeLandlord(
  state: DoudizhuState,
  landlordSeat: Seat,
  revision: number,
  history: readonly DoudizhuEvent[],
): DoudizhuState {
  const defenders = defenderSeats(landlordSeat);
  return withTurn(state, {
    landlordSeat,
    history: appendEvent(history, revision, 'landlord-selected', {
      landlordSeat,
      bid: state.currentBid,
    }),
  }, revision, 'defender-double', defenders[0]);
}

function applyBid(state: DoudizhuState, seat: Seat, score: 0 | 1 | 2 | 3): DoudizhuState {
  if (state.phase !== 'bidding') {
    throw new DoudizhuRuleError('ACTION_NOT_ALLOWED', 'Bidding is closed');
  }
  if (score !== 0 && score <= state.currentBid) {
    throw new DoudizhuRuleError('INVALID_BID', 'A bid must be zero or strictly higher than the current bid');
  }
  const revision = state.revision + 1;
  const bids = replaceAt(state.bids, seat, score);
  const currentBid = score === 0 ? state.currentBid : score;
  const highestBidder = score === 0 ? state.highestBidder : seat;
  const bidActionsTaken = state.bidActionsTaken + 1;
  const history = appendEvent(state.history, revision, 'bid', { seat, score });
  const bidState = deepFreeze({ ...state, bids, currentBid, highestBidder, bidActionsTaken });

  if (score === 3) return finalizeLandlord(bidState, seat, revision, history);
  if (bidActionsTaken === 3) {
    if (highestBidder === null) {
      return createDeal(
        state.matchId,
        state.rngState,
        state.dealNumber + 1,
        revision,
        history,
        nextSeat(state.bidderStart),
      );
    }
    return finalizeLandlord(bidState, highestBidder, revision, history);
  }
  return withTurn(bidState, { history }, revision, 'bidding', nextSeat(seat));
}

function revealBottomAndStart(
  state: DoudizhuState,
  revision: number,
  history: readonly DoudizhuEvent[],
): DoudizhuState {
  const landlord = state.landlordSeat!;
  const hands = replaceAt(state.hands, landlord, sortCards([...state.hands[landlord], ...state.bottom]));
  return withTurn(state, {
    hands,
    bottomRevealed: true,
    trickLeaderSeat: landlord,
    history: appendEvent(history, revision, 'bottom-revealed', { cards: state.bottom }),
  }, revision, 'playing', landlord);
}

function applyDefenderDouble(state: DoudizhuState, seat: Seat, double: boolean): DoudizhuState {
  if (state.phase !== 'defender-double' || state.landlordSeat === null || seat === state.landlordSeat) {
    throw new DoudizhuRuleError('ACTION_NOT_ALLOWED', 'Only a defender may commit a double now');
  }
  if (state.defenderCommitments[seat] !== null) {
    throw new DoudizhuRuleError('ACTION_NOT_ALLOWED', 'This defender has already committed');
  }
  const revision = state.revision + 1;
  const commitments = replaceAt(state.defenderCommitments, seat, double);
  let history = appendEvent(
    state.history,
    revision,
    'defender-double-committed',
    { seat, double },
    { seats: [seat] },
  );
  const defenders = defenderSeats(state.landlordSeat);
  const other = defenders.find((candidate) => commitments[candidate] === null);
  if (other !== undefined) {
    return withTurn(state, { defenderCommitments: commitments, history }, revision, 'defender-double', other);
  }

  const doubles: Triple<boolean | null> = [
    state.landlordSeat === 0 ? null : commitments[0],
    state.landlordSeat === 1 ? null : commitments[1],
    state.landlordSeat === 2 ? null : commitments[2],
  ];
  history = appendEvent(history, revision, 'defender-doubles-revealed', {
    decisions: defenders.map((defender) => ({ seat: defender, double: doubles[defender] })),
  });
  const revealedState = deepFreeze({ ...state, defenderCommitments: commitments, defenderDoubles: doubles, history });
  if (defenders.some((defender) => doubles[defender] === true)) {
    return withTurn(revealedState, {}, revision, 'landlord-redouble', state.landlordSeat);
  }
  return revealBottomAndStart(revealedState, revision, history);
}

function applyLandlordRedouble(state: DoudizhuState, seat: Seat, redouble: boolean): DoudizhuState {
  if (state.phase !== 'landlord-redouble' || seat !== state.landlordSeat) {
    throw new DoudizhuRuleError('ACTION_NOT_ALLOWED', 'Only the landlord may redouble now');
  }
  const revision = state.revision + 1;
  const history = appendEvent(state.history, revision, 'landlord-redoubled', { redouble });
  return revealBottomAndStart(deepFreeze({ ...state, landlordRedoubled: redouble }), revision, history);
}

function requireCardsInHand(hand: readonly CardId[], cards: readonly CardId[]): void {
  const available = new Set(hand);
  if (new Set(cards).size !== cards.length || cards.some((card) => !available.has(card))) {
    throw new DoudizhuRuleError('INVALID_CARDS', 'Every selected card must occur once in the acting hand');
  }
}

function settlementFor(state: DoudizhuState, winningSeat: Seat): RoundSettlement {
  const landlord = state.landlordSeat!;
  const landlordWon = winningSeat === landlord;
  const defenders = defenderSeats(landlord);
  const spring = landlordWon && defenders.every((seat) => state.playsBySeat[seat] === 0)
    ? 'spring'
    : !landlordWon && state.playsBySeat[landlord] === 1
      ? 'anti-spring'
      : null;
  const commonMultiplier = 2 ** (state.bombOrRocketCount + (spring ? 1 : 0));
  const landlordRedoubleMultiplier: 1 | 2 = state.landlordRedoubled ? 2 : 1;
  const defenderStakeMultipliers: Triple<1 | 2> = [
    state.defenderDoubles[0] ? 2 : 1,
    state.defenderDoubles[1] ? 2 : 1,
    state.defenderDoubles[2] ? 2 : 1,
  ];
  const deltas: [number, number, number] = [0, 0, 0];
  for (const defender of defenders) {
    const stake = state.currentBid
      * defenderStakeMultipliers[defender]
      * landlordRedoubleMultiplier
      * commonMultiplier;
    deltas[defender] = landlordWon ? -stake : stake;
    deltas[landlord] += landlordWon ? stake : -stake;
  }
  return deepFreeze({
    winner: landlordWon ? 'landlord' : 'defenders',
    spring,
    baseBid: state.currentBid as 1 | 2 | 3,
    bombAndSpringMultiplier: commonMultiplier,
    landlordRedoubleMultiplier,
    defenderStakeMultipliers,
    scoreDeltas: deltas,
  });
}

function applyPlay(state: DoudizhuState, seat: Seat, cards: readonly CardId[]): DoudizhuState {
  if (state.phase !== 'playing') {
    throw new DoudizhuRuleError('ACTION_NOT_ALLOWED', 'Cards may only be played during play');
  }
  requireCardsInHand(state.hands[seat], cards);
  let combination: Combination;
  try {
    combination = classifyCombination(cards);
  } catch {
    throw new DoudizhuRuleError('INVALID_CARDS', 'The selected cards are not a legal combination');
  }
  if (!canBeatCombination(combination, state.currentTrick?.combination ?? null)) {
    throw new DoudizhuRuleError('MUST_BEAT_CURRENT_PLAY', 'The play must beat the current combination');
  }

  const revision = state.revision + 1;
  const selected = new Set(cards);
  const remainingHand = state.hands[seat].filter((card) => !selected.has(card));
  const hands = replaceAt(state.hands, seat, Object.freeze(remainingHand));
  const playsBySeat = replaceAt(state.playsBySeat, seat, state.playsBySeat[seat] + 1);
  const bombOrRocketCount = state.bombOrRocketCount
    + (combination.kind === 'bomb' || combination.kind === 'rocket' ? 1 : 0);
  const trick: TrickPlay = deepFreeze({ seat, cards: combination.cards, combination });
  let history = appendEvent(state.history, revision, 'played', {
    seat,
    cards: combination.cards,
    combination: {
      kind: combination.kind,
      mainRank: combination.mainRank,
      sequenceLength: combination.sequenceLength,
    },
  });
  const playedState = deepFreeze({
    ...state,
    hands,
    playsBySeat,
    bombOrRocketCount,
    trickLeaderSeat: seat,
    currentTrick: trick,
    consecutivePasses: 0 as const,
  });

  if (remainingHand.length === 0) {
    const settlement = settlementFor(playedState, seat);
    history = appendEvent(history, revision, 'settled', {
      winner: settlement.winner,
      spring: settlement.spring,
      scoreDeltas: settlement.scoreDeltas,
      multiplier: settlement.bombAndSpringMultiplier,
    });
    return withTurn(playedState, {
      settlement,
      scores: settlement.scoreDeltas,
      history,
    }, revision, 'complete', seat);
  }
  return withTurn(playedState, { history }, revision, 'playing', nextSeat(seat));
}

function applyPass(state: DoudizhuState, seat: Seat): DoudizhuState {
  if (state.phase !== 'playing' || !state.currentTrick || state.trickLeaderSeat === seat) {
    throw new DoudizhuRuleError('CANNOT_PASS', 'A leading player cannot pass');
  }
  const revision = state.revision + 1;
  let history = appendEvent(state.history, revision, 'passed', { seat });
  if (state.consecutivePasses === 1) {
    const leader = state.trickLeaderSeat!;
    history = appendEvent(history, revision, 'trick-cleared', { leaderSeat: leader });
    return withTurn(state, {
      currentTrick: null,
      consecutivePasses: 0,
      history,
    }, revision, 'playing', leader);
  }
  return withTurn(state, { consecutivePasses: 1, history }, revision, 'playing', nextSeat(seat));
}

export function applyDoudizhuAction(
  state: Readonly<DoudizhuState>,
  request: Readonly<DoudizhuActionRequest>,
): DoudizhuState {
  if (state.phase === 'complete') throw new DoudizhuRuleError('MATCH_COMPLETE', 'The match is complete');
  if (request.expectedRevision !== state.revision) {
    throw new DoudizhuRuleError('STALE_REVISION', 'The action targets an outdated revision');
  }
  if (request.turnNonce !== state.turnNonce) {
    throw new DoudizhuRuleError('STALE_TURN_NONCE', 'The action targets an outdated turn');
  }
  if (request.seat !== state.currentSeat) {
    throw new DoudizhuRuleError('NOT_YOUR_TURN', 'The acting seat does not own the turn');
  }
  const mutableView = state as DoudizhuState;
  switch (request.action.type) {
    case 'bid': return applyBid(mutableView, request.seat, request.action.score);
    case 'commit-defender-double':
      return applyDefenderDouble(mutableView, request.seat, request.action.double);
    case 'landlord-redouble':
      return applyLandlordRedouble(mutableView, request.seat, request.action.redouble);
    case 'play': return applyPlay(mutableView, request.seat, request.action.cards);
    case 'pass': return applyPass(mutableView, request.seat);
  }
}

export function act(
  state: Readonly<DoudizhuState>,
  action: DoudizhuAction,
): DoudizhuState {
  return applyDoudizhuAction(state, {
    seat: state.currentSeat,
    expectedRevision: state.revision,
    turnNonce: state.turnNonce,
    action,
  });
}
