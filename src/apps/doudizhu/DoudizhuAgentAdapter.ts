import {
  AGAP_PROTOCOL_NAME,
  AGAP_PROTOCOL_VERSION,
  type EventAudience,
  type LegalAction,
  type SequentialGameAdapter,
} from '../../game-platform/agent';
import {
  applyDoudizhuAction,
  createInitialDoudizhuState,
  DOUDIZHU_RULESET,
  type DoudizhuAction,
  type DoudizhuEvent,
  type DoudizhuPhase,
  type DoudizhuState,
  type Seat,
} from './DoudizhuEngine';
import { classifyCombination, FOUR_WITH_TWO_POLICY } from './DoudizhuCombinations';
import { getCard, sortCards, type CardId, type DoudizhuSeed } from './DoudizhuCards';
import {
  createSeatProjection,
  getLegalActionDescriptors,
  type LegalActionDescriptor,
  type SeatProjection,
} from './DoudizhuProjection';

export const DOUDIZHU_SEAT_IDS = ['seat-0', 'seat-1', 'seat-2'] as const;
export type DoudizhuSeatId = (typeof DOUDIZHU_SEAT_IDS)[number];

export interface DoudizhuAgentMetadata {
  readonly ruleset: typeof DOUDIZHU_RULESET;
  readonly playerCount: 3;
  readonly bidding: 'score-0-to-3';
  readonly hiddenInformation: true;
  readonly cardOrdering: 'canonical';
  readonly fourWithTwoPolicy: typeof FOUR_WITH_TWO_POLICY;
  readonly actionTypes: readonly DoudizhuAction['type'][];
}

/** A domain event with authorization moved into the AGAP event audience. */
export interface DoudizhuAgentEvent {
  readonly revision: number;
  readonly type: DoudizhuEvent['type'];
  readonly payload: Readonly<Record<string, unknown>>;
}

export type DoudizhuAgentAdapter = SequentialGameAdapter<
  DoudizhuState,
  DoudizhuSeatId,
  DoudizhuPhase,
  SeatProjection,
  DoudizhuAction,
  DoudizhuAgentEvent,
  DoudizhuAgentMetadata
>;

export interface CreateDoudizhuAgentAdapterOptions {
  readonly seed: DoudizhuSeed;
  readonly matchId: string;
}

const DOMAIN_SEATS: Readonly<Record<DoudizhuSeatId, Seat>> = Object.freeze({
  'seat-0': 0,
  'seat-1': 1,
  'seat-2': 2,
});

export function toDoudizhuSeatId(seat: Seat): DoudizhuSeatId {
  return DOUDIZHU_SEAT_IDS[seat];
}

export function toDomainSeat(seatId: DoudizhuSeatId): Seat {
  return DOMAIN_SEATS[seatId];
}

export const DOUDIZHU_AGENT_DESCRIPTOR: DoudizhuAgentAdapter['descriptor'] = Object.freeze({
  protocol: Object.freeze({ name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION }),
  gameId: 'alsniper.doudizhu',
  gameVersion: '1.0.0',
  displayName: '斗地主',
  turnModel: 'sequential',
  informationModel: 'imperfect',
  seats: Object.freeze([
    Object.freeze({ id: 'seat-0' as const, label: '座位 1' }),
    Object.freeze({ id: 'seat-1' as const, label: '座位 2' }),
    Object.freeze({ id: 'seat-2' as const, label: '座位 3' }),
  ]),
  metadata: Object.freeze({
    ruleset: DOUDIZHU_RULESET,
    playerCount: 3 as const,
    bidding: 'score-0-to-3' as const,
    hiddenInformation: true as const,
    cardOrdering: 'canonical' as const,
    fourWithTwoPolicy: FOUR_WITH_TWO_POLICY,
    actionTypes: Object.freeze([
      'bid',
      'commit-defender-double',
      'landlord-redouble',
      'play',
      'pass',
    ] as const),
  }),
});

function actionFromDescriptor(descriptor: Readonly<LegalActionDescriptor>): DoudizhuAction {
  switch (descriptor.type) {
    case 'bid':
      return { type: 'bid', score: descriptor.score };
    case 'commit-defender-double':
      return { type: 'commit-defender-double', double: descriptor.double };
    case 'landlord-redouble':
      return { type: 'landlord-redouble', redouble: descriptor.redouble };
    case 'play':
      return { type: 'play', cards: descriptor.cards };
    case 'pass':
      return { type: 'pass' };
  }
}

