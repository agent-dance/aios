import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop responsive stylesheet', () => {
  it('keeps desktop icons visible on viewports at or below 780px high', () => {
    const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

    expect(css).not.toContain('.alsniper-desktop-icon { display: none !important; }');
    expect(css).toContain('.alsniper-desktop-icons--adaptive');
    expect(css).toContain('grid-auto-flow: column');
    expect(css).toContain('grid-template-rows: repeat(auto-fill, minmax(128px, 1fr))');
  });

  it('preserves icon scrolling without exposing a system-edge scrollbar', () => {
    const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.alsniper-desktop-icons--adaptive\s*\{[^}]*scrollbar-width:\s*none;/s);
    expect(css).toMatch(/\.alsniper-desktop-icons--adaptive::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  });
});
