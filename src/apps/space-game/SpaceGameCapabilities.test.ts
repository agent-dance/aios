import { describe, expect, it } from 'vitest';
import {
  SpaceGameCapabilityRevokedError,
  createCapabilityGuardedSpaceGameAgentController,
  createSpaceGameCapabilityGate,
  createSpaceGameControlModeLatch,
} from './SpaceGameCapabilities';
import type { SpaceGameAction } from './SpaceGameAgentAdapter';
import type { SpaceGameAgentController, SpaceGameAgentDecisionInput } from './SpaceGameAgentController';

describe('Space game capability policy', () => {
  it('locks a running control mode while treating controller loss as availability fallback', () => {
    const latch = createSpaceGameControlModeLatch('assist');
    expect(latch.resolve(true)).toEqual({
      mode: 'assist',
      agentEnabled: true,
      humanEnabled: true,
      usingHumanFallback: false,
    });

    expect(latch.resolve(false)).toEqual({
      mode: 'assist',
      agentEnabled: false,
      humanEnabled: true,
      usingHumanFallback: false,
    });
    expect(latch.resolve(true).mode).toBe('assist');
  });

  it('gives an unavailable immutable agent-only seat a human fallback', () => {
    const latch = createSpaceGameControlModeLatch('agent');
    expect(latch.resolve(false)).toEqual({
      mode: 'agent',
      agentEnabled: false,
      humanEnabled: true,
      usingHumanFallback: true,
    });
    expect(latch.resolve(true)).toEqual({
      mode: 'agent',
      agentEnabled: true,
      humanEnabled: false,
      usingHumanFallback: false,
    });
  });

  it('revokes stale callbacks synchronously and keeps manual-clock ownership sticky', () => {
    const gate = createSpaceGameCapabilityGate({
      foreground: true,
      simulationActive: true,
      lifecycleSuspended: false,
      manualClock: false,
    });
    expect(gate.canUseHumanInput()).toBe(true);
    expect(gate.canUseAutomation()).toBe(true);
    expect(gate.canUseAgent()).toBe(true);

    expect(gate.requestManualClock()).toBe(true);
    expect(gate.manualClock).toBe(true);
    expect(gate.canUseAutomation()).toBe(true);
    expect(gate.canUseAgent()).toBe(false);

    gate.setForeground(false);
    expect(gate.canUseHumanInput()).toBe(false);
    expect(gate.canUseAutomation()).toBe(false);
    gate.setForeground(true);
    gate.setLifecycleSuspended(true);
    expect(gate.canUseHumanInput()).toBe(false);
    expect(gate.canUseAutomation()).toBe(false);
    expect(gate.canUseAgent()).toBe(false);

    gate.setLifecycleSuspended(false);
    expect(gate.manualClock).toBe(true);
    expect(gate.canUseAgent()).toBe(false);
    gate.setSimulationActive(false);
    expect(gate.requestManualClock()).toBe(false);
  });

  it('rejects a late asynchronous Agent result after controller or lifecycle revocation', async () => {
    const gate = createSpaceGameCapabilityGate({
      foreground: true,
      simulationActive: true,
      lifecycleSuspended: false,
      manualClock: false,
    });
    let current = true;
    let resolve!: (action: SpaceGameAction) => void;
    const controller: SpaceGameAgentController = {
      chooseAction: () => new Promise((settle) => {
        resolve = settle;
      }),
    };
    const guarded = createCapabilityGuardedSpaceGameAgentController(controller, () => current, gate);
    const pending = guarded.chooseAction({} as SpaceGameAgentDecisionInput);
    gate.setLifecycleSuspended(true);
    current = false;
    resolve({ type: 'start' });
    await expect(pending).rejects.toBeInstanceOf(SpaceGameCapabilityRevokedError);
  });

  it('rejects Agent completion after sticky manual-clock takeover', async () => {
    const gate = createSpaceGameCapabilityGate({
      foreground: true,
      simulationActive: true,
      lifecycleSuspended: false,
      manualClock: false,
    });
    let resolve!: (action: SpaceGameAction) => void;
    const guarded = createCapabilityGuardedSpaceGameAgentController(
      { chooseAction: () => new Promise((settle) => { resolve = settle; }) },
      () => true,
      gate,
    );
    const pending = guarded.chooseAction({} as SpaceGameAgentDecisionInput);
    expect(gate.requestManualClock()).toBe(true);
    resolve({ type: 'start' });
    await expect(pending).rejects.toBeInstanceOf(SpaceGameCapabilityRevokedError);
    expect(gate.canUseAgent()).toBe(false);
  });
});
