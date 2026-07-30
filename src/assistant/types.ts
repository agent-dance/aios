import type { ReactNode } from 'react';

export type AssistantMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export type AssistantInputSource = 'text' | 'voice';

export interface AssistantContext {
  readonly activeAppId: string | null;
  readonly activeGame: boolean;
}

export interface AssistantConversationEntry {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AssistantDebugEvent {
  readonly kind: 'trace';
  readonly source: 'sidecar' | 'runtime' | 'broker';
  readonly stage: 'request' | 'analysis' | 'decision' | 'authorization' | 'completion';
  readonly status: 'started' | 'completed' | 'info' | 'failed';
  readonly title: string;
  readonly detail?: string;
  readonly elapsedMs: number;
}

export interface AssistantRequest {
  readonly threadId: string;
  readonly message: string;
  readonly history?: readonly AssistantConversationEntry[];
  readonly source: AssistantInputSource;
  readonly context: AssistantContext;
  readonly signal: AbortSignal;
  readonly onDebugEvent?: (event: AssistantDebugEvent) => void | Promise<void>;
}

export interface AssistantSurfaceText {
  readonly type: 'text';
  readonly id: string;
  readonly text: string;
  readonly tone?: 'default' | 'muted' | 'positive' | 'warning';
}

export interface AssistantSurfaceMetric {
  readonly type: 'metric';
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface AssistantSurfaceAction {
  readonly type: 'action';
  readonly id: string;
  readonly label: string;
  readonly intentId: string;
  readonly emphasis?: 'primary' | 'secondary';
}

export type AssistantSurfaceNode =
  | AssistantSurfaceText
  | AssistantSurfaceMetric
  | AssistantSurfaceAction;

export interface AssistantSurface {
  readonly id: string;
  readonly title?: string;
  readonly nodes: readonly AssistantSurfaceNode[];
}

export interface AssistantActionReceipt {
  readonly id: string;
  readonly label: string;
  /** Unknown is terminal for display and must never be presented as retryable. */
  readonly status: 'accepted' | 'rejected' | 'failed' | 'unknown';
  readonly detail?: string;
}

export interface AssistantResponse<TSurface = AssistantSurface> {
  readonly message: string;
  readonly mood?: Exclude<AssistantMood, 'listening' | 'thinking'>;
  readonly surface?: TSurface;
  readonly receipts?: readonly AssistantActionReceipt[];
}

export interface AssistantClient<TSurface = AssistantSurface> {
  run(request: AssistantRequest): Promise<AssistantResponse<TSurface>>;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly source?: AssistantInputSource;
}

export type AssistantSurfaceRenderer<TSurface = AssistantSurface> = (
  surface: TSurface,
  onAction: (intentId: string) => void,
) => ReactNode;
