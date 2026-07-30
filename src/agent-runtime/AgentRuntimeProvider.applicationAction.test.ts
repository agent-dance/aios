import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRegistry,
  ChatRequest,
  ChatResponse,
  HealthResponse,
  InstalledAgent,
  SidecarClient,
} from '../agent-platform';
import { validateAgentManifest } from '../agent-platform';
import { DEFAULT_SYSTEM_STATUS, useSystemStore } from '../system/useSystemStore';
import {
  APPLICATION_CONTROL_PROTOCOL_VERSION,
  type ApplicationControlExecuteRequest,
  type ApplicationControlReceipt,
} from '../../electron/shared/applicationControlProtocol';
import {
  assembleRuntime,
  type AgentRuntimeHostPort,
} from './AgentRuntimeProvider';

const emptyRegistry: AgentRegistry = {
  list: () => [],
  get: () => undefined,
  install: async () => { throw new Error('not used'); },
  enable: async () => { throw new Error('not used'); },
  disable: async () => { throw new Error('not used'); },
  uninstall: async () => false,
};

const clientFor = (respond: (request: ChatRequest) => ChatResponse): SidecarClient => ({
  health: async (): Promise<HealthResponse> => ({
    protocolVersion: '1.1.0',
    status: 'ready',
    agent: { driver: 'codex', authMode: 'linked', profileIsolated: true },
    limits: { maxBodyBytes: 262_144, maxConcurrentRuns: 4 },
    checks: [],
  }),
  chat: async (request) => respond(request),
  decide: async () => { throw new Error('not used'); },
});

const applicationAction = (id: string, text = '机密消息') => ({
  id,
  type: 'execute_app_action' as const,
  appId: 'wechat',
  actionId: 'wechat.message.send_to_current',
  arguments: { text },
});

const committedReceipt = (
  request: ApplicationControlExecuteRequest,
  overrides: Partial<ApplicationControlReceipt> = {},
): ApplicationControlReceipt => ({
  protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
  receiptId: `receipt-${request.intentId}`,
  intentId: request.intentId,
  idempotencyKey: request.idempotencyKey,
  appId: request.appId,
  actionId: request.actionId,
  status: 'committed',
  approvedByUser: true,
  retryable: false,
  occurredAt: '2026-07-30T00:00:00.000Z',
  journalSequence: 1,
  ...overrides,
});

const host = (
  confirmCapability: AgentRuntimeHostPort['confirmCapability'],
  executeApplicationAction: AgentRuntimeHostPort['executeApplicationAction'],
): AgentRuntimeHostPort => ({
  confirmCapability,
  listApplicationActions: async () => [{
    appId: 'wechat',
    actionId: 'wechat.message.send_to_current',
    adapterVersion: '1.0.0',
    risk: 'R3',
    requiresApproval: true,
  }],
  executeApplicationAction,
  locale: () => 'zh-CN',
  requestId: () => 'application-action-request',
});

const run = (
  runtime: ReturnType<typeof assembleRuntime>,
  message = '给当前会话发送消息',
) => runtime.assistantClient.run({
  threadId: 'application-action-thread',
  message,
  source: 'text',
  context: { activeAppId: 'wechat', activeGame: false },
  signal: new AbortController().signal,
});

