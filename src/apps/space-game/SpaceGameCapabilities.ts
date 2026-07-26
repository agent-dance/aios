import type { SpaceGameAgentController } from './SpaceGameAgentController';

export type SpaceGameControlMode = 'human' | 'assist' | 'agent';

export interface SpaceGameControlPolicy {
  readonly mode: SpaceGameControlMode;
  readonly agentEnabled: boolean;
  readonly humanEnabled: boolean;
  readonly usingHumanFallback: boolean;
}

export interface SpaceGameControlModeLatch {
  resolve(controllerAvailable: boolean): SpaceGameControlPolicy;
}

/**
 * Control ownership is immutable for an authority session. Controller
 * connectivity only enables/disables the Agent; an unavailable Agent seat
 * fails over to the same formal human controls without changing AGAP identity.
 */
export function createSpaceGameControlModeLatch(
  initialMode: SpaceGameControlMode,
): SpaceGameControlModeLatch {
  const mode = initialMode;
  return Object.freeze({
    resolve(controllerAvailable: boolean) {
      const agentEnabled = mode !== 'human' && controllerAvailable;
      const usingHumanFallback = mode === 'agent' && !controllerAvailable;
      return Object.freeze({
        mode,
        agentEnabled,
        humanEnabled: mode !== 'agent' || usingHumanFallback,
        usingHumanFallback,
      });
    },
  });
}

export interface SpaceGameCapabilityGateOptions {
  readonly foreground: boolean;
  readonly simulationActive: boolean;
  readonly lifecycleSuspended: boolean;
  readonly manualClock: boolean;
}

export interface SpaceGameCapabilityGate {
  setForeground(value: boolean): void;
  setSimulationActive(value: boolean): void;
  setLifecycleSuspended(value: boolean): void;
  canUseHumanInput(): boolean;
  canUseAutomation(): boolean;
  canUseAgent(): boolean;
  /** Sticky for the gate lifetime. Returns false when automation is revoked. */
  requestManualClock(): boolean;
  readonly manualClock: boolean;
}

/** A synchronous, transport-neutral revocation gate read by every stale callback. */
export function createSpaceGameCapabilityGate(
  options: SpaceGameCapabilityGateOptions,
): SpaceGameCapabilityGate {
  let foreground = options.foreground;
  let simulationActive = options.simulationActive;
  let lifecycleSuspended = options.lifecycleSuspended;
  let manualClock = options.manualClock;

  const baseAvailable = () => simulationActive && !lifecycleSuspended;
  return Object.freeze({
    setForeground(value: boolean) {
      foreground = value;
    },
    setSimulationActive(value: boolean) {
      simulationActive = value;
    },
    setLifecycleSuspended(value: boolean) {
      lifecycleSuspended = value;
    },
    canUseHumanInput: () => foreground && baseAvailable(),
    canUseAutomation: () => foreground && baseAvailable(),
    canUseAgent: () => baseAvailable() && !manualClock,
    requestManualClock() {
      if (!(foreground && baseAvailable())) return false;
      manualClock = true;
      return true;
    },
    get manualClock() {
      return manualClock;
    },
  });
}

export class SpaceGameCapabilityRevokedError extends Error {
  constructor(capability: 'automation' | 'agent') {
    super(`Space game ${capability} capability is not currently available.`);
    this.name = 'SpaceGameCapabilityRevokedError';
  }
}

/** Revalidates controller identity and Agent capability around async planning. */
export function createCapabilityGuardedSpaceGameAgentController(
  controller: SpaceGameAgentController,
  isCurrentController: () => boolean,
  capabilityGate: Pick<SpaceGameCapabilityGate, 'canUseAgent'>,
): SpaceGameAgentController {
  return Object.freeze({
    async chooseAction(
      input: Parameters<SpaceGameAgentController['chooseAction']>[0],
      signal?: AbortSignal,
    ) {
      if (!isCurrentController() || !capabilityGate.canUseAgent()) {
        throw new SpaceGameCapabilityRevokedError('agent');
      }
      const action = await controller.chooseAction(input, signal);
      if (!isCurrentController() || !capabilityGate.canUseAgent()) {
        throw new SpaceGameCapabilityRevokedError('agent');
      }
      return action;
    },
  });
}
