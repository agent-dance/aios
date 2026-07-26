import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AssistantActionReceipt,
  AssistantClient,
  AssistantConversationEntry,
  AssistantDebugEvent,
  AssistantSurfaceRenderer,
} from '../assistant';
import type { AiPrivacyStatus } from '../apps/settings';
import type { AgentLibraryEntry, AgentLibraryPort } from '../apps/store';
import type {
  DoudizhuAgentControllerFactory,
  DoudizhuAgentController,
  DoudizhuAction,
  DoudizhuPhase,
  DoudizhuSeatId,
  SeatProjection,
} from '../apps/doudizhu';
import type {
  SpaceGameAction,
  SpaceGameAgentController,
  SpaceGameObservation,
  SpaceGamePhase,
  SpaceGameSeatId,
} from '../apps/space-game';
import {
  createBrowserAgentRegistry,
  validateAgentManifest,
  type AgentRegistryPersistenceMode,
  type AgentRegistry,
} from '../agent-platform/agentManifest';
import type { A2uiSurface } from '../agent-platform/a2ui';
import {
  CapabilityBrokerError,
  createCapabilityBroker,
  type CapabilityBroker,
  type CapabilityReceipt,
  type OsCapabilityPorts,
} from '../agent-platform/capabilityBroker';
import { createSidecarAgentController } from '../agent-platform/game';
import type { BrokerIntent, OsIntent } from '../agent-platform/intents';
import {
  AIOS_AGENT_DEBUG_PROFILE,
  type AgentDebugEvent,
  type HealthResponse,
  type OsContextSnapshot,
} from '../agent-platform/protocol';
import { createSidecarClient, type SidecarClient } from '../agent-platform/sidecarClient';
import { isAppId } from '../system/appRegistry';
import type { SystemPreferences } from '../system/types';
import { useSystemStore } from '../system/useSystemStore';
import { A2uiErrorBoundary } from './A2uiErrorBoundary';
import { startSidecarHealthMonitor, type SidecarHealthMonitor } from './healthMonitor';

const systemRevisionClock = (() => {
  let revision = 0;
  useSystemStore.subscribe(() => { revision += 1; });
  return Object.freeze({
    getRevision: () => revision,
    bumpRevision: () => {
      revision += 1;
      return revision;
    },
  });
})();

interface InjectedSidecarConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly origin?: string;
}

declare global {
  interface Window {
    /** Injected by the trusted desktop launcher. Never persisted by the WebView. */
    __AIOS_SIDECAR_CONFIG__?: InjectedSidecarConfig;
  }
}

export interface AgentSurfaceEnvelope {
  readonly surface: A2uiSurface;
  readonly intents: readonly OsIntent[];
}

interface AgentRuntimeValue {
  readonly assistantClient: AssistantClient<AgentSurfaceEnvelope>;
  readonly renderSurface: AssistantSurfaceRenderer<AgentSurfaceEnvelope>;
  readonly onSurfaceAction: (intentId: string) => Promise<AssistantActionReceipt>;
  readonly doudizhuControllerFactory?: DoudizhuAgentControllerFactory;
  readonly spaceGameController?: SpaceGameAgentController;
  readonly agentLibrary?: AgentLibraryPort;
  readonly aiStatus: AiPrivacyStatus;
  readonly connected: boolean;
}

const unavailableClient: AssistantClient<AgentSurfaceEnvelope> = Object.freeze({
  run: async () => {
    throw new Error('本机 Agent sidecar 尚未连接。请通过受信启动器启动 AlSniper Agent Runtime。');
  },
});

const LazyAiosA2uiSurface = lazy(() =>
  import('./LazyAiosA2uiSurface').then((module) => ({ default: module.LazyAiosA2uiSurface })),
);

const renderSurface: AssistantSurfaceRenderer<AgentSurfaceEnvelope> = (envelope, onAction) => (
  <A2uiErrorBoundary resetKey={envelope}>
    <Suspense fallback={<div role="status">正在准备交互界面…</div>}>
      <LazyAiosA2uiSurface envelope={envelope} onAction={onAction} />
    </Suspense>
  </A2uiErrorBoundary>
);

const EMPTY_ACTION = async (): Promise<AssistantActionReceipt> => ({
  id: 'agent-runtime-unavailable',
  label: 'Agent Runtime',
  status: 'failed',
  detail: 'Sidecar is not connected.',
});

