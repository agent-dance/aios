import { AiosA2uiSurface } from '../agent-platform/a2ui';
import type { AgentSurfaceEnvelope } from './AgentRuntimeProvider';

export function LazyAiosA2uiSurface({
  envelope,
  onAction,
}: {
  readonly envelope: AgentSurfaceEnvelope;
  readonly onAction: (intentId: string) => void;
}) {
  return (
    <AiosA2uiSurface
      surface={envelope.surface}
      intents={envelope.intents}
      onIntent={(intent) => onAction(intent.id)}
    />
  );
}
