import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shouldIgnoreGameplayKeyEvent } from '../../game-platform/web';
import {
  SpaceGameCapabilityRevokedError,
  createCapabilityGuardedSpaceGameAgentController,
  createSpaceGameCapabilityGate,
} from './SpaceGameCapabilities';
import type { SpaceGameAction } from './SpaceGameAgentAdapter';
import type { SpaceGameAgentDecisionInput } from './SpaceGameAgentController';
import {
  revokeSpaceGameCapabilitiesOnUnmount,
} from './SpaceGameApp';

const APP_SOURCE = readFileSync(fileURLToPath(new URL('./SpaceGameApp.tsx', import.meta.url)), 'utf8');
const ROOT_APP_SOURCE = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');

describe('SpaceGameApp lifecycle wiring contract', () => {
  it('keeps the authority session independent from controller connectivity', () => {
    expect(APP_SOURCE).toContain('const matchId = useMemo(createLocalMatchId, []);');
    expect(APP_SOURCE).toMatch(/const session = useMemo\([\s\S]*?\}, \[matchId, publishState\]\);/);
    expect(ROOT_APP_SOURCE).toContain('controlMode="assist"');
    expect(ROOT_APP_SOURCE).toContain(
      'agentController={agentRuntime.connected ? agentRuntime.spaceGameController : undefined}',
    );
  });

  it('stops wall-clock Agent work synchronously before sticky manual-clock ownership', () => {
    expect(APP_SOURCE).toMatch(
      /const requestManualClock = useCallback\([\s\S]*?stopAgentDriver\(\);[\s\S]*?manualClockRef\.current = true/,
    );
    expect(APP_SOURCE).toContain('!capabilityGate.canUseAgent()');
    expect(APP_SOURCE).toContain('manualClockRef.current');
  });

  it('revalidates stale human, automation, and Agent callbacks at invocation time', () => {
    expect(APP_SOURCE).toMatch(/const handleKeyUp[\s\S]*?if \(!canUseHumanInput\(\)\) return;/);
    expect(APP_SOURCE).toContain('assertAutomationAvailable();');
    expect(APP_SOURCE).toContain('createCapabilityGuardedSpaceGameAgentController(');
    expect(APP_SOURCE).toMatch(/onSuspend: \(snapshot\) => \{[\s\S]*?stopAgentDriver\(\);/);
  });

  it('revokes every stale capability in a layout cleanup before passive unmount work', async () => {
    const gate = createSpaceGameCapabilityGate({
      foreground: true,
      simulationActive: true,
      lifecycleSuspended: false,
      manualClock: false,
    });
    let stopCount = 0;
    let resetCount = 0;
    let humanActions = 0;
    let automationAdvances = 0;
    let resolveAgent!: (action: SpaceGameAction) => void;
    const guardedController = createCapabilityGuardedSpaceGameAgentController(
      { chooseAction: () => new Promise((resolve) => { resolveAgent = resolve; }) },
      () => true,
      gate,
    );
    const pendingAgent = guardedController.chooseAction({} as SpaceGameAgentDecisionInput);
    const staleHumanKey = () => {
      if (gate.canUseHumanInput()) humanActions += 1;
    };
    const staleAutomation = () => {
      if (!gate.canUseAutomation()) throw new SpaceGameCapabilityRevokedError('automation');
      automationAdvances += 1;
    };

    revokeSpaceGameCapabilitiesOnUnmount(
      gate,
      () => { stopCount += 1; },
      () => { resetCount += 1; },
    );

    expect(gate.canUseHumanInput()).toBe(false);
    expect(gate.canUseAutomation()).toBe(false);
    expect(gate.canUseAgent()).toBe(false);
    expect(stopCount).toBe(1);
    expect(resetCount).toBe(1);
    staleHumanKey();
    expect(humanActions).toBe(0);
    expect(staleAutomation).toThrow(SpaceGameCapabilityRevokedError);
    expect(automationAdvances).toBe(0);
    resolveAgent({ type: 'start' });
    await expect(pendingAgent).rejects.toBeInstanceOf(SpaceGameCapabilityRevokedError);
    expect(APP_SOURCE).toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*?return \(\) => \{[\s\S]*?revokeSpaceGameCapabilitiesOnUnmount\(/,
    );
  });

  it('keeps editable and modified OS shortcuts out of global gameplay input', () => {
    const event = (overrides: Partial<Parameters<typeof shouldIgnoreGameplayKeyEvent>[0]> = {}) => ({
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      defaultPrevented: false,
      isComposing: false,
      target: null,
      ...overrides,
    });
    const editableTarget = {
      closest: (selector: string) => selector.includes('input') ? ({} as Element) : null,
    } as unknown as EventTarget;

    expect(shouldIgnoreGameplayKeyEvent(event())).toBe(false);
    expect(shouldIgnoreGameplayKeyEvent(event({ altKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ metaKey: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ isComposing: true }))).toBe(true);
    expect(shouldIgnoreGameplayKeyEvent(event({ target: editableTarget }))).toBe(true);
    expect(APP_SOURCE).toContain('if (!canUseHumanInput() || shouldIgnoreGameplayKeyEvent(event)) return;');
    expect(APP_SOURCE).toContain('const fireWasLatched = key === \' \' && keyboardFireLatchedRef.current;');
    expect(APP_SOURCE).toContain('if (!movementWasLatched && !fireWasLatched) return;');
  });
});