function chooseCards(cards: readonly CardId[], count: number): readonly (readonly CardId[])[] {
  if (count === 0) return [[]];
  if (cards.length < count) return [];
  const selections: CardId[][] = [];
  const visit = (start: number, selected: CardId[]) => {
    if (selected.length === count) {
      selections.push([...selected]);
      return;
    }
    const remaining = count - selected.length;
    for (let index = start; index <= cards.length - remaining; index += 1) {
      selected.push(cards[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return selections;
}

function expandConcretePlay(
  hand: readonly CardId[],
  descriptor: Extract<LegalActionDescriptor, { readonly type: 'play' }>,
): readonly Extract<LegalActionDescriptor, { readonly type: 'play' }>[] {
  const requiredByRank = new Map<number, number>();
  for (const cardId of descriptor.cards) {
    const rank = getCard(cardId).strength;
    requiredByRank.set(rank, (requiredByRank.get(rank) ?? 0) + 1);
  }
  const handByRank = new Map<number, CardId[]>();
  for (const cardId of hand) {
    const rank = getCard(cardId).strength;
    const cards = handByRank.get(rank) ?? [];
    cards.push(cardId);
    handByRank.set(rank, cards);
  }

  let concreteSelections: readonly (readonly CardId[])[] = [[]];
  for (const [rank, count] of [...requiredByRank].sort(([left], [right]) => left - right)) {
    const rankSelections = chooseCards(handByRank.get(rank) ?? [], count);
    concreteSelections = concreteSelections.flatMap((prefix) =>
      rankSelections.map((selection) => [...prefix, ...selection]));
  }
  return concreteSelections.map((cards) => {
    const canonicalCards = sortCards(cards);
    return Object.freeze({
      type: 'play' as const,
      cards: canonicalCards,
      combination: classifyCombination(canonicalCards),
    });
  });
}

/**
 * Expands rank-equivalent strategic moves into every concrete CardId action.
 * This is the canonical legality surface shared by observations and AGAP ports.
 */
export function getCompleteDoudizhuLegalActionDescriptors(
  state: Readonly<DoudizhuState>,
  seat: Seat,
): readonly LegalActionDescriptor[] {
  const descriptors = getLegalActionDescriptors(state, seat);
  const complete: LegalActionDescriptor[] = [];
  const playIdentities = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.type !== 'play') {
      complete.push(descriptor);
      continue;
    }
    for (const concrete of expandConcretePlay(state.hands[seat], descriptor)) {
      const identity = concrete.cards.join('|');
      if (!playIdentities.has(identity)) {
        playIdentities.add(identity);
        complete.push(concrete);
      }
    }
  }
  return Object.freeze(complete);
}

function observeSeat(state: Readonly<DoudizhuState>, seatId: DoudizhuSeatId): SeatProjection {
  const seat = toDomainSeat(seatId);
  const projection = createSeatProjection(state, seat);
  return Object.freeze({
    ...projection,
    legalActions: getCompleteDoudizhuLegalActionDescriptors(state, seat),
  });
}

function labelAction(descriptor: Readonly<LegalActionDescriptor>): string {
  switch (descriptor.type) {
    case 'bid':
      return descriptor.score === 0 ? '不叫' : `叫 ${descriptor.score} 分`;
    case 'commit-defender-double':
      return descriptor.double ? '加倍' : '不加倍';
    case 'landlord-redouble':
      return descriptor.redouble ? '超级加倍' : '不超级加倍';
    case 'play':
      return `出牌：${descriptor.cards.join(' ')}`;
    case 'pass':
      return '不出';
  }
}

function legalActionsFor(
  state: Readonly<DoudizhuState>,
  seatId: DoudizhuSeatId,
): readonly LegalAction<DoudizhuAction>[] {
  return getCompleteDoudizhuLegalActionDescriptors(state, toDomainSeat(seatId)).map((descriptor) => ({
    action: actionFromDescriptor(descriptor),
    label: labelAction(descriptor),
  }));
}

function audienceFor(visibility: DoudizhuEvent['visibility']): EventAudience<DoudizhuSeatId> {
  return visibility === 'public'
    ? { kind: 'all' }
    : { kind: 'seats', seatIds: visibility.seats.map(toDoudizhuSeatId) };
}

function publishHistoryDelta(
  previousLength: number,
  nextHistory: readonly DoudizhuEvent[],
): NonNullable<ReturnType<DoudizhuAgentAdapter['transition']>['events']> {
  return nextHistory.slice(previousLength).map((event) => ({
    audience: audienceFor(event.visibility),
    data: {
      revision: event.revision,
      type: event.type,
      payload: event.payload,
    },
  }));
}

export function createDoudizhuAgentAdapter(
  options: Readonly<CreateDoudizhuAgentAdapterOptions>,
): DoudizhuAgentAdapter {
  const adapter: DoudizhuAgentAdapter = {
    descriptor: DOUDIZHU_AGENT_DESCRIPTOR,
    createInitialState: () => createInitialDoudizhuState(options),
    getPhase: (state) => state.phase,
    isTerminal: (state) => state.phase === 'complete',
    getActiveSeatId: (state) => state.phase === 'complete' ? null : toDoudizhuSeatId(state.currentSeat),
    observe: observeSeat,
    legalActions: legalActionsFor,
    transition: (state, seatId, action) => {
      const nextState = applyDoudizhuAction(state, {
        seat: toDomainSeat(seatId),
        expectedRevision: state.revision,
        turnNonce: state.turnNonce,
        action,
      });
      return {
        state: nextState,
        events: publishHistoryDelta(state.history.length, nextState.history),
      };
    },
  };
  return Object.freeze(adapter);
}
