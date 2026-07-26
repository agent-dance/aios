import { AssistantHost, type AssistantHostProps } from '../assistant';
import type { AgentSurfaceEnvelope } from './AgentRuntimeProvider';

export type AgentAssistantHostProps = AssistantHostProps<AgentSurfaceEnvelope>;

export function AgentAssistantHost(props: AgentAssistantHostProps) {
  return <AssistantHost<AgentSurfaceEnvelope> {...props} />;
}
