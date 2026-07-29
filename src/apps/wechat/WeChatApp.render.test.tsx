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

  it('reserves the entire renderer body for one embedded surface', () => {
    const markup = renderToStaticMarkup(<WeChatApp bridge={null} />);

    expect(markup).toMatch(/^<div class="wechat-app"[^>]*><main class="wechat-app__surface"/);
    expect(markup).not.toContain('<header');
    expect(markup).not.toContain('<footer');
    expect(markup).not.toContain('微信浏览控制');
    expect(markup).not.toContain('aria-label="刷新微信"');
  });
});
