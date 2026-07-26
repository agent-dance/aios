import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPACE_GAME_SEAT_ID,
  createSpaceGameMatch,
  type SpaceGameAction,
} from './SpaceGameAgentAdapter';
import { createSpaceGameAgentDriver, type SpaceGameAgentController } from './SpaceGameAgentController';

afterEach(() => {
  vi.useRealTimers();
});

describe('SpaceGameAgentDriver', () => {
  it('replans on the bounded cadence and latches chosen controls', async () => {
    vi.useFakeTimers();
    const match = createSpaceGameMatch({ matchId: 'agent-driver' });
    const port = match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'agent', kind: 'agent' });
    const actions: SpaceGameAction[] = [
      { type: 'start' },
      { type: 'control', movement: 'east', fire: true, aim: { column: 4, row: 1 } },
    ];
    const controller: SpaceGameAgentController = {
      chooseAction: vi.fn(async (): Promise<SpaceGameAction> => actions.shift() ?? { type: 'pause' }),
    };
    const driver = createSpaceGameAgentDriver({
      controller,
      port,
      seatSessionKey: 'opaque-agent-seat',
      replanIntervalMs: 350,
    });

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(port.observe().observation.mode).toBe('playing');
    await vi.advanceTimersByTimeAsync(349);
    expect(controller.chooseAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.chooseAction).toHaveBeenCalledTimes(2);
    expect(port.observe().observation.currentControl).toEqual({
      movement: 'east',
      fire: true,
      aim: { column: 4, row: 1 },
    });
    driver.stop();
  });

  it('aborts in-flight work and ignores late controller completion', async () => {
    vi.useFakeTimers();
    const match = createSpaceGameMatch({ matchId: 'agent-cancel' });
    const port = match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'agent', kind: 'agent' });
    let resolve!: (action: SpaceGameAction) => void;
    let receivedSignal: AbortSignal | undefined;
    const controller: SpaceGameAgentController = {
      chooseAction: (_input, signal) => {
        receivedSignal = signal;
        return new Promise((settle) => {
          resolve = settle;
        });
      },
    };
    const driver = createSpaceGameAgentDriver({ controller, port, seatSessionKey: 'cancel-seat' });
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    driver.stop();
    expect(receivedSignal?.aborted).toBe(true);
    resolve({ type: 'start' });
    await Promise.resolve();
    expect(port.observe().observation.mode).toBe('start');
    expect(driver.running).toBe(false);
  });

  it('survives stale and controller failures without unsafe fallback actions', async () => {
    vi.useFakeTimers();
    const match = createSpaceGameMatch({ matchId: 'agent-failure' });
    const port = match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'agent', kind: 'agent' });
    const errors: unknown[] = [];
    const controller: SpaceGameAgentController = {
      chooseAction: vi
        .fn<SpaceGameAgentController['chooseAction']>()
        .mockRejectedValueOnce(new Error('sidecar unavailable'))
        .mockResolvedValue({ type: 'start' }),
    };
    const driver = createSpaceGameAgentDriver({
      controller,
      port,
      seatSessionKey: 'failure-seat',
      replanIntervalMs: 250,
      onError: (error) => errors.push(error),
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(port.observe().observation.mode).toBe('start');
    await vi.advanceTimersByTimeAsync(250);
    expect(port.observe().observation.mode).toBe('playing');
    driver.stop();
  });

  it('uses non-conflicting request ids after lifecycle stop and restart', async () => {
    vi.useFakeTimers();
    const match = createSpaceGameMatch({ matchId: 'agent-lifecycle-restart' });
    const port = match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'agent', kind: 'agent' });
    const first = createSpaceGameAgentDriver({
      controller: { chooseAction: async () => ({ type: 'start' }) },
      port,
      seatSessionKey: 'same-seat-session',
    });
    first.start();
    await vi.advanceTimersByTimeAsync(0);
    first.stop();

    const second = createSpaceGameAgentDriver({
      controller: {
        chooseAction: async () => ({
          type: 'control',
          movement: 'west',
          fire: false,
          aim: { column: 0, row: 1 },
        }),
      },
      port,
      seatSessionKey: 'same-seat-session',
    });
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(port.observe().observation.currentControl.movement).toBe('west');
    second.stop();
  });
});
