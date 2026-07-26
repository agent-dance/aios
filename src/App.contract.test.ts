import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const MAIN_SOURCE = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

describe('OS game runtime composition', () => {
  it('keeps every mounted game simulation alive independently of foreground focus', () => {
    expect(APP_SOURCE).toMatch(
      /'space-game': \(\{ isActive, window \}\)[\s\S]*?<SpaceGameApp[\s\S]*?isActive=\{isActive\}[\s\S]*?simulationActive=\{window\.isOpen\}/,
    );
    expect(APP_SOURCE).toMatch(
      /doudizhu: \(\{ isActive, window \}\)[\s\S]*?<DoudizhuApp[\s\S]*?isActive=\{isActive\}[\s\S]*?simulationActive=\{window\.isOpen\}/,
    );
  });

  it('offers a development-only first-render game canvas for the official harness', () => {
    expect(MAIN_SOURCE).toContain('if (import.meta.env.DEV)');
    expect(MAIN_SOURCE).toContain("get('automationGame')");
    expect(MAIN_SOURCE).toContain("openApp('space-game')");
  });
});
