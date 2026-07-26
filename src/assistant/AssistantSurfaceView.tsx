import type { AssistantSurface } from './types';

export interface AssistantSurfaceViewProps {
  readonly surface: AssistantSurface;
  readonly onAction: (intentId: string) => void;
}

export function AssistantSurfaceView({ surface, onAction }: AssistantSurfaceViewProps) {
  return (
    <section className="assistant-surface" aria-label={surface.title ?? 'Agent 交互界面'}>
      {surface.title ? <h3>{surface.title}</h3> : null}
      <div className="assistant-surface__grid">
        {surface.nodes.map((node) => {
          if (node.type === 'text') {
            return (
              <p key={node.id} className={`assistant-surface__text assistant-tone--${node.tone ?? 'default'}`}>
                {node.text}
              </p>
            );
          }
          if (node.type === 'metric') {
            return (
              <div key={node.id} className="assistant-surface__metric">
                <span>{node.label}</span>
                <strong>{node.value}</strong>
              </div>
            );
          }
          return (
            <button
              key={node.id}
              className={`assistant-surface__action assistant-surface__action--${node.emphasis ?? 'secondary'}`}
              type="button"
              onClick={() => onAction(node.intentId)}
            >
              {node.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
