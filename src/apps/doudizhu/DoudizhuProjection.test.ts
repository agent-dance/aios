import { describe, expect, it } from 'vitest';
import { act, createInitialDoudizhuState, type DoudizhuState, type Seat } from './DoudizhuEngine';
import { createDoudizhuSeed } from './DoudizhuCards';
import {
  calculateDoudizhuMultiplier,
  chooseHeuristicAction,
  createSeatProjection,
} from './DoudizhuProjection';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));

const bidThree = (): DoudizhuState => {
  const initial = createInitialDoudizhuState({ seed: testSeed(314159), matchId: 'projection-test' });
  return act(initial, { type: 'bid', score: 3 });
};

describe('SeatProjection information boundary', () => {
  it('contains own cards and counts while excluding opponent cards, seed, deck and full hands', () => {
    const state = createInitialDoudizhuState({ seed: testSeed(123), matchId: 'secret-test' });
    const seat: Seat = 0;
    const projection = createSeatProjection(state, seat);
    const serialized = JSON.stringify(projection);
    expect(projection.ownHand).toEqual(state.hands[seat]);
    expect(projection.remainingCardCounts).toEqual([17, 17, 17]);
    expect(projection.publicBottom).toEqual([]);
    expect(Object.keys(projection)).not.toEqual(expect.arrayContaining(['rngState', 'seed', 'deck', 'hands', 'bottom']));
    for (const opponent of [1, 2] as const) {
      for (const card of state.hands[opponent]) expect(serialized).not.toContain(`\"${card}\"`);
    }
    for (const card of state.bottom) expect(serialized).not.toContain(`\"${card}\"`);
  });

  it('keeps the first defender commitment private, then reveals both simultaneously', () => {
    let state = bidThree();
    const firstDefender = state.currentSeat;
    const secondDefender = ([0, 1, 2] as const)
      .find((seat) => seat !== state.landlordSeat && seat !== firstDefender)!;
    state = act(state, { type: 'commit-defender-double', double: true });

    const ownerView = createSeatProjection(state, firstDefender);
    const otherView = createSeatProjection(state, secondDefender);
    const landlordView = createSeatProjection(state, state.landlordSeat!);
    expect(landlordView.ownHand).toHaveLength(17);
    expect(landlordView.publicBottom).toEqual([]);
    expect(ownerView.ownDefenderDoubleCommitment).toBe(true);
    expect(ownerView.publicHistory.some((event) => event.type === 'defender-double-committed')).toBe(true);
    expect(otherView.ownDefenderDoubleCommitment).toBeNull();
    expect(otherView.publicHistory.some((event) => event.type === 'defender-double-committed')).toBe(false);
    expect(landlordView.publicHistory.some((event) => event.type === 'defender-double-committed')).toBe(false);
    for (const view of [ownerView, otherView, landlordView]) {
      expect(view.publicHistory.map((event) => event.index)).toEqual(
        view.publicHistory.map((_, index) => index),
      );
    }
    expect(otherView.revealedDefenderDoubles).toEqual([null, null, null]);

    state = act(state, { type: 'commit-defender-double', double: false });
    for (const seat of [0, 1, 2] as const) {
      const view = createSeatProjection(state, seat);
      expect(view.publicHistory.some((event) => event.type === 'defender-doubles-revealed')).toBe(true);
      expect(view.revealedDefenderDoubles[firstDefender]).toBe(true);
      expect(view.revealedDefenderDoubles[secondDefender]).toBe(false);
      expect(view.publicBottom).toEqual([]);
    }
    expect(state.phase).toBe('landlord-redouble');
    state = act(state, { type: 'landlord-redouble', redouble: false });
    expect(state.phase).toBe('playing');
    expect(state.hands[state.landlordSeat!]).toHaveLength(20);
    for (const seat of [0, 1, 2] as const) {
      expect(createSeatProjection(state, seat).publicBottom).toEqual(state.bottom);
    }
  });

  it('exposes identical actionable capabilities to participant implementations', () => {
    let state = createInitialDoudizhuState({ seed: testSeed(88), matchId: 'parity-test' });
    let projection = createSeatProjection(state, state.currentSeat);
    expect(projection.legalActions).toEqual([
      { type: 'bid', score: 0 },
      { type: 'bid', score: 1 },
      { type: 'bid', score: 2 },
      { type: 'bid', score: 3 },
    ]);
    state = act(state, chooseHeuristicAction(projection));
    projection = createSeatProjection(state, state.currentSeat);
    expect(() => act(state, chooseHeuristicAction(projection))).not.toThrow();
  });

  it('projects the public bomb and rocket count for live multiplier rendering', () => {
    const state = createInitialDoudizhuState({ seed: testSeed(9), matchId: 'public-multiplier' });
    const projection = createSeatProjection({ ...state, currentBid: 3, bombOrRocketCount: 2 }, 0);
    expect(projection.bombOrRocketCount).toBe(2);
    expect(calculateDoudizhuMultiplier(projection)).toBe(12);
    expect(calculateDoudizhuMultiplier({
      ...projection,
      revealedDefenderDoubles: [null, true, false],
    })).toBe(24);
  });
});
