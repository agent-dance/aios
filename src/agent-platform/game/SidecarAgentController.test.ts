import { describe, expect, it, vi } from 'vitest';
import type { LegalActionSet, SeatObservation } from '../../game-platform/agent';
import type { GameDecisionRequest } from '../protocol';
import { SidecarClientError } from '../sidecarClient';
import { AgentControllerError, createSidecarAgentController } from './SidecarAgentController';

type Action = { readonly type: 'pass' } | { readonly type: 'play'; readonly cards: readonly string[] };
const observation: SeatObservation<'seat-a', 'play', { readonly hand: readonly string[] }, 'sequential'> = {
  matchId: 'match-public', seatId: 'seat-a', revision: 4, terminal: false,
  decision: { mode: 'sequential', phase: 'play', activeSeatIds: ['seat-a'], turnNonce: 'turn-4' },
  observation: { hand: ['c1', 'c2'] },
};
const legalActions: LegalActionSet<'seat-a', 'play', Action, 'sequential'> = {
  ...observation,
  actions: [{ action: { type: 'pass' }, label: 'Pass' }, { action: { type: 'play', cards: ['c1'] }, label: 'Play c1' }],
};
const input = { gameId: 'cards.game', gameVersion: '1.0.0', matchId: 'match-public', seatKey: 'opaque-seat-capability', observation, legalActions };
type Controller = ReturnType<typeof createSidecarAgentController<'seat-a', 'play', { readonly hand: readonly string[] }, Action, 'sequential'>>;
const createController = (options: Parameters<typeof createSidecarAgentController<'seat-a', 'play', { readonly hand: readonly string[] }, Action, 'sequential'>>[0]): Controller =>
  createSidecarAgentController<'seat-a', 'play', { readonly hand: readonly string[] }, Action, 'sequential'>(options);

describe('SidecarAgentController', () => {
  it('maps a decision-local opaque reference back to the original legal action and captured act request', async () => {
    let captured: GameDecisionRequest | undefined;
    const controller = createController({
      client: { decide: async (request) => {
        captured = request;
        return { requestId: request.requestId, runId: 'run-1', actionId: request.legalActions[1]?.id ?? '' };
      } },
      opaqueId: () => 'decision-secret', requestId: () => 'agent-turn-4',
    });
    const decision = await controller.decide(input);
    expect(decision.action).toBe(legalActions.actions[1]?.action);
    expect(decision.actRequest).toEqual({ requestId: 'agent-turn-4', expectedRevision: 4, expectedPhase: 'play', turnNonce: 'turn-4', action: legalActions.actions[1]?.action });
    expect(captured?.seatId).toBe('opaque-seat-capability');
    expect(captured?.legalActions.map((entry) => entry.id)).toEqual(['decision-secret:0', 'decision-secret:1']);
  });

  it('falls back only to an action from the same captured legal set', async () => {
    const controller = createController({
      client: { decide: async () => { throw new SidecarClientError('SIDECAR_TIMEOUT', 'timeout'); } },
      fallback: () => ({ type: 'pass' }),
      opaqueId: () => 'decision', requestId: () => 'request',
    });
    expect(await controller.chooseAction(input)).toBe(legalActions.actions[0]?.action);

    const invalid = createController({
      client: { decide: async () => { throw new Error('unavailable'); } },
      fallback: () => ({ type: 'play', cards: ['not-legal'] }),
      opaqueId: () => 'decision', requestId: () => 'request',
    });
    await expect(invalid.decide(input)).rejects.toMatchObject({ code: 'AGENT_DECISION_INVALID_FALLBACK' });
  });

  it('rejects stale mixed windows before contacting the sidecar', async () => {
    const decide = vi.fn();
    const controller = createController({ client: { decide }, opaqueId: () => 'decision' });
    await expect(controller.decide({ ...input, legalActions: { ...legalActions, revision: 5 } }))
      .rejects.toMatchObject({ code: 'AGENT_DECISION_INVALID_CONTEXT' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('does not convert explicit cancellation into a gameplay action', async () => {
    const abort = new AbortController();
    const fallback = vi.fn((): Action => ({ type: 'pass' }));
    const controller = createController({
      client: { decide: async (_request, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new SidecarClientError('SIDECAR_ABORTED', 'cancelled')), { once: true });
      }) },
      fallback, opaqueId: () => 'decision', requestId: () => 'request',
    });
    const pending = controller.decide(input, abort.signal);
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(AgentControllerError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects an unknown action reference when no fallback is configured', async () => {
    const controller = createController({
      client: { decide: async (request) => ({ requestId: request.requestId, runId: 'run', actionId: 'fabricated' }) },
      opaqueId: () => 'decision', requestId: () => 'request',
    });
    await expect(controller.decide(input)).rejects.toMatchObject({ code: 'AGENT_DECISION_UNAVAILABLE' });
  });
});
