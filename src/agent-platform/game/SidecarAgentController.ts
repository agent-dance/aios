import type {
  ActRequest,
  LegalAction,
  LegalActionSet,
  ParticipantPort,
  SeatObservation,
  TurnModel,
} from '../../game-platform/agent';
import type { GameDecisionRequest, UsageSummary } from '../protocol';
import type { RequestOptions, SidecarClient } from '../sidecarClient';
import { SidecarClientError } from '../sidecarClient';
import { assertJsonValue, stableSerialize } from '../validation';

export interface AgentDecisionInput<
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Mode extends TurnModel = TurnModel,
> {
  readonly gameId: string;
  readonly gameVersion: string;
  readonly matchId: string;
  /** Opaque, Host-assigned sidecar session key. It is not an AGAP authorization token. */
  readonly seatKey: string;
  readonly observation: SeatObservation<SeatId, Phase, Observation, Mode>;
  readonly legalActions: LegalActionSet<SeatId, Phase, Action, Mode>;
}

export interface AgentActionDecision<Phase extends string, Action> {
  readonly action: Action;
  readonly actionRef: string;
  readonly source: 'sidecar' | 'fallback';
  readonly runId?: string;
  readonly usage?: UsageSummary;
  /** Submit this exact captured request; do not re-observe and wrap the old action. */
  readonly actRequest: ActRequest<Phase, Action>;
}

export type AgentFallback<SeatId extends string, Phase extends string, Observation, Action, Mode extends TurnModel> =
  (input: AgentDecisionInput<SeatId, Phase, Observation, Action, Mode>) => Action | Promise<Action>;

export type AgentControllerErrorCode =
  | 'AGENT_DECISION_INVALID_CONTEXT'
  | 'AGENT_DECISION_TERMINAL'
  | 'AGENT_DECISION_NOT_ACTIVE'
  | 'AGENT_DECISION_NO_LEGAL_ACTIONS'
  | 'AGENT_DECISION_CANCELLED'
  | 'AGENT_DECISION_UNAVAILABLE'
  | 'AGENT_DECISION_INVALID_ACTION_REF'
  | 'AGENT_DECISION_INVALID_FALLBACK';