const initialValue: AgentRuntimeValue = Object.freeze({
  assistantClient: unavailableClient,
  renderSurface,
  onSurfaceAction: EMPTY_ACTION,
  aiStatus: {
    runtime: 'unconfigured' as const,
    providerLabel: 'Local Codex sidecar',
    authenticationLabel: 'Not connected',
    voiceInput: 'permission-required' as const,
    installedAgentCount: 0,
    dataBoundary: 'Model credentials remain outside the browser.',
  },
  connected: false,
});

const AgentRuntimeContext = createContext<AgentRuntimeValue>(initialValue);

let consumedSidecarConfig: InjectedSidecarConfig | undefined;

const resolveConfig = (): InjectedSidecarConfig | undefined => {
  const injected = window.__AIOS_SIDECAR_CONFIG__;
  if (injected) {
    delete window.__AIOS_SIDECAR_CONFIG__;
    consumedSidecarConfig = Object.freeze({ ...injected });
  }
  if (consumedSidecarConfig) return consumedSidecarConfig;
  if (!import.meta.env.DEV) return undefined;
  const baseUrl = import.meta.env.VITE_AIOS_SIDECAR_URL as string | undefined;
  const token = import.meta.env.VITE_AIOS_SIDECAR_TOKEN as string | undefined;
  return baseUrl && token ? { baseUrl, token } : undefined;
};

const voiceAvailability = (): AiPrivacyStatus['voiceInput'] =>
  'SpeechRecognition' in window || 'webkitSpeechRecognition' in window ? 'permission-required' : 'unavailable';

export const describeAgentDataBoundary = (
  base: string,
  persistenceMode: AgentRegistryPersistenceMode,
): string => persistenceMode === 'persistent'
  ? base
  : `${base} Agent packages are available for this session only because browser persistence is unavailable.`;

export const describeProviderAuthentication = (health: HealthResponse | undefined): string => {
  if (health === undefined) return 'Unavailable';
  const authenticationLink = health.checks.find((check) => check.code === 'auth_link');
  if (authenticationLink?.status === 'fail') return 'Not signed in — run codex login, then retry';
  const providerAuthentication = health.checks.find((check) => check.code === 'auth_provider');
  if (providerAuthentication?.status === 'fail') return 'Rejected — run codex login, then retry';
  if (providerAuthentication?.status === 'pass') return 'Verified local authentication';
  return 'Linked; provider verification pending';
};

