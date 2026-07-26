import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { VoiceDisclosurePanel } from './VoiceDisclosurePanel';

describe('VoiceDisclosurePanel', () => {
  it('uses trusted native controls and clearly discloses external speech processing', () => {
    const markup = renderToStaticMarkup(
      <VoiceDisclosurePanel acceptButtonRef={createRef()} onDecision={vi.fn()} />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('系统隐私确认 · 非 Agent 生成内容');
    expect(markup).toContain('浏览器、操作系统或其语音服务处理');
    expect(markup).toContain('AlSniper OS 不保存音频');
    expect(markup).toContain('可能随后续请求作为最近上下文发送');
    expect(markup).toContain('暂不启用');
    expect(markup).toContain('我已了解并启用');
  });

  it('traps keyboard focus and blocks background pointer interaction while modal', () => {
    const source = readFileSync(new URL('./VoiceDisclosurePanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain("document.addEventListener('focusin', keepFocusInside, true)");
    expect(source).toContain("document.addEventListener('pointerdown', blockBackgroundPointer, true)");
    expect(source).toContain("if (event.key === 'Escape')");
    expect(source).toContain("if (event.key !== 'Tab') return");
  });
});
