import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  abortDoudizhuAgentController,
  replaceDoudizhuAgentAbortController,
  type DoudizhuAgentAbortControllerOwner,
} from './DoudizhuApp';

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
      /aria-label=\{observation\.terminal[\s\S]*?disabled=\{!humanInteractionEnabled \|\| !observation\.terminal\}[\s\S]*?onClick=\{restart\}/,
    );
    expect(headerControl).not.toBeNull();
  });

  it('uses cancellable single-flight sidecar decisions while preserving synchronous virtual-time heuristics', () => {
    expect(APP_SOURCE).toContain('createDoudizhuAgentTurnGate()');
    expect(APP_SOURCE).toContain('driveAgentTurnAsync(getAgentController(currentMatch, actor), { signal })');
    expect(APP_SOURCE).toContain("abortActiveAgent('Agent turn is no longer active');");
    expect(APP_SOURCE).toContain("abortActiveAgent('Match replaced');");
    expect(APP_SOURCE).toContain('driveHeuristicAgents();');
    expect(APP_SOURCE).toContain('if (canUseHumanCapability()) advanceGameTime(milliseconds);');
  });

  it('separates background match simulation from foreground human and automation capabilities', () => {
    expect(APP_SOURCE).toContain('simulationActive = isActive');
    expect(APP_SOURCE).toContain('active: simulationActive');
    expect(APP_SOURCE).toContain('enabled: isActive');
    expect(APP_SOURCE).toContain('if (!canUseHumanCapability()) return false;');
    expect(APP_SOURCE).toMatch(/if \(\s*!simulationActive\s*\|\| lifecycle\.suspended/);
  });

  it('aborts and invalidates the old controller lifecycle when its factory changes', () => {
    expect(APP_SOURCE).toContain("abortActiveAgent('Agent controller factory changed');");
    expect(APP_SOURCE).toContain('agentTurnGateRef.current!.cancelActive();');
    expect(APP_SOURCE).toContain('controllerCacheRef.current = { factory: agentControllerFactory, controllers: new Map() };');
    expect(APP_SOURCE).toMatch(/\[\s*activeSeatId,\s*abortActiveAgent,\s*agentControllerFactory,/);
  });

  it('revokes Agent, human, fullscreen, and automation capabilities at synchronous boundaries', () => {
    expect(APP_SOURCE).toContain("abortActiveAgent('Game lifecycle suspended');");
    expect(APP_SOURCE).toContain('if (simulationActive && !manualClock) replaceDoudizhuAgentAbortController(activeAgentAbortRef);');
    expect(APP_SOURCE).toContain('const activeAbort = activeAgentAbortRef.current;');
    expect(APP_SOURCE).toContain("return () => abortActiveAgent('Game simulation stopped');");
    expect(APP_SOURCE).toContain('foregroundCapabilityRef.current = false;');
    expect(APP_SOURCE).toContain('if (!canUseHumanCapability()) return;');
    expect(APP_SOURCE).toContain("JSON.stringify({ protocol: 'AGAP/1.0.0', unavailable: 'inactive' })");
    expect(APP_SOURCE).toContain('disabled={!humanInteractionEnabled || !observation.terminal}');
  });

  it('rotates the aborted generation during a same-task suspend and resume', () => {
    const owner: DoudizhuAgentAbortControllerOwner = { current: null };
    const beforeSuspend = replaceDoudizhuAgentAbortController(owner);

    abortDoudizhuAgentController(owner, 'batched blur');
    const afterResume = replaceDoudizhuAgentAbortController(owner);

    expect(beforeSuspend.aborted).toBe(true);
    expect(afterResume.aborted).toBe(false);
    expect(owner.current?.signal).toBe(afterResume);
  });

  it('keeps fullscreen and gameplay shortcuts out of editors and OS modifier chords', () => {
    expect(APP_SOURCE).toContain('event.repeat || shouldIgnoreGameplayKeyEvent(event)');
    expect(APP_SOURCE).toContain('!canUseHumanCapability() || shouldIgnoreGameplayKeyEvent(event)');
    expect(APP_SOURCE).not.toContain('fromInteractiveControl');
  });
});
