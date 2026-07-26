import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('./DoudizhuApp.tsx', import.meta.url), 'utf8');

describe('DoudizhuApp security wiring contract', () => {
  it('keeps live-match New Round behind the tested terminal orchestration guard', () => {
    const restartStart = APP_SOURCE.indexOf('const restart = useCallback');
    const nextHandler = APP_SOURCE.indexOf('const handleKeyDown', restartStart);
    const restartSource = APP_SOURCE.slice(restartStart, nextHandler);

    expect(restartStart).toBeGreaterThan(-1);
    expect(restartSource).toContain('createNextDoudizhuRoundAfterTerminal(');
    expect(restartSource).toContain('matchRef.current!');
    expect(restartSource.indexOf('if (!nextSession) return;'))
      .toBeLessThan(restartSource.indexOf('matchRef.current = nextSession.match;'));
  });

  it('disables the header New Round control for every nonterminal projection', () => {
    const headerControl = APP_SOURCE.match(
      /aria-label=\{observation\.terminal[\s\S]*?disabled=\{!observation\.terminal\}[\s\S]*?onClick=\{restart\}/,
    );
    expect(headerControl).not.toBeNull();
  });
});
