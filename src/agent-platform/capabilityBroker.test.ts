import { describe, expect, it, vi } from 'vitest';
import { CapabilityBrokerError, createCapabilityBroker, type OsCapabilityPorts } from './capabilityBroker';

const principal = { kind: 'agent' as const, instanceId: 'instance-1', packageId: 'local.helper', userId: 'user-1' };

const ports = (): OsCapabilityPorts => ({
  apps: { open: vi.fn(), close: vi.fn(), focus: vi.fn(), minimize: vi.fn() },
  applicationActions: {
    execute: vi.fn(async () => ({
      status: 'committed' as const,
      receiptId: 'effect-1',
      approvedByUser: true,
      retryable: false,
    })),
  },
  preferences: { update: vi.fn() },
  systemStatus: { update: vi.fn() },
  store: { install: vi.fn() },
  agents: { install: vi.fn() },
  surfaces: { publish: vi.fn() },
});

describe('OS capability broker', () => {
  it('defaults to deny and requires a Host-bound revision', async () => {
    const broker = createCapabilityBroker({ principal, ports: ports() });
    await expect(broker.execute({ id: 'i1', type: 'open_app', appId: 'finder' }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'BROKER_CAPABILITY_DENIED' });
    await expect(broker.execute({ id: 'i2', type: 'open_app', appId: 'finder' }))
      .rejects.toMatchObject({ code: 'BROKER_INVALID_INTENT' });
  });

  it('commits once, replays a receipt, and rejects stale or conflicting reuse', async () => {
    const target = ports();
    const broker = createCapabilityBroker({ principal, ports: target, policy: { authorize: () => 'allow' } });
    const intent = { id: 'i1', type: 'open_app' as const, appId: 'finder' };
    const receipt = await broker.execute(intent, { expectedRevision: 0, idempotencyKey: 'effect-1' });
    expect(await broker.execute(intent, { expectedRevision: 0, idempotencyKey: 'effect-1' })).toBe(receipt);
    expect(target.apps.open).toHaveBeenCalledTimes(1);
    await expect(broker.execute({ ...intent, appId: 'settings' }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'BROKER_IDEMPOTENCY_CONFLICT' });
    await expect(broker.execute({ id: 'i2', type: 'focus_app', appId: 'finder' }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'BROKER_STALE_REVISION', retryable: true });
  });

  it('routes approval only through the trusted Host port', async () => {
    const target = ports();
    const approval = { request: vi.fn(async () => true) };
    const broker = createCapabilityBroker({ principal, ports: target, approval, policy: { authorize: () => 'require-approval' } });
    const receipt = await broker.execute({ id: 'install-1', type: 'install_app', listingId: 'game.one' }, { expectedRevision: 0 });
    expect(receipt).toMatchObject({ risk: 'high', approvedByUser: true });
    expect(approval.request).toHaveBeenCalledOnce();
    expect(target.store.install).toHaveBeenCalledWith('game.one');
  });

  it('rejects a TOCTOU-stale intent when trusted Host state changes during approval', async () => {
    let revision = 4;
    const target = ports();
    const broker = createCapabilityBroker({
      principal,
      ports: target,
      revisionClock: {
        getRevision: () => revision,
        bumpRevision: () => ++revision,
      },
      approval: { request: async () => { revision += 1; return true; } },
      policy: { authorize: () => 'require-approval' },
    });
    await expect(broker.execute(
      { id: 'install-stale', type: 'install_app', listingId: 'game.one' },
      { expectedRevision: 4 },
    )).rejects.toMatchObject({ code: 'BROKER_STALE_REVISION', retryable: true });
    expect(target.store.install).not.toHaveBeenCalled();
  });

  it('does not advance revision or store a receipt after an operation failure', async () => {
    const target = ports();
    target.apps.open = vi.fn(async () => { throw new Error('private failure'); });
    const broker = createCapabilityBroker({ principal, ports: target, policy: { authorize: () => 'allow' } });
    await expect(broker.execute({ id: 'i1', type: 'open_app', appId: 'finder' }, { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(CapabilityBrokerError);
    expect(broker.getRevision()).toBe(0);
  });

  it('routes a strictly validated system status patch through its dedicated capability', async () => {
    const target = ports();
    const broker = createCapabilityBroker({ principal, ports: target, policy: { authorize: () => 'allow' } });
    const receipt = await broker.execute({
      id: 'status-1',
      type: 'set_system_status',
      statusPatch: { wifiEnabled: false, brightness: 42, energyMode: 'Eco' },
    }, { expectedRevision: 0 });
    expect(receipt).toMatchObject({ capability: 'os.system-status.write', risk: 'medium' });
    expect(target.systemStatus.update).toHaveBeenCalledWith({ wifiEnabled: false, brightness: 42, energyMode: 'Eco' });

    await expect(broker.execute({
      id: 'status-readonly',
      type: 'set_system_status',
      statusPatch: { healthScore: 100 },
    } as never, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'BROKER_INVALID_INTENT' });
  });

  it('binds application actions to the Broker principal, revision, and idempotency key', async () => {
    const target = ports();
    const approval = { request: vi.fn(async () => true) };
    const broker = createCapabilityBroker({
      principal,
      ports: target,
      approval,
      policy: { authorize: ({ capability }) => capability === 'app.action.execute' ? 'allow' : 'deny' },
    });
    const argumentsValue = { text: 'hello', nested: { value: 1 } };
    const intent = {
      id: 'send-1',
      type: 'execute_app_action' as const,
      appId: 'notes.app',
      actionId: 'notes.document.append',
      arguments: argumentsValue,
    };
    const receipt = await broker.execute(intent, { expectedRevision: 0, idempotencyKey: 'effect-1' });
    expect(await broker.execute(intent, { expectedRevision: 0, idempotencyKey: 'effect-1' })).toBe(receipt);

    expect(receipt).toMatchObject({
      capability: 'app.action.execute',
      risk: 'high',
      approvedByUser: true,
      applicationEffect: { status: 'committed', receiptId: 'effect-1' },
    });
    expect(approval.request).not.toHaveBeenCalled();
    expect(target.applicationActions.execute).toHaveBeenCalledWith({
      principal,
      intentId: 'effect-1',
      idempotencyKey: 'effect-1',
      appId: 'notes.app',
      actionId: 'notes.document.append',
      arguments: argumentsValue,
      expectedRevision: 0,
    });
    const dispatched = vi.mocked(target.applicationActions.execute).mock.calls[0]![0];
    expect(Object.isFrozen(dispatched)).toBe(true);
    expect(Object.isFrozen(dispatched.principal)).toBe(true);
    expect(Object.isFrozen(dispatched.arguments)).toBe(true);
    expect(Object.isFrozen(dispatched.arguments.nested)).toBe(true);
    expect(target.applicationActions.execute).toHaveBeenCalledTimes(1);
    await expect(broker.execute({
      ...intent,
      arguments: { text: 'different' },
    }, { expectedRevision: 0, idempotencyKey: 'effect-1' }))
      .rejects.toMatchObject({ code: 'BROKER_IDEMPOTENCY_CONFLICT' });
    await expect(broker.execute({
      ...intent,
      arguments: { text: 'different' },
    }, { expectedRevision: 1, idempotencyKey: 'effect-2' }))
      .resolves.toMatchObject({ intentId: 'send-1', revision: 2 });
    expect(target.applicationActions.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(target.applicationActions.execute).mock.calls[1]![0].idempotencyKey).toBe('effect-2');
  });

  it.each([
    ['rejected', 'BROKER_OPERATION_REJECTED'],
    ['failed', 'BROKER_OPERATION_FAILED'],
    ['unknown', 'BROKER_OPERATION_UNKNOWN'],
  ] as const)('does not accept or advance revision for an application %s result', async (status, code) => {
    const target = ports();
    target.applicationActions.execute = vi.fn(async () => ({
      status,
      receiptId: `effect-${status}`,
      approvedByUser: status !== 'rejected',
      retryable: status === 'failed',
      errorCode: status === 'rejected'
        ? 'APPROVAL_DENIED'
        : status === 'unknown'
          ? 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE'
          : 'PRECONDITION_FAILED',
    }));
    const broker = createCapabilityBroker({ principal, ports: target, policy: { authorize: () => 'allow' } });

    await expect(broker.execute({
      id: `send-${status}`,
      type: 'execute_app_action',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'hello' },
    }, { expectedRevision: 0, idempotencyKey: `effect-${status}` })).rejects.toMatchObject({
      code,
      ...(status === 'unknown' ? { retryable: false } : {}),
    });
    expect(broker.getRevision()).toBe(0);
  });

  it('never crosses the application boundary after approval denial or TOCTOU revision drift', async () => {
    const deniedTarget = ports();
    const denied = createCapabilityBroker({
      principal,
      ports: deniedTarget,
      approval: { request: async () => false },
      policy: { authorize: () => 'require-approval' },
    });
    const intent = {
      id: 'send-denied',
      type: 'execute_app_action' as const,
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'hello' },
    };
    await expect(denied.execute(intent, { expectedRevision: 0, idempotencyKey: 'effect-denied' }))
      .rejects.toMatchObject({ code: 'BROKER_APPROVAL_DENIED' });
    expect(deniedTarget.applicationActions.execute).not.toHaveBeenCalled();

    let revision = 3;
    const staleTarget = ports();
    const stale = createCapabilityBroker({
      principal,
      ports: staleTarget,
      revisionClock: { getRevision: () => revision, bumpRevision: () => ++revision },
      approval: { request: async () => { revision += 1; return true; } },
      policy: { authorize: () => 'require-approval' },
    });
    await expect(stale.execute(
      { ...intent, id: 'send-stale' },
      { expectedRevision: 3, idempotencyKey: 'effect-stale' },
    ))
      .rejects.toMatchObject({ code: 'BROKER_STALE_REVISION' });
    expect(staleTarget.applicationActions.execute).not.toHaveBeenCalled();
  });

  it('rejects preferences outside the closed cross-language accent enum', async () => {
    const target = ports();
    const broker = createCapabilityBroker({ principal, ports: target, policy: { authorize: () => 'allow' } });
    await expect(broker.execute({
      id: 'invalid-accent',
      type: 'set_preferences',
      preferences: { accent: 'magenta' },
    } as never, { expectedRevision: 0 })).rejects.toMatchObject({ code: 'BROKER_INVALID_INTENT' });
    expect(target.preferences.update).not.toHaveBeenCalled();
  });

  it('evicts only the oldest receipt when the bounded idempotency window is full', async () => {
    const target = ports();
    const broker = createCapabilityBroker({
      principal,
      ports: target,
      policy: { authorize: () => 'allow' },
      maxReceipts: 2,
    });
    await broker.execute({ id: 'i1', type: 'open_app', appId: 'finder' }, { expectedRevision: 0 });
    const retained = await broker.execute({ id: 'i2', type: 'open_app', appId: 'settings' }, { expectedRevision: 1 });
    await broker.execute({ id: 'i3', type: 'open_app', appId: 'calculator' }, { expectedRevision: 2 });
    expect(await broker.execute({ id: 'i2', type: 'open_app', appId: 'settings' }, { expectedRevision: 1 })).toBe(retained);
    await expect(broker.execute({ id: 'i1', type: 'open_app', appId: 'finder' }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'BROKER_STALE_REVISION' });
    expect(target.apps.open).toHaveBeenCalledTimes(3);
  });
});
