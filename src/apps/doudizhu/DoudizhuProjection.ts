import { enumerateStrategicPlays, type Combination } from './DoudizhuCombinations';
import { getCard, type CardId } from './DoudizhuCards';
import {
  type DoudizhuAction,
  type DoudizhuEvent,
  type DoudizhuPhase,
  type DoudizhuState,
  type RoundSettlement,
  type Seat,
  type Triple,
  type TrickPlay,
} from './DoudizhuEngine';

export type SeatRole = 'landlord' | 'defender' | 'unassigned';

export type LegalActionDescriptor =
  | Readonly<{ type: 'bid'; score: 0 | 1 | 2 | 3 }>
  | Readonly<{ type: 'commit-defender-double'; double: boolean }>
  | Readonly<{ type: 'landlord-redouble'; redouble: boolean }>
  | Readonly<{
      type: 'play';
      cards: readonly CardId[];
      combination: Combination;
    }>
  | Readonly<{ type: 'pass' }>;

export interface PublicDoudizhuEvent {
  readonly index: number;
  readonly revision: number;
  readonly type: DoudizhuEvent['type'];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SeatProjection {
  readonly ruleset: DoudizhuState['ruleset'];
  readonly matchId: string;
  readonly seat: Seat;
  readonly role: SeatRole;
  readonly phase: DoudizhuPhase;
  readonly revision: number;
  readonly turnNonce: string;
  readonly currentSeat: Seat;
  readonly ownHand: readonly CardId[];
  readonly publicBottom: readonly CardId[];
  readonly remainingCardCounts: Triple<number>;
  readonly bidderStart: Seat;
  readonly bids: Triple<0 | 1 | 2 | 3 | null>;
  readonly currentBid: 0 | 1 | 2 | 3;
  readonly highestBidder: Seat | null;
  readonly landlordSeat: Seat | null;
  readonly ownDefenderDoubleCommitment: boolean | null;
  readonly revealedDefenderDoubles: Triple<boolean | null>;
  readonly landlordRedoubled: boolean | null;
  readonly bombOrRocketCount: number;
  readonly trickLeaderSeat: Seat | null;
  readonly currentTrick: TrickPlay | null;
  readonly scores: Triple<number>;
  readonly settlement: RoundSettlement | null;
  readonly publicHistory: readonly PublicDoudizhuEvent[];
  readonly legalActions: readonly LegalActionDescriptor[];
}

function visibleTo(event: Readonly<DoudizhuEvent>, seat: Seat): boolean {
  return event.visibility === 'public' || event.visibility.seats.includes(seat);
}

function projectEvents(history: readonly DoudizhuEvent[], seat: Seat): readonly PublicDoudizhuEvent[] {
  return Object.freeze(history
    .filter((event) => visibleTo(event, seat))
    .map(({ revision, type, payload }, index) => Object.freeze({ index, revision, type, payload })));
}

export function getLegalActionDescriptors(
  state: Readonly<DoudizhuState>,
  seat: Seat,
): readonly LegalActionDescriptor[] {
  if (state.phase === 'complete' || seat !== state.currentSeat) return Object.freeze([]);
  switch (state.phase) {
    case 'bidding': {
      const bids: LegalActionDescriptor[] = [{ type: 'bid', score: 0 }];
      for (const score of [1, 2, 3] as const) {
        if (score > state.currentBid) bids.push({ type: 'bid', score });
      }
      bids.forEach((action) => Object.freeze(action));
      return Object.freeze(bids);
    }
    case 'defender-double':
      return Object.freeze([
        Object.freeze({ type: 'commit-defender-double', double: false } as const),
        Object.freeze({ type: 'commit-defender-double', double: true } as const),
      ]);
    case 'landlord-redouble':
      return Object.freeze([
        Object.freeze({ type: 'landlord-redouble', redouble: false } as const),
        Object.freeze({ type: 'landlord-redouble', redouble: true } as const),
      ]);
    case 'playing': {
      const actions: LegalActionDescriptor[] = enumerateStrategicPlays(
        state.hands[seat],
        state.currentTrick?.combination ?? null,
      ).map((combination) => ({ type: 'play', cards: combination.cards, combination }));
      if (state.currentTrick && state.trickLeaderSeat !== seat) actions.push({ type: 'pass' });
      actions.forEach((action) => Object.freeze(action));
      return Object.freeze(actions);
    }
  }
}

export function createSeatProjection(state: Readonly<DoudizhuState>, seat: Seat): SeatProjection {
  const role: SeatRole = state.landlordSeat === null
    ? 'unassigned'
    : state.landlordSeat === seat ? 'landlord' : 'defender';
  return Object.freeze({
    ruleset: state.ruleset,
    matchId: state.matchId,
    seat,
    role,
    phase: state.phase,
    revision: state.revision,
    turnNonce: state.turnNonce,
    currentSeat: state.currentSeat,
    ownHand: state.hands[seat],
    publicBottom: state.bottomRevealed ? state.bottom : Object.freeze([]),
    remainingCardCounts: Object.freeze([
      state.hands[0].length,
      state.hands[1].length,
      state.hands[2].length,
    ] as const),
    bidderStart: state.bidderStart,
    bids: state.bids,
    currentBid: state.currentBid,
    highestBidder: state.highestBidder,
    landlordSeat: state.landlordSeat,
    ownDefenderDoubleCommitment: state.defenderCommitments[seat],
    revealedDefenderDoubles: state.defenderDoubles,
    landlordRedoubled: state.landlordRedoubled,
    bombOrRocketCount: state.bombOrRocketCount,
    trickLeaderSeat: state.trickLeaderSeat,
    currentTrick: state.currentTrick,
    scores: state.scores,
    settlement: state.settlement,
    publicHistory: projectEvents(state.history, seat),
    legalActions: getLegalActionDescriptors(state, seat),
  });
}

/** Returns the highest public single-side stake multiplier; defender stakes may be asymmetric. */
export function calculateDoudizhuMultiplier(projection: Readonly<SeatProjection>): number {
  if (projection.settlement) {
    const settlement = projection.settlement;
    return settlement.baseBid
      * settlement.bombAndSpringMultiplier
      * settlement.landlordRedoubleMultiplier
      * Math.max(...settlement.defenderStakeMultipliers);
  }
  const base = Math.max(1, projection.currentBid);
  const defenderMultiplier = projection.revealedDefenderDoubles.some(Boolean) ? 2 : 1;
  return base
    * defenderMultiplier
    * (projection.landlordRedoubled ? 2 : 1)
    * (2 ** projection.bombOrRocketCount);
}

function handStrength(hand: readonly CardId[]): number {
  const counts = new Map<number, number>();
  let value = 0;
  for (const cardId of hand) {
    const strength = getCard(cardId).strength;
    counts.set(strength, (counts.get(strength) ?? 0) + 1);
    if (strength >= 11) value += strength - 9;
  }
  for (const count of counts.values()) {
    if (count === 4) value += 7;
    else if (count === 3) value += 2;
  }
  if (hand.includes('joker:small') && hand.includes('joker:big')) value += 8;
  return value;
}

function hasDescriptor<T extends LegalActionDescriptor['type']>(
  projection: Readonly<SeatProjection>,
  type: T,
): boolean {
  return projection.legalActions.some((action) => action.type === type);
}

/** Deterministic baseline policy. It has no authority-state parameter by design. */
export function chooseHeuristicAction(projection: Readonly<SeatProjection>): DoudizhuAction {
  if (projection.currentSeat !== projection.seat || projection.legalActions.length === 0) {
    throw new Error('The participant does not own an actionable turn');
  }
  const strength = handStrength(projection.ownHand);
  if (hasDescriptor(projection, 'bid')) {
    const target: 0 | 1 | 2 | 3 = strength >= 24 ? 3 : strength >= 16 ? 2 : strength >= 10 ? 1 : 0;
    const legal = projection.legalActions
      .filter((action): action is Extract<LegalActionDescriptor, { type: 'bid' }> => action.type === 'bid')
      .map((action) => action.score);
    return { type: 'bid', score: legal.includes(target) ? target : 0 };
  }
  if (hasDescriptor(projection, 'commit-defender-double')) {
    return { type: 'commit-defender-double', double: strength >= 18 };
  }
  if (hasDescriptor(projection, 'landlord-redouble')) {
    return { type: 'landlord-redouble', redouble: strength >= 25 };
  }
  if (hasDescriptor(projection, 'play')) {
    const candidate = projection.legalActions.find(
      (action): action is Extract<LegalActionDescriptor, { type: 'play' }> => action.type === 'play',
    );
    if (candidate) return { type: 'play', cards: candidate.cards };
  }
  if (hasDescriptor(projection, 'pass')) return { type: 'pass' };
  throw new Error('No legal action can be selected');
}