export class AgentControllerError extends Error {
  readonly code: AgentControllerErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: AgentControllerErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'AgentControllerError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export interface SidecarAgentController<
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Mode extends TurnModel = TurnModel,
> {
  decide(
    input: AgentDecisionInput<SeatId, Phase, Observation, Action, Mode>,
    signal?: AbortSignal,
  ): Promise<AgentActionDecision<Phase, Action>>;
  chooseAction(
    input: AgentDecisionInput<SeatId, Phase, Observation, Action, Mode>,
    signal?: AbortSignal,
  ): Promise<Action>;
}

interface CreateSidecarAgentControllerOptions<
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Mode extends TurnModel,
> {
  readonly client: Pick<SidecarClient, 'decide'>;
  readonly fallback?: AgentFallback<SeatId, Phase, Observation, Action, Mode>;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
  readonly opaqueId?: () => string;
}

const defaultOpaqueId = (): string => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new AgentControllerError('AGENT_DECISION_UNAVAILABLE', 'Secure randomness is unavailable for decision-local action references.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const decisionFieldsMatch = <SeatId extends string, Phase extends string, Mode extends TurnModel>(
  observation: SeatObservation<SeatId, Phase, unknown, Mode>,
  legal: LegalActionSet<SeatId, Phase, unknown, Mode>,
): boolean => observation.matchId === legal.matchId
  && observation.seatId === legal.seatId
  && observation.revision === legal.revision
  && observation.terminal === legal.terminal
  && stableSerialize(observation.decision) === stableSerialize(legal.decision);

const findOriginalAction = <Action>(candidate: Action, legal: readonly LegalAction<Action>[]): Action | undefined => {
  let serialized: string;
  try { serialized = stableSerialize(assertJsonValue(candidate, 'fallback.action')); } catch { return undefined; }
  return legal.find((entry) => stableSerialize(entry.action) === serialized)?.action;
};

export const captureAgentDecisionInput = <
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Event,
  Metadata,
  Mode extends TurnModel,
>(
  port: ParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata, Mode>,
  identity: { readonly gameId: string; readonly gameVersion: string; readonly matchId: string; readonly seatKey: string },
): AgentDecisionInput<SeatId, Phase, Observation, Action, Mode> => Object.freeze({
  ...identity,
  observation: port.observe(),
  legalActions: port.listLegalActions(),
});

export const createSidecarAgentController = <
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Mode extends TurnModel = TurnModel,
>(options: CreateSidecarAgentControllerOptions<SeatId, Phase, Observation, Action, Mode>): SidecarAgentController<SeatId, Phase, Observation, Action, Mode> => {
  const opaqueId = options.opaqueId ?? defaultOpaqueId;
  const requestId = options.requestId ?? (() => `game-${opaqueId()}`);

  const decide = async (
    input: AgentDecisionInput<SeatId, Phase, Observation, Action, Mode>,
    signal?: AbortSignal,
  ): Promise<AgentActionDecision<Phase, Action>> => {
    if (!decisionFieldsMatch(input.observation, input.legalActions)
      || input.matchId !== input.observation.matchId
      || input.gameId.length === 0
      || input.gameVersion.length === 0
      || input.seatKey.length === 0) {
      throw new AgentControllerError('AGENT_DECISION_INVALID_CONTEXT', 'Observation and legal actions are not from the same decision window.');
    }
    if (input.observation.terminal) throw new AgentControllerError('AGENT_DECISION_TERMINAL', 'A terminal match has no Agent decision.');
    if (!input.observation.decision.activeSeatIds.includes(input.observation.seatId)) {
      throw new AgentControllerError('AGENT_DECISION_NOT_ACTIVE', 'The bound participant is not active in this decision window.', { retryable: true });
    }
    if (input.legalActions.actions.length === 0) {
      throw new AgentControllerError('AGENT_DECISION_NO_LEGAL_ACTIONS', 'The active decision window has no legal actions.');
    }

    const decisionId = opaqueId();
    const actionMap = new Map<string, Action>();
    const legalActions = input.legalActions.actions.map((entry, index) => {
      const id = `${decisionId}:${index}`;
      actionMap.set(id, entry.action);
      return Object.freeze({
        id,
        label: entry.label,
        action: assertJsonValue(entry.action, `legalActions[${index}].action`),
      });
    });
    const turnRequestId = requestId();
    const wireRequest: GameDecisionRequest = {
      requestId: turnRequestId,
      gameId: input.gameId,
      gameVersion: input.gameVersion,
      matchId: input.matchId,
      seatId: input.seatKey,
      observation: {
        revision: input.observation.revision,
        terminal: input.observation.terminal,
        decision: {
          mode: input.observation.decision.mode,
          phase: input.observation.decision.phase,
          activeSeatIds: input.observation.decision.activeSeatIds.map((seatId) =>
            seatId === input.observation.seatId ? input.seatKey : seatId),
          turnNonce: input.observation.decision.turnNonce,
        },
        observation: assertJsonValue(input.observation.observation, 'observation.observation'),
      },
      legalActions,
    };

    const makeDecision = (action: Action, actionRef: string, source: 'sidecar' | 'fallback', runId?: string, usage?: UsageSummary): AgentActionDecision<Phase, Action> => Object.freeze({
      action,
      actionRef,
      source,
      ...(runId === undefined ? {} : { runId }),
      ...(usage === undefined ? {} : { usage }),
      actRequest: Object.freeze({
        requestId: turnRequestId,
        expectedRevision: input.observation.revision,
        expectedPhase: input.observation.decision.phase,
        turnNonce: input.observation.decision.turnNonce,
        action,
      }),
    });

    const runFallback = async (cause: unknown): Promise<AgentActionDecision<Phase, Action>> => {
      if (!options.fallback) throw new AgentControllerError('AGENT_DECISION_UNAVAILABLE', 'Sidecar decision failed and no fallback is configured.', { retryable: true, cause });
      const selected = await options.fallback(input);
      const original = findOriginalAction(selected, input.legalActions.actions);
      if (original === undefined) throw new AgentControllerError('AGENT_DECISION_INVALID_FALLBACK', 'Fallback selected an action outside the captured legal set.', { cause });
      const entry = [...actionMap.entries()].find(([, action]) => action === original);
      if (!entry) throw new AgentControllerError('AGENT_DECISION_INVALID_FALLBACK', 'Fallback action could not be mapped to the decision-local set.', { cause });
      return makeDecision(original, entry[0], 'fallback');
    };

    try {
      const requestOptions: RequestOptions = { ...(signal ? { signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
      const response = await options.client.decide(wireRequest, requestOptions);
      const action = actionMap.get(response.actionId);
      if (action === undefined) throw new AgentControllerError('AGENT_DECISION_INVALID_ACTION_REF', 'Sidecar selected an unknown action reference.');
      return makeDecision(action, response.actionId, 'sidecar', response.runId, response.usage);
    } catch (error) {
      if (signal?.aborted || (error instanceof SidecarClientError && error.code === 'SIDECAR_ABORTED')) {
        throw new AgentControllerError('AGENT_DECISION_CANCELLED', 'Agent decision was cancelled.', { cause: error });
      }
      return runFallback(error);
    }
  };

  return Object.freeze({
    decide,
    chooseAction: async (
      input: AgentDecisionInput<SeatId, Phase, Observation, Action, Mode>,
      signal?: AbortSignal,
    ) => (await decide(input, signal)).action,
  });
};