describe('Agent runtime application actions', () => {
  beforeEach(() => {
    const state = useSystemStore.getState();
    useSystemStore.setState({
      windows: {},
      activeAppId: null,
      appInstallations: state.appInstallations,
      systemStatus: { ...DEFAULT_SYSTEM_STATUS },
    });
    useSystemStore.getState().installApp('wechat');
  });

  it('binds the desktop principal and exact validated action before one trusted Host dispatch', async () => {
    const confirmCapability = vi.fn<AgentRuntimeHostPort['confirmCapability']>(() => true);
    const observed: ApplicationControlExecuteRequest[] = [];
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) => {
      observed.push(request);
      return committedReceipt(request);
    });
    const runtime = assembleRuntime(clientFor((request) => {
      expect(request.context.availableApplicationActions).toEqual([{
        appId: 'wechat',
        actionId: 'wechat.message.send_to_current',
        argumentSchemaId: 'wechat.message.send_to_current.arguments@1',
      }]);
      return {
        requestId: request.requestId,
        runId: 'run-committed-action',
        message: '已发送。',
        mood: 'focused',
        intents: [applicationAction('send-current-1')],
      };
    }), emptyRegistry, () => undefined, host(confirmCapability, executeApplicationAction));

    const response = await run(runtime);

    expect(response.message).toBe('已准备应用操作；请在系统确认后以回执为准。');
    expect(response.message).not.toContain('已发送');
    // Application-effect consent is transaction-bound and main-owned. A
    // renderer confirmation is neither trusted nor sufficiently informed.
    expect(confirmCapability).not.toHaveBeenCalled();
    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(observed[0]).toEqual({
      protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
      intentId: 'chat-application-action-request',
      idempotencyKey: 'chat-application-action-request',
      principal: {
        kind: 'agent',
        instanceId: 'desktop-assistant:local',
        packageId: 'ai.alsniper.desktop-assistant@1.0.0',
        userId: 'local-user',
      },
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: '机密消息' },
      expectedRevision: expect.any(Number),
    });
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(Object.isFrozen(observed[0]?.principal)).toBe(true);
    expect(Object.isFrozen(observed[0]?.arguments)).toBe(true);
    expect(response.receipts?.[0]).toMatchObject({
      id: 'send-current-1',
      label: 'app.action.execute',
      status: 'accepted',
      detail: expect.stringMatching(/Approved.*receipt-chat-application-action-request/),
    });
  });

  it('allocates a new Host-owned effect key when later turns reuse the same model intent id', async () => {
    let requestSequence = 0;
    let responseSequence = 0;
    const observed: ApplicationControlExecuteRequest[] = [];
    const baseHost = host(() => true, async (request) => {
      observed.push(request);
      return committedReceipt(request, { receiptId: `receipt-${request.idempotencyKey}` });
    });
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: `run-reused-id-${++responseSequence}`,
      message: '已提交。',
      mood: 'focused',
      intents: [applicationAction('model-local-send-id', `消息 ${responseSequence}`)],
    })), emptyRegistry, () => undefined, {
      ...baseHost,
      requestId: () => `application-action-turn-${++requestSequence}`,
    });

    await run(runtime);
    await run(runtime);

    expect(observed).toHaveLength(2);
    expect(observed.map((request) => request.intentId)).toEqual([
      'chat-application-action-turn-1',
      'chat-application-action-turn-2',
    ]);
    expect(observed.map((request) => request.idempotencyKey)).toEqual([
      'chat-application-action-turn-1',
      'chat-application-action-turn-2',
    ]);
    expect(observed.every((request) => request.intentId !== 'model-local-send-id')).toBe(true);
    expect(observed.every((request) => request.idempotencyKey === request.intentId)).toBe(true);
  });

  it('maps a main-owned application rejection without invoking renderer approval', async () => {
    const confirmCapability = vi.fn<AgentRuntimeHostPort['confirmCapability']>(() => true);
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) =>
      committedReceipt(request, {
        status: 'rejected',
        approvedByUser: false,
        errorCode: 'APPROVAL_DENIED',
      }));
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: 'run-denied-action',
      message: '未发送。',
      mood: 'neutral',
      intents: [applicationAction('send-current-denied')],
    })), emptyRegistry, () => undefined, host(confirmCapability, executeApplicationAction));

    const response = await run(runtime);

    expect(confirmCapability).not.toHaveBeenCalled();
    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(response.receipts?.[0]).toMatchObject({
      id: 'send-current-denied',
      status: 'rejected',
    });
  });

  it('allocates a new Host key when a later turn reuses the same model intent id', async () => {
    let requestSequence = 0;
    let turn = 0;
    const observed: ApplicationControlExecuteRequest[] = [];
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) => {
      observed.push(request);
      return committedReceipt(request, { receiptId: `receipt-${request.idempotencyKey}` });
    });
    const sequencedHost: AgentRuntimeHostPort = {
      ...host(() => true, executeApplicationAction),
      requestId: () => `request-${++requestSequence}`,
    };
    const runtime = assembleRuntime(clientFor((request) => {
      turn += 1;
      return {
        requestId: request.requestId,
        runId: `run-reused-model-id-${turn}`,
        message: '已提交。',
        mood: 'focused',
        intents: [applicationAction('reused-model-id', turn === 1 ? 'first' : 'second')],
      };
    }), emptyRegistry, () => undefined, sequencedHost);

    await expect(run(runtime, '第一次')).resolves.toMatchObject({
      receipts: [expect.objectContaining({ status: 'accepted' })],
    });
    await expect(run(runtime, '第二次')).resolves.toMatchObject({
      receipts: [expect.objectContaining({ status: 'accepted' })],
    });

    expect(executeApplicationAction).toHaveBeenCalledTimes(2);
    expect(observed.map((request) => request.idempotencyKey)).toEqual(['chat-request-1', 'chat-request-2']);
    expect(observed.map((request) => request.intentId)).toEqual(['chat-request-1', 'chat-request-2']);
    expect(observed.map((request) => request.arguments)).toEqual([{ text: 'first' }, { text: 'second' }]);
  });

  it('terminally removes a deferred application action after a main-owned failure', async () => {
    const observed: ApplicationControlExecuteRequest[] = [];
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) => {
      observed.push(request);
      return committedReceipt(request, {
        status: 'failed',
        retryable: true,
        errorCode: 'PRECONDITION_FAILED',
      });
    });
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: 'run-deferred-effect',
      message: '请确认发送。',
      mood: 'focused',
      intents: [applicationAction('deferred-send')],
      surface: {
        version: '1.0',
        id: 'deferred-send-surface',
        components: [{ id: 'send', type: 'button', label: '发送', intentId: 'deferred-send' }],
      },
    })), emptyRegistry, () => undefined, host(() => true, executeApplicationAction));

    await run(runtime);
    await expect(runtime.onSurfaceAction('deferred-send')).resolves.toMatchObject({ status: 'failed' });
    await expect(runtime.onSurfaceAction('deferred-send')).resolves.toMatchObject({
      status: 'failed',
      detail: 'This action is no longer available.',
    });

    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(observed[0]?.idempotencyKey).toBe('chat-application-action-request');
  });

  it('coalesces concurrent deferred clicks and terminally removes an unknown action', async () => {
    let resolveEffect!: (receipt: ApplicationControlReceipt) => void;
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>((request) =>
      new Promise<ApplicationControlReceipt>((resolve) => {
        resolveEffect = resolve;
      }).then(() => committedReceipt(request, {
        status: 'unknown',
        retryable: false,
        errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
      })));
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: 'run-coalesced-unknown',
      message: '请确认发送。',
      mood: 'focused',
      intents: [applicationAction('coalesced-send')],
      surface: {
        version: '1.0',
        id: 'coalesced-send-surface',
        components: [{ id: 'send', type: 'button', label: '发送', intentId: 'coalesced-send' }],
      },
    })), emptyRegistry, () => undefined, host(() => true, executeApplicationAction));
    await run(runtime);

    const first = runtime.onSurfaceAction('coalesced-send');
    const second = runtime.onSurfaceAction('coalesced-send');
    await vi.waitFor(() => expect(executeApplicationAction).toHaveBeenCalledOnce());
    resolveEffect(committedReceipt(vi.mocked(executeApplicationAction).mock.calls[0]![0]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'unknown' }),
      expect.objectContaining({ status: 'unknown' }),
    ]);
    await expect(runtime.onSurfaceAction('coalesced-send')).resolves.toMatchObject({ status: 'failed' });
    expect(executeApplicationAction).toHaveBeenCalledOnce();
  });

  it.each([
    ['unavailable', async () => { throw new Error('bridge unavailable'); }],
    ['malformed', async () => [{ appId: 'wechat', actionId: 'wechat.message.send_to_current', forged: true }]],
    ['unsupported adapter version', async () => [{
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      adapterVersion: '2.0.0',
      risk: 'R3',
      requiresApproval: true,
    }]],
  ])('fails closed to an empty advertised catalog when discovery is %s', async (_name, listApplicationActions) => {
    const baseHost = host(() => true, vi.fn());
    const runtime = assembleRuntime(clientFor((request) => {
      expect(request.context.availableApplicationActions).toEqual([]);
      return {
        requestId: request.requestId,
        runId: `run-catalog-${_name}`,
        message: '没有可用动作。',
        mood: 'neutral',
        intents: [],
      };
    }), emptyRegistry, () => undefined, {
      ...baseHost,
      listApplicationActions,
    });

    await expect(run(runtime)).resolves.toMatchObject({ message: '没有可用动作。' });
  });

  it('exposes an unknown effect as terminal and never reports an accepted revision', async () => {
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) =>
      committedReceipt(request, {
        status: 'unknown',
        retryable: false,
        errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
      }));
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: 'run-unknown-action',
      message: '发送结果无法确定。',
      mood: 'concerned',
      intents: [applicationAction('send-current-unknown')],
    })), emptyRegistry, () => undefined, host(() => true, executeApplicationAction));

    const response = await run(runtime);
    const receipt = response.receipts?.[0];

    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ id: 'send-current-unknown', status: 'unknown' });
    expect(receipt?.detail).toContain('outcome is unknown');
    expect(receipt?.detail).toContain('not retried');
    expect(receipt?.detail).not.toContain('OS revision');
  });

  it.each([
    ['mismatched', (request: ApplicationControlExecuteRequest) => committedReceipt(request, { actionId: 'wechat.message.other' })],
    ['malformed', () => ({ status: 'committed', receiptId: 'forged' })],
    ['impossible-success', (request: ApplicationControlExecuteRequest) => committedReceipt(request, {
      approvedByUser: false,
      retryable: true,
      errorCode: 'INTERNAL_ERROR',
    })],
  ])('fails closed on a %s Host receipt', async (_name, respond) => {
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) => respond(request));
    const runtime = assembleRuntime(clientFor((request) => ({
      requestId: request.requestId,
      runId: 'run-untrusted-receipt',
      message: '回执不可信。',
      mood: 'concerned',
      intents: [applicationAction(`send-current-${_name}`)],
    })), emptyRegistry, () => undefined, host(() => true, executeApplicationAction));

    const response = await run(runtime);

    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(response.receipts?.[0]).toMatchObject({ status: 'failed' });
    expect(response.receipts?.[0]?.detail).not.toContain('OS revision');
  });

  it('denies an undeclared domain Agent action without approval or Host dispatch', async () => {
    const manifest = validateAgentManifest({
      id: 'local.application-observer',
      name: '只读应用助手',
      version: '1.0.0',
      description: '仅可查看应用状态。',
      instructions: '不得执行应用动作。',
      capabilities: ['os.app.open'],
      publisher: { id: 'local.publisher', displayName: 'Local Publisher', trust: 'local-unverified' },
      contributions: ['domain-agent'],
      contentDigest: `sha256:${'b'.repeat(64)}`,
    });
    const installation: InstalledAgent = {
      installationId: 'installation-application-observer',
      manifest,
      digest: manifest.contentDigest,
      status: 'enabled',
      installedAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      grantedCapabilities: [],
    };
    const registry: AgentRegistry = {
      ...emptyRegistry,
      list: () => [installation],
      get: (id) => id === manifest.id ? installation : undefined,
    };
    const confirmCapability = vi.fn<AgentRuntimeHostPort['confirmCapability']>(() => true);
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>();
    const runtime = assembleRuntime(clientFor((request) => {
      expect(request.context.availableApplicationActions).toEqual([]);
      return {
        requestId: request.requestId,
        runId: 'run-domain-denied-action',
        message: '无权发送。',
        mood: 'concerned',
        activeAgentId: manifest.id,
        intents: [applicationAction('domain-send-current')],
      };
    }), registry, () => undefined, host(confirmCapability, executeApplicationAction));

    const response = await run(runtime, `/agent ${manifest.id} 发送消息`);

    expect(confirmCapability).not.toHaveBeenCalled();
    expect(executeApplicationAction).not.toHaveBeenCalled();
    expect(response.receipts?.[0]).toMatchObject({ id: 'domain-send-current', status: 'failed' });
  });

  it('dispatches a declared domain Agent action with its bound principal and no renderer approval', async () => {
    const manifest = validateAgentManifest({
      id: 'local.application-controller',
      name: '应用控制助手',
      version: '1.0.0',
      description: '在用户明确委派时请求执行应用动作。',
      instructions: '只能请求声明的语义动作。',
      capabilities: ['app.action.execute'],
      publisher: { id: 'local.publisher', displayName: 'Local Publisher', trust: 'local-unverified' },
      contributions: ['domain-agent'],
      contentDigest: `sha256:${'c'.repeat(64)}`,
    });
    const installation: InstalledAgent = {
      installationId: 'installation-application-controller',
      manifest,
      digest: manifest.contentDigest,
      status: 'enabled',
      installedAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      grantedCapabilities: [],
    };
    const registry: AgentRegistry = {
      ...emptyRegistry,
      list: () => [installation],
      get: (id) => id === manifest.id ? installation : undefined,
    };
    const confirmCapability = vi.fn<AgentRuntimeHostPort['confirmCapability']>(() => true);
    const observed: ApplicationControlExecuteRequest[] = [];
    const executeApplicationAction = vi.fn<AgentRuntimeHostPort['executeApplicationAction']>(async (request) => {
      observed.push(request);
      return committedReceipt(request);
    });
    const runtime = assembleRuntime(clientFor((request) => {
      expect(request.context.availableApplicationActions).toEqual([{
        appId: 'wechat',
        actionId: 'wechat.message.send_to_current',
        argumentSchemaId: 'wechat.message.send_to_current.arguments@1',
      }]);
      return {
        requestId: request.requestId,
        runId: 'run-domain-declared-action',
        message: '已提交。',
        mood: 'focused',
        activeAgentId: manifest.id,
        intents: [applicationAction('domain-send-declared')],
      };
    }), registry, () => undefined, host(confirmCapability, executeApplicationAction));

    const response = await run(runtime, `/agent ${manifest.id} 发送消息`);

    expect(confirmCapability).not.toHaveBeenCalled();
    expect(executeApplicationAction).toHaveBeenCalledOnce();
    expect(observed[0]?.principal).toEqual({
      kind: 'agent',
      instanceId: `domain-agent:${manifest.id}@${manifest.version}#${manifest.contentDigest}:local`,
      packageId: `${manifest.id}@${manifest.version}`,
      userId: 'local-user',
    });
    expect(response.receipts?.[0]).toMatchObject({
      id: 'domain-send-declared',
      label: expect.stringContaining('app.action.execute'),
      status: 'accepted',
    });
  });
});
