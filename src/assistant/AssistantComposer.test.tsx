import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssistantComposer } from './AssistantComposer';

describe('AssistantComposer', () => {
  it('renders a native text form independently of speech support', () => {
    const markup = renderToStaticMarkup(
      <AssistantComposer
        draft="打开设置"
        pending={false}
        inputRef={createRef()}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('<form');
    expect(markup).toContain('id="assistant-prompt"');
    expect(markup).toContain('value="打开设置"');
    expect(markup).toContain('aria-label="发送消息"');
  });
});