interface ReceiptAgentIdentity {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

const receiptView = (receipt: CapabilityReceipt, agent?: ReceiptAgentIdentity): AssistantActionReceipt => ({
  id: receipt.intentId,
  label: agent === undefined ? receipt.capability : `${agent.name} ${agent.version} · ${receipt.capability}`,
  status: 'accepted',
  detail: [
    ...(agent === undefined ? [] : [`Package digest: ${agent.digest}.`]),
    receipt.approvedByUser
      ? `Approved and committed at OS revision ${receipt.revision}.`
      : `Committed at OS revision ${receipt.revision}.`,
  ].join(' '),
});

const failedReceipt = (
  intentId: string,
  error: unknown,
  agent?: ReceiptAgentIdentity,
): AssistantActionReceipt => ({
  id: intentId,
  label: agent === undefined ? 'OS capability' : `${agent.name} ${agent.version} · OS capability`,
  status: error instanceof CapabilityBrokerError && error.code === 'BROKER_APPROVAL_DENIED' ? 'rejected' : 'failed',
  detail: [
    ...(agent === undefined ? [] : [`Package digest: ${agent.digest}.`]),
    error instanceof Error ? error.message : 'The capability operation failed.',
  ].join(' '),
});

const libraryEntries = (registry: AgentRegistry): readonly AgentLibraryEntry[] => registry.list().map((installation) => ({
  id: installation.manifest.id,
  name: installation.manifest.name,
  version: installation.manifest.version,
  publisher: `${installation.manifest.publisher.displayName} · ${installation.manifest.publisher.trust}`,
  description: installation.manifest.description,
  capabilities: installation.manifest.capabilities,
  installed: true,
  enabled: installation.status === 'enabled',
}));

interface BoundDomainAgent {
  readonly id: string;
  readonly message: string;
  readonly projection: NonNullable<OsContextSnapshot['enabledAgents']>[number];
}

const DOMAIN_AGENT_DIRECTIVE = /^\/agent\s+([a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?)(?:\s+([\s\S]*))?$/;

const bindDomainAgent = (registry: AgentRegistry, message: string): BoundDomainAgent | undefined => {
  const trimmedMessage = message.trim();
  const match = DOMAIN_AGENT_DIRECTIVE.exec(trimmedMessage);
  if (!match) {
    if (trimmedMessage === '/agent' || trimmedMessage.startsWith('/agent ')) {
      throw new Error('Use /agent <installed-agent-id> <message>.');
    }
    return undefined;
  }
  const id = match[1]!;
  const installation = registry.get(id);
  if (
    installation === undefined ||
    installation.status !== 'enabled' ||
    !installation.manifest.contributions.includes('domain-agent')
  ) {
    throw new Error(`Domain Agent ${id} is not installed and enabled.`);
  }
  const delegatedMessage = match[2]?.trim();
  if (!delegatedMessage) throw new Error('A domain Agent request must include a message after its id.');
  const manifest = validateAgentManifest(installation.manifest);
  return Object.freeze({
    id: manifest.id,
    message: delegatedMessage,
    projection: Object.freeze({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      instructions: manifest.instructions,
      capabilities: manifest.capabilities,
      contributions: manifest.contributions,
    }),
  });
};

const desktopPrincipalHistory = (
  history: readonly AssistantConversationEntry[] | undefined,
) => {
  if (history === undefined) return undefined;
  const safeHistory: AssistantConversationEntry[] = [];
  let suppressDomainResponse = false;
  for (const entry of history) {
    if (entry.role === 'user') {
      if (entry.content.trim() === '/agent' || entry.content.trim().startsWith('/agent ')) {
        suppressDomainResponse = true;
        continue;
      }
      suppressDomainResponse = false;
      safeHistory.push(entry);
      continue;
    }
    if (suppressDomainResponse) {
      suppressDomainResponse = false;
      continue;
    }
    safeHistory.push(entry);
  }
  return Object.freeze(safeHistory);
};

interface RuntimeAssembly {
  readonly assistantClient: AssistantClient<AgentSurfaceEnvelope>;
  readonly onSurfaceAction: (intentId: string) => Promise<AssistantActionReceipt>;
  readonly doudizhuControllerFactory: DoudizhuAgentControllerFactory;
  readonly spaceGameController: SpaceGameAgentController;
}

export interface AgentRuntimeHostPort {
  readonly confirmCapability: (request: AgentRuntimeApprovalRequest) => boolean | Promise<boolean>;
  readonly locale: () => string;
  readonly requestId: () => string;
}

export interface AgentRuntimeApprovalRequest {
  readonly capability: string;
  readonly principalPackageId: string;
  readonly principalInstanceId: string;
  readonly agentName: string;
  readonly operation: string;
  readonly target: string;
  readonly details: readonly string[];
}

const browserHost: AgentRuntimeHostPort = Object.freeze({
  confirmCapability: (request: AgentRuntimeApprovalRequest) => window.confirm([
    `${request.agentName} 请求执行：${request.operation}`,
    `能力：${request.capability}`,
    `目标：${request.target}`,
    ...request.details,
    '',
    '是否允许本次操作？',
  ].join('\n')),
  locale: () => navigator.language,
  requestId: () => crypto.randomUUID(),
});

export const assembleRuntime = (
  client: SidecarClient,
  registry: AgentRegistry,
  refreshAgents: () => void,
  host: AgentRuntimeHostPort = browserHost,
): RuntimeAssembly => {
  type DebugObserver = (event: AssistantDebugEvent) => void | Promise<void>;
  type DebugEmitter = (
    source: AgentDebugEvent['source'],
    stage: AgentDebugEvent['stage'],
    status: AgentDebugEvent['status'],
    title: string,
    detail?: string,
  ) => void;
  const createDebugEmitter = (
    observer: DebugObserver | undefined,
    traceId: string,
  ): DebugEmitter | undefined => {
    if (!observer) return undefined;
    const startedAt = Date.now();
    let sequence = 0;
    return (source, stage, status, title, detail) => {
      const timeUnixMs = Date.now();
      const event: AgentDebugEvent = {
        kind: 'trace',
        traceId,
        sequence: sequence++,
        timeUnixMs,
        source,
        stage,
        status,
        title,
        ...(detail === undefined ? {} : { detail }),
        elapsedMs: Math.max(0, timeUnixMs - startedAt),
      };
      try {
        void Promise.resolve(observer(event)).catch(() => undefined);
      } catch {
        // Debug observation is intentionally isolated from authority and chat semantics.
      }
    };
  };
  const pendingIntents = new Map<string, {
    intent: OsIntent;
    revision: number;
    activeAgentId?: string;
    emitDebug?: DebugEmitter;
  }>();
  const ports: OsCapabilityPorts = {
      apps: {
        open: (appId) => {
          if (!isAppId(appId) || !useSystemStore.getState().isAppLaunchable(appId)) throw new Error('App is not installed and enabled.');
          useSystemStore.getState().openApp(appId);
        },
        close: (appId) => {
          if (!isAppId(appId)) throw new Error('Unknown app.');
          useSystemStore.getState().closeApp(appId);
        },
        focus: (appId) => {
          if (!isAppId(appId) || !useSystemStore.getState().isAppLaunchable(appId)) throw new Error('App is not installed and enabled.');
          useSystemStore.getState().focusApp(appId);
        },
        minimize: (appId) => {
          if (!isAppId(appId)) throw new Error('Unknown app.');
          useSystemStore.getState().minimizeApp(appId);
        },
      },
      preferences: {
        update: (preferences) => {
          if (preferences.accent !== undefined && !['lime', 'cyan', 'amber'].includes(preferences.accent)) {
            throw new Error('Unsupported accent.');
          }
          const patch: Partial<SystemPreferences> = {
            ...(preferences.theme === undefined ? {} : { theme: preferences.theme }),
            ...(preferences.reduceMotion === undefined ? {} : { reduceMotion: preferences.reduceMotion }),
            ...(preferences.soundEffects === undefined ? {} : { soundEffects: preferences.soundEffects }),
            ...(preferences.dockMagnification === undefined ? {} : { dockMagnification: preferences.dockMagnification }),
            ...(preferences.accent === undefined ? {} : { accent: preferences.accent as SystemPreferences['accent'] }),
          };
          useSystemStore.getState().updatePreferences(patch);
        },
      },
      systemStatus: {
        update: (statusPatch) => {
          const result = useSystemStore.getState().updateSystemStatus(statusPatch);
          if (!result.ok) throw new Error(`System status update failed: ${result.code}`);
        },
      },
      store: {
        install: (listingId) => {
          if (!isAppId(listingId)) throw new Error('Only signed built-in app listings can be installed in this release.');
          const result = useSystemStore.getState().installApp(listingId);
          if (!result.ok) throw new Error(`App installation failed: ${result.code}`);
        },
      },
      agents: {
        install: async (manifest) => {
          const previousDigest = registry.get(manifest.id)?.digest;
          const installed = await registry.install(manifest);
          if (installed.digest !== previousDigest) systemRevisionClock.bumpRevision();
          refreshAgents();
        },
      },
      surfaces: {
        publish: () => {
          throw new Error('Out-of-band surfaces are disabled; publish A2UI through the authenticated chat response.');
        },
      },
  };
  const approvalView = (
    principalPackageId: string,
    principalInstanceId: string,
    capability: string,
    intent: BrokerIntent,
  ): AgentRuntimeApprovalRequest => {
    const installedAgent = registry.list().find((entry) =>
      `${entry.manifest.id}@${entry.manifest.version}` === principalPackageId);
    const identity = installedAgent?.manifest.name ?? 'AlSniper OS Desktop Assistant';
    const provenance = installedAgent === undefined ? [] : [
      `版本：${installedAgent.manifest.version}`,
      `内容摘要：${installedAgent.digest}`,
    ];
    const requester = { capability, principalPackageId, principalInstanceId, agentName: identity };
    switch (intent.type) {
      case 'open_app':
      case 'close_app':
      case 'focus_app':
      case 'minimize_app':
        return { ...requester, operation: intent.type, target: intent.appId, details: provenance };
      case 'install_app':
        return { ...requester, operation: '安装应用', target: intent.listingId, details: provenance };
      case 'set_preferences':
        return {
          ...requester,
          operation: '修改系统偏好',
          target: Object.keys(intent.preferences).join(', '),
          details: [...provenance, ...Object.entries(intent.preferences).map(([key, value]) => `${key}: ${String(value)}`)],
        };
      case 'set_system_status':
        return {
          ...requester,
          operation: '修改系统控制项',
          target: Object.keys(intent.statusPatch).join(', '),
          details: [...provenance, ...Object.entries(intent.statusPatch).map(([key, value]) => `${key}: ${String(value)}`)],
        };
      case 'install_agent':
        return {
          ...requester,
          operation: '安装领域 Agent',
          target: `${intent.manifest.name} (${intent.manifest.id})`,
          details: [
            ...provenance,
            `版本：${intent.manifest.version}`,
            `发布者：${intent.manifest.publisher.displayName} (${intent.manifest.publisher.id}, ${intent.manifest.publisher.trust})`,
            `内容摘要：${intent.manifest.contentDigest}`,
            `声明能力：${intent.manifest.capabilities.join(', ') || '无'}`,
          ],
        };
      case 'publish_surface':
        return {
          ...requester,
          operation: '发布交互界面',
          target: intent.surface.id,
          details: [...provenance, `组件数：${intent.surface.components.length}`],
        };
    }
  };
  const approval = {
    request: ({ principal, capability, intent }: {
      readonly principal: { readonly packageId: string; readonly instanceId: string };
      readonly capability: string;
      readonly intent: BrokerIntent;
    }) => host.confirmCapability(approvalView(principal.packageId, principal.instanceId, capability, intent)),
  };
  const broker = createCapabilityBroker({
    principal: {
      kind: 'agent',
      instanceId: 'desktop-assistant:local',
      packageId: 'ai.alsniper.desktop-assistant@1.0.0',
      userId: 'local-user',
    },
    policy: {
      authorize: ({ risk }) => risk === 'high' ? 'require-approval' : 'allow',
    },
    approval,
    revisionClock: systemRevisionClock,
    ports,
  });

  const domainBrokers = new Map<string, { readonly digest: string; readonly broker: CapabilityBroker }>();
  const brokerForAgent = (activeAgentId: string): CapabilityBroker => {
    const installation = registry.get(activeAgentId);
    if (
      !installation ||
      installation.status !== 'enabled' ||
      !installation.manifest.contributions.includes('domain-agent')
    ) {
      throw new Error('The selected domain Agent is not installed and enabled.');
    }
    const manifest = validateAgentManifest(installation.manifest);
    const cached = domainBrokers.get(activeAgentId);
    if (cached?.digest === installation.digest) return cached.broker;
    const domainBroker = createCapabilityBroker({
      principal: {
        kind: 'agent',
        instanceId: `domain-agent:${manifest.id}@${manifest.version}#${installation.digest}:local`,
        packageId: `${manifest.id}@${manifest.version}`,
        userId: 'local-user',
      },
      policy: {
        authorize: ({ capability }) => manifest.capabilities.includes(capability) ? 'require-approval' : 'deny',
      },
      approval,
      revisionClock: systemRevisionClock,
      ports,
    });
    domainBrokers.set(activeAgentId, { digest: installation.digest, broker: domainBroker });
    return domainBroker;
  };

  const executeIntent = async (
    intent: OsIntent,
    revision: number,
    activeAgentId?: string,
    emitDebug?: DebugEmitter,
  ): Promise<AssistantActionReceipt> => {
    const installation = activeAgentId === undefined ? undefined : registry.get(activeAgentId);
    const agentIdentity = installation === undefined ? undefined : {
      name: installation.manifest.name,
      version: installation.manifest.version,
      digest: installation.digest,
    };
    emitDebug?.(
      'broker',
      'authorization',
      'started',
      'Checking OS capability authorization',
      `Intent type: ${intent.type}`,
    );
    try {
      const authority = activeAgentId === undefined ? broker : brokerForAgent(activeAgentId);
      const receipt = await authority.execute(intent, { expectedRevision: revision });
      emitDebug?.(
        'broker',
        'authorization',
        'completed',
        'OS capability authorized and executed',
        `Intent type: ${intent.type}`,
      );
      emitDebug?.(
        'runtime',
        'completion',
        'completed',
        'Capability receipt issued',
        `Receipt status: accepted; OS revision: ${receipt.revision}`,
      );
      return receiptView(receipt, agentIdentity);
    } catch (error) {
      const receipt = failedReceipt(intent.id, error, agentIdentity);
      emitDebug?.(
        'broker',
        'authorization',
        'failed',
        'OS capability was not executed',
        `Intent type: ${intent.type}`,
      );
      emitDebug?.(
        'runtime',
        'completion',
        receipt.status === 'rejected' ? 'info' : 'failed',
        'Capability receipt issued',
        `Receipt status: ${receipt.status}`,
      );
      return receipt;
    }
  };

  const assistantClient: AssistantClient<AgentSurfaceEnvelope> = {
    run: async (request) => {
      const { threadId, message, signal } = request;
      pendingIntents.clear();
      const revision = broker.getRevision();
      const system = useSystemStore.getState();
      // Domain instructions are untrusted package data. The Host binds exactly
      // one principal only on an explicit `/agent <id> <message>` delegation;
      // ordinary desktop turns never receive package instructions.
      const boundDomainAgent = bindDomainAgent(registry, message);
      const enabledAgents = boundDomainAgent === undefined
        ? Object.freeze([])
        : Object.freeze([boundDomainAgent.projection]);
      const principalHistory = boundDomainAgent === undefined
        ? desktopPrincipalHistory(request.history)
        : Object.freeze([]);
      const runningGameIds = (['space-game', 'doudizhu'] as const)
        .filter((gameId) => system.windows[gameId]?.isOpen === true);
      const requestId = `chat-${host.requestId()}`;
      const emitDebug = createDebugEmitter(request.onDebugEvent, requestId);
      const response = await client.chat({
        requestId,
        threadId,
        message: boundDomainAgent?.message ?? message,
        ...(principalHistory === undefined ? {} : { history: principalHistory }),
        context: {
          osRevision: revision,
          locale: host.locale(),
          ...(system.activeAppId ? { activeAppId: system.activeAppId } : {}),
          theme: system.preferences.theme,
          installedAppIds: Object.values(system.appInstallations)
            .filter((entry) => entry?.enabled)
            .map((entry) => entry!.appId),
          installedAgentIds: registry.list().filter((entry) => entry.status === 'enabled').map((entry) => entry.manifest.id),
          systemStatus: { ...system.systemStatus },
          runningGameIds,
          enabledAgents,
        },
        ...(request.onDebugEvent ? { debug: { profile: AIOS_AGENT_DEBUG_PROFILE } } : {}),
      }, {
        signal,
        ...(request.onDebugEvent ? {
          onDebugEvent: (event) => {
            try {
              void Promise.resolve(request.onDebugEvent?.(event)).catch(() => undefined);
            } catch {
              // Debug observation is intentionally isolated from chat completion.
            }
          },
        } : {}),
      });
      if (response.activeAgentId !== undefined && response.activeAgentId !== boundDomainAgent?.id) {
        throw new Error('The sidecar response does not match the Host-bound domain Agent principal.');
      }
      const authorityAgentId = boundDomainAgent?.id;
      const referenced = new Set(response.surface?.components
        .filter((component) => component.type === 'button')
        .map((component) => component.intentId) ?? []);
      const receipts: AssistantActionReceipt[] = [];
      for (const intent of response.intents) {
        if (referenced.has(intent.id)) {
          pendingIntents.set(intent.id, {
            intent,
            revision,
            ...(authorityAgentId === undefined ? {} : { activeAgentId: authorityAgentId }),
            ...(emitDebug === undefined ? {} : { emitDebug }),
          });
        } else {
          receipts.push(await executeIntent(intent, revision, authorityAgentId, emitDebug));
        }
      }
      return {
        message: response.message,
        mood: 'speaking',
        ...(response.surface ? { surface: { surface: response.surface, intents: response.intents } } : {}),
        ...(receipts.length > 0 ? { receipts } : {}),
      };
    },
  };

  const onSurfaceAction = async (intentId: string): Promise<AssistantActionReceipt> => {
    const pending = pendingIntents.get(intentId);
    if (!pending) return { id: intentId, label: 'OS capability', status: 'failed', detail: 'This action is no longer available.' };
    const receipt = await executeIntent(
      pending.intent,
      pending.revision,
      pending.activeAgentId,
      pending.emitDebug,
    );
    if (receipt.status === 'accepted' || receipt.status === 'rejected') pendingIntents.delete(intentId);
    return receipt;
  };

  const doudizhuController = createSidecarAgentController<
    DoudizhuSeatId,
    DoudizhuPhase,
    SeatProjection,
    DoudizhuAction
  >({ client, timeoutMs: 20_000 });
  const doudizhuControllerFactory: DoudizhuAgentControllerFactory = (binding) => {
    const chooseAction: DoudizhuAgentController['chooseAction'] = (decision, signal) =>
      doudizhuController.chooseAction(decision, signal);
    return Object.freeze({ binding, chooseAction });
  };
  const spaceGameController = createSidecarAgentController<
    SpaceGameSeatId,
    SpaceGamePhase,
    SpaceGameObservation,
    SpaceGameAction,
    'sequential'
  >({ client, timeoutMs: 8_000 });

  return { assistantClient, onSurfaceAction, doudizhuControllerFactory, spaceGameController };
};

export const createAgentLibraryPort = (
  registry: AgentRegistry,
  refreshAgents: () => void,
  bumpRevision: () => number = systemRevisionClock.bumpRevision,
): AgentLibraryPort => Object.freeze({
  entries: libraryEntries(registry),
  install: async () => { throw new Error('Agent packages are installed from a signed or locally generated manifest.'); },
  enable: async (id: string) => {
    const before = registry.get(id);
    const after = await registry.enable(id);
    if (before?.status !== after.status) bumpRevision();
    refreshAgents();
  },
  disable: async (id: string) => {
    const before = registry.get(id);
    const after = await registry.disable(id);
    if (before?.status !== after.status) bumpRevision();
    refreshAgents();
  },
  uninstall: async (id: string) => {
    if (await registry.uninstall(id)) bumpRevision();
    refreshAgents();
  },
});

export function AgentRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const [value, setValue] = useState<AgentRuntimeValue>(initialValue);
  const [agentEntries, setAgentEntries] = useState<readonly AgentLibraryEntry[]>([]);
  const [agentPersistenceMode, setAgentPersistenceMode] = useState<AgentRegistryPersistenceMode>('persistent');

  useEffect(() => {
    let disposed = false;
    let healthMonitor: SidecarHealthMonitor | undefined;
    const config = resolveConfig();
    if (!config) return;
    void (async () => {
      try {
        const client = createSidecarClient({
          baseUrl: config.baseUrl,
          token: config.token,
          origin: config.origin ?? window.location.origin,
        });
        const registry = await createBrowserAgentRegistry({
          onPersistenceModeChange: (mode) => {
            if (!disposed) setAgentPersistenceMode(mode);
          },
        });
        if (disposed) return;
        const refreshAgents = () => {
          if (!disposed) setAgentEntries(libraryEntries(registry));
        };
        refreshAgents();
        const runtime = assembleRuntime(client, registry, refreshAgents);
        const agentLibrary = createAgentLibraryPort(registry, refreshAgents);
        const publishConnection = (health: HealthResponse | undefined): void => {
          if (disposed) return;
          const connected = health?.status === 'ready';
          const authenticationLabel = describeProviderAuthentication(health);
          setValue({
            assistantClient: runtime.assistantClient,
            renderSurface,
            onSurfaceAction: runtime.onSurfaceAction,
            doudizhuControllerFactory: runtime.doudizhuControllerFactory,
            spaceGameController: runtime.spaceGameController,
            agentLibrary,
            aiStatus: {
              runtime: connected ? 'connected' : 'offline',
              providerLabel: 'Codex via agent-adaptor',
              authenticationLabel,
              voiceInput: voiceAvailability(),
              installedAgentCount: registry.list().length,
              dataBoundary: 'Credentials and model processes remain in the loopback Go sidecar; OS effects require Broker receipts.',
            },
            connected,
          });
        };
        healthMonitor = startSidecarHealthMonitor(client, publishConnection);
      } catch {
        if (disposed) return;
        setValue({
          ...initialValue,
          aiStatus: { ...initialValue.aiStatus, runtime: 'offline', voiceInput: voiceAvailability() },
        });
      }
    })();
    return () => {
      disposed = true;
      healthMonitor?.dispose();
    };
  }, []);

  const effectiveValue = useMemo<AgentRuntimeValue>(() => {
    if (!value.agentLibrary) return value;
    return {
      ...value,
      agentLibrary: { ...value.agentLibrary, entries: agentEntries },
      aiStatus: {
        ...value.aiStatus,
        installedAgentCount: agentEntries.length,
        dataBoundary: describeAgentDataBoundary(value.aiStatus.dataBoundary, agentPersistenceMode),
      },
    };
  }, [agentEntries, agentPersistenceMode, value]);

  return <AgentRuntimeContext.Provider value={effectiveValue}>{children}</AgentRuntimeContext.Provider>;
}

export const useAgentRuntime = (): AgentRuntimeValue => useContext(AgentRuntimeContext);
