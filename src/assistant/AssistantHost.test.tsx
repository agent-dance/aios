import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantHost } from './AssistantHost';
import type { AssistantClient } from './types';

describe('AssistantHost', () => {
  it('renders an accessible native control and a non-WebGL fallback', () => {
    const client: AssistantClient = {
      run: async () => ({ message: 'ok' }),
    };
    const markup = renderToStaticMarkup(
      <AssistantHost client={client} activeGame forceCanvasFallback />,
    );

    expect(markup).toContain('aria-label="AlSniper OS 智能助手"');
    expect(markup).toContain('aria-label="打开 AlSniper 助手"');
    expect(markup).toContain('assistant-avatar-fallback');
    expect(markup).not.toContain('<canvas');
  });

  it('keeps click-to-open and the native text composer available without speech', () => {
    const client: AssistantClient = {
      run: async () => ({ message: 'ok' }),
    };
    const closedMarkup = renderToStaticMarkup(
      <AssistantHost client={client} forceCanvasFallback />,
    );

    expect(closedMarkup).toContain('aria-label="打开 AlSniper 助手"');
    expect(closedMarkup).toContain('aria-expanded="false"');
    expect(closedMarkup).not.toContain('assistant-prompt');
  });
});
