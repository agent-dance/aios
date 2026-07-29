import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WeChatApp } from './WeChatApp';

describe('WeChatApp browser fallback', () => {
  it('renders an honest desktop requirement and no outbound navigation', () => {
    const markup = renderToStaticMarkup(<WeChatApp bridge={null} />);

    expect(markup).toContain('请使用 AlSniper OS 桌面版');
    expect(markup).toContain('当前环境没有桌面宿主');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('href=');
  });

  it('keeps native navigation controls unavailable without the desktop host', () => {
    const markup = renderToStaticMarkup(<WeChatApp bridge={null} />);

    expect(markup).toContain('aria-label="后退"');
    expect(markup).toContain('aria-label="刷新微信"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
