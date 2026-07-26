import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssistantDebugTimeline } from './AssistantDebugTimeline';

describe('AssistantDebugTimeline', () => {
  it('renders an accessible empty live timeline with a disabled clear action', () => {
    const markup = renderToStaticMarkup(<AssistantDebugTimeline events={[]} onClear={vi.fn()} />);

    expect(markup).toContain('id="assistant-debug-title"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-label="Agent Debug event timeline"');
    expect(markup).toContain('aria-label="Clear Agent Debug timeline"');
    expect(markup).toContain('disabled=""');
  });

  it('shows source, stage, status, elapsed time, and escaped detail text', () => {
    const markup = renderToStaticMarkup(
      <AssistantDebugTimeline
        events={[{
          kind: 'trace',
          source: 'broker',
          stage: 'authorization',
          status: 'completed',
          title: 'Capability authorized',
          detail: '<script>not markup</script>',
          elapsedMs: 12.6,
        }]}
        onClear={vi.fn()}
      />,
    );

    expect(markup).toContain('Capability authorized');
    expect(markup).toContain('broker');
    expect(markup).toContain('authorization');
    expect(markup).toContain('completed');
    expect(markup).toContain('13 ms');
    expect(markup).toContain('&lt;script&gt;not markup&lt;/script&gt;');
    expect(markup).not.toContain('disabled=""');
  });
});
