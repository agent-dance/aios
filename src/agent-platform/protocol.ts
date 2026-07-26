import type { AgentContribution, AgentManifest, OsCapability } from './agentManifest';
import type { A2uiSurface } from './a2ui';
import type { OsIntent, SystemStatusSnapshot } from './intents';
import type { JsonValue } from './validation';

export const AIOS_AGENT_PROTOCOL_VERSION = '1.0.0' as const;
export const AIOS_AGENT_DEBUG_PROFILE = 'agent-debug.v1' as const;

export interface HealthResponse {
  readonly protocolVersion: typeof AIOS_AGENT_PROTOCOL_VERSION;
  readonly status: 'ready' | 'not_ready';
  readonly agent: {
    readonly driver: 'codex';
    readonly authMode: 'linked';
    readonly profileIsolated: true;
  };
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly maxConcurrentRuns: number;
  };
  readonly checks: readonly {
    readonly code: string;
    readonly status: 'pass' | 'warn' | 'fail';
    readonly message: string;
  }[];
}

export interface OsContextSnapshot {
  readonly osRevision: number;
  readonly locale?: string;
  readonly activeAppId?: string;
  readonly theme?: string;
  readonly installedAppIds?: readonly string[];
  readonly installedAgentIds?: readonly string[];
  readonly systemStatus?: SystemStatusSnapshot;
  readonly runningGameIds?: readonly string[];
  readonly enabledAgents?: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly capabilities: readonly OsCapability[];
    readonly contributions: readonly AgentContribution[];
  }[];
  readonly runningGames?: readonly {
    readonly gameId: string;
    readonly matchId: string;
    readonly controlledSeatIds: readonly string[];
  }[];
}

export interface ChatRequest {
  readonly requestId: string;
  readonly threadId: string;
  readonly message: string;
  readonly history?: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly context: OsContextSnapshot;
  /** Browser-only opt-in. The client wraps this request for the trace endpoint. */
  readonly debug?: {
    readonly profile: typeof AIOS_AGENT_DEBUG_PROFILE;
  };
}

export type AgentDebugSource = 'sidecar' | 'runtime' | 'broker';
export type AgentDebugStage = 'request' | 'analysis' | 'decision' | 'authorization' | 'completion';
export type AgentDebugStatus = 'started' | 'completed' | 'info' | 'failed';

/**
 * A deliberately summary-only observability projection. It is neither a raw
 * chain-of-thought channel nor an authority/receipt record.
 */
export interface AgentDebugEvent {
  readonly kind: 'trace';
  readonly traceId: string;
  readonly sequence: number;
  readonly timeUnixMs: number;
  readonly source: AgentDebugSource;
  readonly stage: AgentDebugStage;
  readonly status: AgentDebugStatus;
  readonly title: string;
  readonly detail?: string;
  readonly elapsedMs: number;
}

export type AgentDebugTracePayload = Omit<AgentDebugEvent, 'sequence'>;

export interface AgentDebugCompleted {
  readonly kind: 'completed';
  readonly traceId: string;
  readonly timeUnixMs: number;
  readonly response: ChatResponse;
}

export interface AgentDebugFailed {
  readonly kind: 'failed';
  readonly traceId: string;
  readonly timeUnixMs: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type AgentDebugFramePayload = AgentDebugTracePayload | AgentDebugCompleted | AgentDebugFailed;

export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly estimatedCostMilli: number;
}

export interface ChatResponse {
  readonly requestId: string;
  readonly runId: string;
  readonly message: string;
  readonly mood: 'neutral' | 'helpful' | 'focused' | 'celebratory' | 'concerned';
  readonly activeAgentId?: string;
  readonly intents: readonly OsIntent[];
  readonly surface?: A2uiSurface;
  readonly usage?: UsageSummary;
}

export interface GameDecisionRequest {
  readonly requestId: string;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly matchId: string;
  readonly seatId: string;
  readonly observation: {
    readonly revision: number;
    readonly terminal: boolean;
    readonly decision: {
      readonly mode: 'sequential' | 'simultaneous';
      readonly phase: string;
      readonly activeSeatIds: readonly string[];
      readonly turnNonce: string;
    };
    readonly observation: JsonValue;
  };
  readonly legalActions: readonly {
    readonly id: string;
    readonly label: string;
    readonly action: JsonValue;
  }[];
}

export interface GameDecisionResponse {
  readonly requestId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly usage?: UsageSummary;
}

export interface SidecarErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

export type GeneratedAgentManifest = AgentManifest;
