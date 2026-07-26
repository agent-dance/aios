import { describe, expect, it } from 'vitest';
import { stableSerialize } from '../../game-platform/testkit';
import { createDoudizhuSeed, type CardId, type DoudizhuSeed } from './DoudizhuCards';
import {
  act,
  applyDoudizhuAction,
  createInitialDoudizhuState,
  DoudizhuRuleError,
  type DoudizhuAction,
  type DoudizhuState,
  type Seat,
  type Triple,
} from './DoudizhuEngine';
import { chooseHeuristicAction, createSeatProjection } from './DoudizhuProjection';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));
const create = (seed = 42) => createInitialDoudizhuState({ seed: testSeed(seed), matchId: 'test-match' });
const submit = (state: DoudizhuState, action: DoudizhuAction) => act(state, action);

function reachPlaying(seed = 42, double = false, redouble = false): DoudizhuState {
  let state = create(seed);
  state = submit(state, { type: 'bid', score: 3 });
  state = submit(state, { type: 'commit-defender-double', double });
  state = submit(state, { type: 'commit-defender-double', double });
  if (state.phase === 'landlord-redouble') {
    state = submit(state, { type: 'landlord-redouble', redouble });
  }
  return state;
}

describe('Doudizhu authority engine', () => {
  it('requires a non-empty caller-supplied opaque match id', () => {
    expect(() => createInitialDoudizhuState({ seed: testSeed(42), matchId: ' ' })).toThrow(/non-empty opaque/);
    expect(() => createInitialDoudizhuState({
      seed: 'forged' as DoudizhuSeed,
      matchId: 'invalid-seed',
    })).toThrow(/exactly 64 hexadecimal/);
  });

  it('deals 17×3 plus 3 bottom cards from 54 unique cards deterministically', () => {
    const state = create(0x10203040);
    const repeated = create(0x10203040);
    const allCards = [...state.hands.flat(), ...state.bottom];
    expect(state.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(state.bottom).toHaveLength(3);
    expect(new Set(allCards).size).toBe(54);
    expect(stableSerialize(state)).toBe(stableSerialize(repeated));
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.hands[0])).toBe(true);
  });

  it('allows only pass or a strictly higher bid and finalizes 3 immediately', () => {
    let state = create();
    state = submit(state, { type: 'bid', score: 1 });
    expect(() => submit(state, { type: 'bid', score: 1 })).toThrowError(DoudizhuRuleError);
    state = submit(state, { type: 'bid', score: 3 });
    expect(state.phase).toBe('defender-double');
    expect(state.landlordSeat).not.toBeNull();
    expect(state.hands[state.landlordSeat!]).toHaveLength(17);
  });

  it('redeals deterministically after three passes', () => {
    let first = create(99);
    let repeated = create(99);
    for (let index = 0; index < 3; index += 1) {
      first = submit(first, { type: 'bid', score: 0 });
      repeated = submit(repeated, { type: 'bid', score: 0 });
    }
    expect(first.phase).toBe('bidding');
    expect(first.dealNumber).toBe(1);
    expect(first.bidderStart).toBe(((create(99).bidderStart + 1) % 3) as Seat);
    expect(first.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(stableSerialize(first)).toBe(stableSerialize(repeated));
    expect(first.history.at(-1)?.type).toBe('redealt');
  });

  it('enforces revision, nonce, and seat ownership', () => {
    const state = create();
    expect(() => applyDoudizhuAction(state, {
      seat: state.currentSeat,
      expectedRevision: state.revision + 1,
      turnNonce: state.turnNonce,
      action: { type: 'bid', score: 0 },
    })).toThrowError(expect.objectContaining({ code: 'STALE_REVISION' }));
    expect(() => applyDoudizhuAction(state, {
      seat: state.currentSeat,
      expectedRevision: state.revision,
      turnNonce: 'stale',
      action: { type: 'bid', score: 0 },
    })).toThrowError(expect.objectContaining({ code: 'STALE_TURN_NONCE' }));
    expect(() => applyDoudizhuAction(state, {
      seat: ((state.currentSeat + 1) % 3) as Seat,
      expectedRevision: state.revision,
      turnNonce: state.turnNonce,
      action: { type: 'bid', score: 0 },
    })).toThrowError(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
  });

  it('returns lead to the last player after two passes', () => {
    let state = reachPlaying();
    const leader = state.currentSeat;
    state = submit(state, chooseHeuristicAction(createSeatProjection(state, state.currentSeat)));
    state = submit(state, { type: 'pass' });
    state = submit(state, { type: 'pass' });
    expect(state.currentSeat).toBe(leader);
    expect(state.currentTrick).toBeNull();
    expect(state.consecutivePasses).toBe(0);
  });

  it('settles personal defender doubles, redouble, bomb and spring as a zero-sum result', () => {
    const playing = reachPlaying(7, true, true);
    const landlord = playing.landlordSeat!;
    const defenders = [0, 1, 2].filter((seat) => seat !== landlord) as Seat[];
    const hands: Triple<readonly CardId[]> = [
      ['clubs:9'], ['diamonds:10'], ['hearts:J'],
    ];
    const bomb: readonly CardId[] = ['clubs:3', 'diamonds:3', 'hearts:3', 'spades:3'];
    const crafted: DoudizhuState = {
      ...playing,
      currentSeat: landlord,
      turnNonce: `${playing.matchId}:${playing.revision}:playing:${landlord}`,
      hands: [
        landlord === 0 ? bomb : hands[0],
        landlord === 1 ? bomb : hands[1],
        landlord === 2 ? bomb : hands[2],
      ],
      currentTrick: null,
      trickLeaderSeat: landlord,
      playsBySeat: [0, 0, 0],
      bombOrRocketCount: 0,
    };
    const settled = submit(crafted, { type: 'play', cards: bomb });
    expect(settled.phase).toBe('complete');
    expect(settled.settlement).toMatchObject({
      winner: 'landlord',
      spring: 'spring',
      bombAndSpringMultiplier: 4,
      landlordRedoubleMultiplier: 2,
    });
    expect(settled.scores.reduce((sum, score) => sum + score, 0)).toBe(0);
    expect(settled.scores[landlord]).toBe(96);
    expect(defenders.map((seat) => settled.scores[seat])).toEqual([-48, -48]);
  });

  it('settles anti-spring with asymmetric defender stakes as an exact zero-sum result', () => {
    const playing = reachPlaying(19, false, false);
    const landlord = playing.landlordSeat!;
    const defenders = [0, 1, 2].filter((seat) => seat !== landlord) as Seat[];
    const winner = defenders[0]!;
    const otherDefender = defenders[1]!;
    const hands: [readonly CardId[], readonly CardId[], readonly CardId[]] = [
      ['clubs:4'], ['diamonds:5'], ['hearts:6'],
    ];
    hands[winner] = ['clubs:3'];
    const playsBySeat: [number, number, number] = [0, 0, 0];
    playsBySeat[landlord] = 1;
    const defenderDoubles: [boolean | null, boolean | null, boolean | null] = [null, null, null];
    defenderDoubles[winner] = true;
    defenderDoubles[otherDefender] = false;
    const crafted: DoudizhuState = {
      ...playing,
      currentSeat: winner,
      turnNonce: `${playing.matchId}:${playing.revision}:playing:${winner}`,
      hands,
      currentTrick: null,
      trickLeaderSeat: winner,
      playsBySeat,
      defenderDoubles,
    };

    const settled = submit(crafted, { type: 'play', cards: ['clubs:3'] });
    expect(settled.settlement).toMatchObject({
      winner: 'defenders',
      spring: 'anti-spring',
      bombAndSpringMultiplier: 2,
    });
    expect(settled.scores[winner]).toBe(12);
    expect(settled.scores[otherDefender]).toBe(6);
    expect(settled.scores[landlord]).toBe(-18);
    expect(settled.scores.reduce((sum, score) => sum + score, 0)).toBe(0);
  });

  it('can deterministically finish a complete match using only seat projections', () => {
    const run = () => {
      let state = create(20260726);
      for (let turn = 0; state.phase !== 'complete' && turn < 500; turn += 1) {
        const projection = createSeatProjection(state, state.currentSeat);
        state = submit(state, chooseHeuristicAction(projection));
      }
      expect(state.phase).toBe('complete');
      return stableSerialize(state);
    };
    expect(run()).toBe(run());
  });
});
