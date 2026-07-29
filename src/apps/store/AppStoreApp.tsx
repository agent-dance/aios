import {
  ArrowRight,
  BadgeCheck,
  Clock3,
  Download,
  Folder,
  Gamepad2,
  LockKeyhole,
  MessagesSquare,
  Search,
  Settings,
  ShoppingBag,
  Spade,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeApplicationPort, NativeApplicationStatus } from '../../native-apps';
import { APP_REGISTRY } from '../../system/appRegistry';
import { useSystemStore } from '../../system/useSystemStore';
import type { AppId, SystemPreferences, Theme } from '../../system/types';
import { WECHAT_OFFICIAL_DESTINATIONS } from '../wechat';
import { commitWeChatProjection, installWeChatTransaction, WECHAT_TERMS_NOTICE } from './weChatInstallation';
import './AppStoreApp.css';

type StoreCategory = 'all' | 'system' | 'productivity' | 'creative' | 'games' | 'agents';

export interface AgentLibraryEntry {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  capabilities: readonly string[];
  installed: boolean;
  enabled: boolean;
}

export interface AgentLibraryPort {
  entries: readonly AgentLibraryEntry[];
  install: (agentId: string) => void | Promise<void>;
  enable: (agentId: string) => void | Promise<void>;
  disable: (agentId: string) => void | Promise<void>;
  uninstall: (agentId: string) => void | Promise<void>;
}

export interface AppStoreAppProps {
  agentLibrary?: AgentLibraryPort;
  nativeApplications?: NativeApplicationPort;
  onOpenApp?: (appId: AppId) => void;
}

interface StorePermission {
  name: string;
  scope: string;
  reason: string;
}

interface StoreListing {
  id: string;
  name: string;
  category: Exclude<StoreCategory, 'all'>;
  publisher: string;
  tagline: string;
  description: string;
  featuredNote: string;
  rating: string;
  installs: string;
  verified: boolean;
  capabilities: string[];
  permissions: StorePermission[];
  execution: string;
  updateDate: string;
  appId?: AppId;
  agentId?: string;
}

const ACCENT_COLORS: Record<SystemPreferences['accent'], string> = {
  lime: '#C6F94D',
  cyan: '#64F5FF',
  amber: '#FFC46B',
};

const SURFACE_BG: Record<Theme, string> = {
  aurora: 'linear-gradient(180deg, rgba(244,248,255,0.96), rgba(230,238,252,0.92))',
  midnight: 'linear-gradient(180deg, rgba(10, 14, 29, 0.98), rgba(3, 5, 12, 1))',
};

const PANEL_BG: Record<Theme, string> = {
  aurora: 'rgba(255,255,255,0.74)',
  midnight: 'rgba(9, 12, 25, 0.84)',
};

const TEXT_COLOR: Record<Theme, string> = {
  aurora: '#182033',
  midnight: '#EDF3FF',
};

const MUTED: Record<Theme, string> = {
  aurora: '#5A667F',
  midnight: '#96A3C3',
};

const BORDER: Record<Theme, string> = {
  aurora: 'rgba(76, 92, 133, 0.14)',
  midnight: 'rgba(173, 195, 255, 0.12)',
};

const CATEGORIES: { id: StoreCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'creative', label: 'Creative' },
  { id: 'games', label: 'Games' },
  { id: 'agents', label: 'Agents' },
];

const LISTINGS: StoreListing[] = [
  {
    id: 'briefing-architect',
    name: 'Briefing Architect',
    category: 'productivity',
    publisher: 'AlSniper Labs',
    tagline: 'Turns selected artifacts into executive-ready mission briefs.',
    description:
      'Builds concise board-ready writeups from scoped artifacts, preserving inputs, review checkpoints, and visible handoffs.',
    featuredNote: 'Featured for mission planning demos and structured artifact review.',
    rating: '4.9',
    installs: '8.4K',
    verified: true,
    capabilities: ['Mission briefs', 'Structured summaries', 'Review checkpoints'],
    permissions: [
      { name: 'Read selected artifacts', scope: 'Explicit user selection', reason: 'Summarize chosen files only.' },
      { name: 'Create internal artifacts', scope: 'Current mission', reason: 'Draft a brief with review history.' },
      { name: 'Request approval for external actions', scope: 'Per action', reason: 'Escalate before publishing or sharing.' },
    ],
    execution: 'Hybrid local orchestration with bounded remote reasoning',
    updateDate: '2026-07-20',
  },
  {
    id: 'settings',
    name: 'System Settings',
    category: 'system',
    publisher: 'AlSniper OS',
    tagline: 'Tune appearance, accessibility, sound, and Dock behavior.',
    description:
      'Controls host-owned preferences including shell theme, accent, reduced motion, sound effects, and Dock magnification.',
    featuredNote: 'Host-owned utility with direct preference binding.',
    rating: '5.0',
    installs: 'System',
    verified: true,
    capabilities: ['Appearance controls', 'Accessibility tuning', 'Audio and Dock options'],
    permissions: [
      { name: 'Write system preferences', scope: 'Local profile', reason: 'Update host-managed shell settings immediately.' },
    ],
    execution: 'Local first-party utility',
    updateDate: '2026-07-25',
    appId: 'settings',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    category: 'system',
    publisher: 'AlSniper OS',
    tagline: 'A safe browser command surface with a fixed allowlist.',
    description:
      'Provides a predictable, non-shell command line for local inspection and preference changes without any host process execution.',
    featuredNote: 'Recommended for fast keyboard-first exploration.',
    rating: '4.8',
    installs: 'System',
    verified: true,
    capabilities: ['Allowlist commands', 'Persistent history', 'Theme switching'],
    permissions: [
      { name: 'Read current shell preferences', scope: 'Current session', reason: 'Reflect current theme and environment values.' },
      { name: 'Write theme preference', scope: 'Exact theme command', reason: 'Update only the host theme through a bounded command.' },
    ],
    execution: 'Local first-party utility',
    updateDate: '2026-07-25',
    appId: 'terminal',
  },
  {
    id: 'finder',
    name: 'Finder',
    category: 'productivity',
    publisher: 'AlSniper OS',
    tagline: 'Browse desktop artifacts and mission outputs.',
    description:
      'Navigates workbench objects, previews mission outputs, and surfaces recent artifacts with a familiar spatial model.',
    featuredNote: 'Ideal for inspecting generated artifacts and recent work.',
    rating: '4.7',
    installs: 'System',
    verified: true,
    capabilities: ['Artifact browsing', 'Preview workflows', 'Recent mission context'],
    permissions: [
      { name: 'Read artifact metadata', scope: 'User-visible library', reason: 'List and preview accessible items.' },
    ],
    execution: 'Local first-party utility',
    updateDate: '2026-07-24',
    appId: 'finder',
  },
  {
    id: 'pulse-canvas',
    name: 'Pulse Canvas',
    category: 'creative',
    publisher: 'Auric Collective',
    tagline: 'Prototype launch visuals and reusable gradient systems.',
    description:
      'Builds campaign surface concepts from selected references while exposing every export request and sharing action for review.',
    featuredNote: 'Popular with creative teams building launch assets.',
    rating: '4.6',
    installs: '2.1K',
    verified: true,
    capabilities: ['Moodboards', 'Gradient kits', 'Export-ready concept cards'],
    permissions: [
      { name: 'Read selected references', scope: 'Explicit user selection', reason: 'Generate moodboard candidates from chosen inputs.' },
      { name: 'Export new assets', scope: 'Per approved export', reason: 'Write generated surfaces only after review.' },
    ],
    execution: 'Remote renderer with signed package manifest',
    updateDate: '2026-07-18',
  },
  {
    id: 'cosmic-vanguard',
    name: 'Cosmic Vanguard',
    category: 'games',
    publisher: 'AlSniper Arcade',
    tagline: 'A real-time 3D mission break with keyboard action.',
    description:
      'Launches the bundled space shooter with responsive controls and window-safe rendering for quick play sessions.',
    featuredNote: 'Featured because it demonstrates the interactive 3D runtime.',
    rating: '4.9',
    installs: '12.7K',
    verified: true,
    capabilities: ['3D gameplay', 'Keyboard controls', 'Windowed rendering'],
    permissions: [
      { name: 'Read keyboard input', scope: 'Focused game window', reason: 'Drive movement and firing controls.' },
    ],
    execution: 'Bundled local runtime',
    updateDate: '2026-07-22',
    appId: 'space-game',
  },
  {
    id: 'doudizhu',
    name: '斗地主',
    category: 'games',
    publisher: 'AlSniper Arcade',
    tagline: 'A native AI card table where human and Agent players share one rules contract.',
    description:
      'Plays classic three-seat Dou Dizhu through the AGAP v1 participation protocol. Every human and Agent seat receives the same authorized view, legal actions, timing, and rule validation.',
    featuredNote: 'The first Agent-native AlSniper OS game, built for fair human–AI mixed play.',
    rating: 'New',
    installs: 'Bundled',
    verified: true,
    capabilities: ['Human–Agent mixed play', 'Seat-scoped observations', 'Deterministic replay'],
    permissions: [
      { name: 'Read game controls', scope: 'Focused game window', reason: 'Submit the same structured actions available to Agent seats.' },
      { name: 'Run local game Agents', scope: 'Current match only', reason: 'Control assigned seats without access to OS tools or other seats.' },
    ],
    execution: 'Local practice authority with AGAP v1 seat-scoped projections',
    updateDate: '2026-07-26',
    appId: 'doudizhu',
  },
  {
    id: 'wechat',
    name: '微信',
    category: 'productivity',
    publisher: 'AlSniper OS',
    tagline: 'Install and launch publisher-verified WeChat through the trusted native host.',
    description:
      'AlSniper OS asks its trusted native host to install WeChat, then creates the desktop integration only after the host confirms installed, launchable, and publisher-verified state. Tencent owns the WeChat client, license, accounts, and services.',
    featuredNote: 'After a verified native installation completes, the green 微信 icon appears on the desktop and launches the real client.',
    rating: 'Host verified',
    installs: 'Available',
    verified: true,
    capabilities: ['Verified native install', 'Launch real WeChat', 'Tencent and Microsoft official fallbacks'],
    permissions: [
      { name: 'Install the native application', scope: 'Explicit Tencent license consent', reason: 'Run the trusted host installer and verify the installed publisher signature before adding a desktop icon.' },
      { name: 'Launch the native application', scope: 'Exact wechat application identifier', reason: 'Ask the trusted host to start the verified WeChat executable without accepting paths or arguments.' },
      { name: 'Open official external pages', scope: 'Exact HTTPS allowlist', reason: 'Reach Tencent downloads, Web WeChat, or the Microsoft Store official listing.' },
    ],
    execution: 'AlSniper OS trusted native host; the client, license, login, account policy, and messages remain owned by Tencent',
    updateDate: '2026-07-28',
    appId: 'wechat',
  },
];

const FALLBACK_LISTING = LISTINGS.find((listing) => listing.id === 'doudizhu')!;

const LISTING_ICONS: Record<string, ReactNode> = {
  'briefing-architect': <Sparkles size={18} />,
  settings: <Settings size={18} />,
  terminal: <SquareTerminal size={18} />,
  finder: <Folder size={18} />,
  'pulse-canvas': <BadgeCheck size={18} />,
  'cosmic-vanguard': <Gamepad2 size={18} />,
  doudizhu: <Spade size={18} />,
  wechat: <MessagesSquare size={18} color="#07c160" />,
};

function agentListing(entry: AgentLibraryEntry): StoreListing {
  return {
    id: `agent:${entry.id}`,
    agentId: entry.id,
    name: entry.name,
    category: 'agents',
    publisher: entry.publisher,
    tagline: entry.description,
    description: entry.description,
    featuredNote: `Installed Agent package ${entry.name} ${entry.version}. Capabilities remain subject to OS policy.`,
    rating: 'Agent',
    installs: entry.installed ? 'Installed' : 'Available',
    verified: false,
    capabilities: [...entry.capabilities],
    permissions: entry.capabilities.map((capability) => ({
      name: capability,
      scope: 'OS capability broker',
      reason: 'Execution is mediated by the installed Agent manifest and host policy.',
    })),
    execution: 'Local Agent package through the OS capability broker',
    updateDate: entry.version,
  };
}

function isTrustedWeChatStatus(status: NativeApplicationStatus | null): boolean {
  return Boolean(
    status?.state === 'installed' &&
    status.installed &&
    status.launchable &&
    status.publisherVerified,
  );
}

export function AppStoreApp({ agentLibrary, nativeApplications, onOpenApp }: AppStoreAppProps = {}) {
  const preferences = useSystemStore((state) => state.preferences);
  const openApp = useSystemStore((state) => state.openApp);
  const windows = useSystemStore((state) => state.windows);
  const appInstallations = useSystemStore((state) => state.appInstallations);
  const installApp = useSystemStore((state) => state.installApp);
  const enableApp = useSystemStore((state) => state.enableApp);
  const disableApp = useSystemStore((state) => state.disableApp);
  const uninstallApp = useSystemStore((state) => state.uninstallApp);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StoreCategory>('all');
  const [selectedId, setSelectedId] = useState<string>(FALLBACK_LISTING.id);
  const [agentOperation, setAgentOperation] = useState<{ readonly listingId: string; readonly label: string } | null>(null);
  const [agentOperationError, setAgentOperationError] = useState<{ readonly listingId: string; readonly message: string } | null>(null);
  const [wechatTermsAccepted, setWechatTermsAccepted] = useState(false);
  const [wechatInstallationPending, setWechatInstallationPending] = useState(false);
  const [wechatInstallationMessage, setWechatInstallationMessage] = useState<{ readonly ok: boolean; readonly message: string } | null>(null);
  const [nativeWeChatStatus, setNativeWeChatStatus] = useState<NativeApplicationStatus | null>(null);
  const [nativeWeChatStatusError, setNativeWeChatStatusError] = useState<string | null>(null);
  const agentOperationRef = useRef<string | null>(null);
  const wechatInstallationRef = useRef(false);
  const nativeWeChatStatusRequestRef = useRef(0);
  const requestOpenApp = onOpenApp ?? openApp;
  const allListings = useMemo(
    () => [...LISTINGS, ...(agentLibrary?.entries.map(agentListing) ?? [])],
    [agentLibrary?.entries],
  );

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return allListings.filter((listing) => {
      if (category !== 'all' && listing.category !== category) return false;
      if (!lower) return true;
      return [listing.name, listing.publisher, listing.tagline, listing.description, listing.capabilities.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(lower);
    });
  }, [allListings, category, query]);

  useEffect(() => {
    if (!filtered.some((listing) => listing.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? FALLBACK_LISTING.id);
    }
  }, [filtered, selectedId]);

  useEffect(() => {
    const requestId = ++nativeWeChatStatusRequestRef.current;
    if (!nativeApplications) {
      setNativeWeChatStatus(null);
      setNativeWeChatStatusError(null);
      return;
    }

    const controller = new AbortController();
    setNativeWeChatStatusError(null);
    void nativeApplications.getStatus('wechat', { signal: controller.signal }).then(
      (status) => {
        if (!controller.signal.aborted && nativeWeChatStatusRequestRef.current === requestId) {
          setNativeWeChatStatus(status);
        }
      },
      () => {
        if (controller.signal.aborted || nativeWeChatStatusRequestRef.current !== requestId) return;
        setNativeWeChatStatus(null);
        setNativeWeChatStatusError('无法查询微信原生安装状态。');
      },
    );
    return () => controller.abort();
  }, [nativeApplications]);

  const selected = filtered.find((listing) => listing.id === selectedId) ?? allListings.find((listing) => listing.id === selectedId) ?? FALLBACK_LISTING;
  const accent = ACCENT_COLORS[preferences.accent];

  const selectedAgent = selected.agentId ? agentLibrary?.entries.find((entry) => entry.id === selected.agentId) : undefined;
  const selectedInstallation = selected.appId ? appInstallations[selected.appId] : undefined;
  const isInstalled = (listing: StoreListing) => listing.appId
    ? Boolean(appInstallations[listing.appId])
    : listing.agentId
      ? Boolean(agentLibrary?.entries.find((entry) => entry.id === listing.agentId)?.installed)
      : false;
  const isEnabled = (listing: StoreListing) => listing.appId
    ? appInstallations[listing.appId]?.enabled === true
    : listing.agentId
      ? agentLibrary?.entries.find((entry) => entry.id === listing.agentId)?.enabled === true
      : false;
  const trustedNativeWeChat = isTrustedWeChatStatus(nativeWeChatStatus);
  const canOpen = Boolean(
    selected.appId &&
    selectedInstallation?.enabled &&
    (selected.appId !== 'wechat' || trustedNativeWeChat),
  );
  const selectedInstalled = isInstalled(selected);
  const selectedEnabled = isEnabled(selected);
  const primarySupported = Boolean(selected.appId || (selected.agentId && agentLibrary));
  const selectedOperationPending = agentOperation?.listingId === selected.id || (selected.id === 'wechat' && wechatInstallationPending);
  const wechatRequiresNativeInstall = selected.id === 'wechat' && !selectedInstallation;
  const wechatNeedsRepair = selected.id === 'wechat' && Boolean(selectedInstallation) && !trustedNativeWeChat;
  const primaryDisabled = selectedOperationPending || !primarySupported ||
    Boolean(selected.agentId && selectedAgent?.installed && selectedAgent.enabled) ||
    Boolean((wechatRequiresNativeInstall || wechatNeedsRepair) && (!nativeApplications || !wechatTermsAccepted));
  const selectedOperationLabel = wechatInstallationPending ? 'Installing and verifying…' : agentOperation?.label;
  const isRunning = selected.appId ? Boolean(windows[selected.appId]?.isOpen && !windows[selected.appId]?.isMinimized) : false;

  const runAgentOperation = async (listing: StoreListing, label: string, operation: () => void | Promise<unknown>) => {
    if (agentOperationRef.current !== null) return;
    agentOperationRef.current = listing.id;
    setAgentOperationError(null);
    setAgentOperation({ listingId: listing.id, label });
    try {
      await operation();
    } catch (error) {
      setAgentOperationError({
        listingId: listing.id,
        message: error instanceof Error ? error.message : `${label} failed.`,
      });
    } finally {
      agentOperationRef.current = null;
      setAgentOperation(null);
    }
  };

  const handlePrimaryAction = async (listing: StoreListing) => {
    if (listing.appId) {
      const installation = appInstallations[listing.appId];
      if (listing.appId === 'wechat' && (!installation || !trustedNativeWeChat)) {
        if (wechatInstallationRef.current) return;
        wechatInstallationRef.current = true;
        setWechatInstallationPending(true);
        setWechatInstallationMessage(null);
        try {
          const outcome = await installWeChatTransaction({
            nativeApplications,
            acceptedTerms: wechatTermsAccepted,
            commitLocalInstallation: () => {
              const currentInstallation = useSystemStore.getState().appInstallations.wechat;
              return commitWeChatProjection(
                currentInstallation,
                () => installApp('wechat'),
                () => enableApp('wechat'),
              );
            },
          });
          if (!outcome.ok) {
            setWechatInstallationMessage({ ok: false, message: outcome.message });
            return;
          }

          setWechatTermsAccepted(false);
          setWechatInstallationMessage({
            ok: true,
            message: installation
              ? '微信已由原生 host 重新安装并验证，AlSniper OS 桌面集成已修复且启用。'
              : '微信已由原生 host 安装并验证，桌面图标已创建。双击图标即可启动真实微信客户端。',
          });
          const requestId = ++nativeWeChatStatusRequestRef.current;
          try {
            const status = await nativeApplications!.getStatus('wechat');
            if (nativeWeChatStatusRequestRef.current === requestId) {
              setNativeWeChatStatus(status);
              setNativeWeChatStatusError(null);
            }
          } catch {
            if (nativeWeChatStatusRequestRef.current === requestId) {
              setNativeWeChatStatusError('安装已完成，但重新查询原生状态失败。');
            }
          }
        } finally {
          wechatInstallationRef.current = false;
          setWechatInstallationPending(false);
        }
      }
      else if (!installation) installApp(listing.appId);
      else if (!installation.enabled) enableApp(listing.appId);
      else requestOpenApp(listing.appId);
      return;
    }
    if (listing.agentId && agentLibrary) {
      const agent = agentLibrary.entries.find((entry) => entry.id === listing.agentId);
      if (!agent?.installed) await runAgentOperation(listing, 'Install', () => agentLibrary.install(listing.agentId!));
      else if (!agent.enabled) await runAgentOperation(listing, 'Enable', () => agentLibrary.enable(listing.agentId!));
    }
  };

  const handleDisable = async (listing: StoreListing) => {
    if (listing.appId) disableApp(listing.appId);
    else if (listing.agentId && agentLibrary) await runAgentOperation(listing, 'Disable', () => agentLibrary.disable(listing.agentId!));
  };

  const handleUninstall = async (listing: StoreListing) => {
    if (listing.appId) {
      uninstallApp(listing.appId);
      if (listing.appId === 'wechat') {
        setWechatInstallationMessage({
          ok: true,
          message: '已移除 AlSniper OS 的微信桌面集成；此操作不会卸载由腾讯提供的微信客户端。',
        });
      }
    }
    else if (listing.agentId && agentLibrary) await runAgentOperation(listing, 'Uninstall', () => agentLibrary.uninstall(listing.agentId!));
  };

  return (
    <div
      className="store-app"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr',
        containerType: 'inline-size',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: SURFACE_BG[preferences.theme],
        color: TEXT_COLOR[preferences.theme],
      }}
    >
      <header
        className="store-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 20,
          alignItems: 'center',
          padding: '22px 24px 12px',
        }}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12, letterSpacing: 1.1, textTransform: 'uppercase', color: MUTED[preferences.theme] }}>
            Agent Store
          </span>
          <strong className="store-heading" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 30, lineHeight: 1.1 }}>
            <ShoppingBag size={26} />
            Install trusted capabilities
          </strong>
          <p style={{ margin: 0, fontSize: 14, color: MUTED[preferences.theme], lineHeight: 1.6, maxWidth: 760 }}>
            Inspect identity, permissions, and execution mode before you install. Installing changes availability, not implicit grants.
          </p>
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderRadius: 999,
            background: PANEL_BG[preferences.theme],
            border: `1px solid ${BORDER[preferences.theme]}`,
            color: MUTED[preferences.theme],
            fontSize: 12.5,
          }}
        >
          <LockKeyhole size={14} />
          Install = zero business grants
        </div>
      </header>

      <div style={{ display: 'grid', gap: 16, padding: '0 24px 20px' }}>
        <section
          className="store-hero-grid"
          style={{
            display: 'grid',
            gap: 16,
            gridTemplateColumns: 'minmax(0, 1.5fr) minmax(280px, 1fr)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gap: 14,
              padding: 22,
              borderRadius: 28,
              background: `radial-gradient(circle at top right, ${accent}40, transparent 35%), ${PANEL_BG[preferences.theme]}`,
              border: `1px solid ${BORDER[preferences.theme]}`,
              boxShadow: preferences.theme === 'aurora' ? '0 24px 54px rgba(70, 86, 133, 0.14)' : '0 24px 58px rgba(0, 0, 0, 0.28)',
            }}
          >
            <span style={{ fontSize: 12, letterSpacing: 1.05, textTransform: 'uppercase', color: MUTED[preferences.theme] }}>
              Featured
            </span>
            <strong style={{ fontSize: 28, lineHeight: 1.1 }}>{selected.name}</strong>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: MUTED[preferences.theme], maxWidth: 680 }}>
              {selected.featuredNote}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {selected.capabilities.map((capability) => (
                <span
                  key={capability}
                  style={{
                    padding: '9px 12px',
                    borderRadius: 999,
                    background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.78)' : 'rgba(14,19,38,0.9)',
                    border: `1px solid ${BORDER[preferences.theme]}`,
                    fontSize: 12.5,
                    color: TEXT_COLOR[preferences.theme],
                  }}
                >
                  {capability}
                </span>
              ))}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gap: 14,
              padding: 18,
              borderRadius: 26,
              background: PANEL_BG[preferences.theme],
              border: `1px solid ${BORDER[preferences.theme]}`,
            }}
          >
            <label
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                alignItems: 'center',
                gap: 10,
                padding: '12px 14px',
                borderRadius: 18,
                border: `1px solid ${BORDER[preferences.theme]}`,
                background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.82)' : 'rgba(13,17,34,0.92)',
              }}
            >
              <Search size={17} color={MUTED[preferences.theme]} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search apps, agents, skills, or publishers"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: TEXT_COLOR[preferences.theme],
                  fontSize: 14,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {CATEGORIES.map((item) => {
                const active = category === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setCategory(item.id)}
                    style={{
                      padding: '10px 13px',
                      borderRadius: 999,
                      border: `1px solid ${active ? accent : BORDER[preferences.theme]}`,
                      background: active ? `${accent}26` : 'transparent',
                      color: TEXT_COLOR[preferences.theme],
                      fontWeight: active ? 700 : 600,
                      cursor: 'pointer',
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <div
        className="store-body-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 0.95fr)',
          gap: 18,
          padding: '0 24px 24px',
          minHeight: 0,
        }}
      >
        <section
          style={{
            minHeight: 0,
            overflowY: 'auto',
            padding: 18,
            borderRadius: 28,
            background: PANEL_BG[preferences.theme],
            border: `1px solid ${BORDER[preferences.theme]}`,
          }}
        >
          <div style={{ display: 'grid', gap: 12 }}>
            {filtered.map((listing) => {
              const installed = isInstalled(listing);
              const enabled = isEnabled(listing);
              const actionable = Boolean(listing.appId || (listing.agentId && agentLibrary));
              const active = selected.id === listing.id;
              const statusLabel = listing.id === 'wechat'
                ? installed
                  ? !nativeApplications
                    ? 'Host unavailable'
                    : nativeWeChatStatusError
                      ? 'Status unavailable'
                      : nativeWeChatStatus === null
                        ? 'Verifying…'
                        : trustedNativeWeChat
                          ? enabled ? 'Verified' : 'Disabled'
                          : 'Needs repair'
                  : !nativeApplications
                    ? 'Host required'
                    : nativeWeChatStatusError
                      ? 'Host unavailable'
                      : 'Available'
                : installed ? (enabled ? 'Enabled' : 'Disabled') : actionable ? 'Available' : 'Catalog only';

              return (
                <button
                  key={listing.id}
                  type="button"
                  onClick={() => setSelectedId(listing.id)}
                  style={{
                    display: 'grid',
                    gap: 12,
                    padding: 18,
                    textAlign: 'left',
                    borderRadius: 22,
                    border: `1px solid ${active ? accent : BORDER[preferences.theme]}`,
                    background:
                      active
                        ? preferences.theme === 'aurora'
                          ? 'rgba(255,255,255,0.92)'
                          : 'rgba(14,19,38,0.94)'
                        : preferences.theme === 'aurora'
                          ? 'rgba(255,255,255,0.62)'
                          : 'rgba(11,14,27,0.82)',
                    cursor: 'pointer',
                    boxShadow: active ? `0 0 0 4px ${accent}25` : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 14,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: `${accent}22`,
                            color: accent,
                          }}
                        >
                          {LISTING_ICONS[listing.id] ?? <ShoppingBag size={18} />}
                        </span>
                        <div style={{ display: 'grid', gap: 3 }}>
                          <strong style={{ fontSize: 16 }}>{listing.name}</strong>
                          <span style={{ fontSize: 12.5, color: MUTED[preferences.theme] }}>{listing.publisher}</span>
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: MUTED[preferences.theme] }}>{listing.tagline}</p>
                    </div>
                    <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
                      <span
                        style={{
                          padding: '7px 10px',
                          borderRadius: 999,
                          background: installed ? `${accent}24` : 'transparent',
                          border: `1px solid ${installed ? accent : BORDER[preferences.theme]}`,
                          fontSize: 12,
                          fontWeight: 700,
                          color: installed ? TEXT_COLOR[preferences.theme] : MUTED[preferences.theme],
                        }}
                      >
                        {statusLabel}
                      </span>
                      {listing.verified ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: MUTED[preferences.theme] }}>
                          <BadgeCheck size={13} />
                          {listing.id === 'wechat' ? 'AlSniper OS listing' : 'Verified'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}

            {filtered.length === 0 ? (
              <div
                style={{
                  padding: 28,
                  borderRadius: 22,
                  border: `1px dashed ${BORDER[preferences.theme]}`,
                  color: MUTED[preferences.theme],
                  fontSize: 14,
                  lineHeight: 1.7,
                }}
              >
                No listings match your current filters. Try a broader query or switch back to All.
              </div>
            ) : null}
          </div>
        </section>

        <aside
          style={{
            minHeight: 0,
            overflowY: 'auto',
            padding: 20,
            borderRadius: 28,
            background: PANEL_BG[preferences.theme],
            border: `1px solid ${BORDER[preferences.theme]}`,
          }}
        >
          <div style={{ display: 'grid', gap: 18 }}>
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 16,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: `${accent}26`,
                    color: accent,
                  }}
                >
                  {LISTING_ICONS[selected.id] ?? <ShoppingBag size={18} />}
                </span>
                <div style={{ display: 'grid', gap: 4 }}>
                  <strong style={{ fontSize: 22 }}>{selected.name}</strong>
                  <span style={{ fontSize: 13.5, color: MUTED[preferences.theme] }}>{selected.publisher}</span>
                  {selected.agentId ? (
                    <code style={{ fontSize: 12, color: MUTED[preferences.theme] }}>/agent {selected.agentId} &lt;需求&gt;</code>
                  ) : null}
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: MUTED[preferences.theme] }}>{selected.description}</p>
            </div>

            <div className="store-stats-grid" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              <div style={{ padding: 14, borderRadius: 18, background: `${accent}1a`, border: `1px solid ${BORDER[preferences.theme]}` }}>
                <div style={{ fontSize: 12, color: MUTED[preferences.theme] }}>Rating</div>
                <div style={{ marginTop: 6, fontWeight: 800, fontSize: 18 }}>{selected.rating}</div>
              </div>
              <div style={{ padding: 14, borderRadius: 18, background: `${accent}1a`, border: `1px solid ${BORDER[preferences.theme]}` }}>
                <div style={{ fontSize: 12, color: MUTED[preferences.theme] }}>Installs</div>
                <div style={{ marginTop: 6, fontWeight: 800, fontSize: 18 }}>{selected.installs}</div>
              </div>
              <div style={{ padding: 14, borderRadius: 18, background: `${accent}1a`, border: `1px solid ${BORDER[preferences.theme]}` }}>
                <div style={{ fontSize: 12, color: MUTED[preferences.theme] }}>Updated</div>
                <div style={{ marginTop: 6, fontWeight: 800, fontSize: 16 }}>{selected.updateDate}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {selected.id === 'wechat' && (!selectedInstalled || wechatNeedsRepair) ? (
                nativeApplications ? (
                  <div
                    style={{
                      display: 'grid',
                      flexBasis: '100%',
                      gap: 10,
                      padding: 14,
                      borderRadius: 16,
                      border: `1px solid ${BORDER[preferences.theme]}`,
                      color: TEXT_COLOR[preferences.theme],
                      fontSize: 13.5,
                      lineHeight: 1.55,
                    }}
                  >
                    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        checked={wechatTermsAccepted}
                        disabled={wechatInstallationPending}
                        onChange={(event) => {
                          setWechatTermsAccepted(event.target.checked);
                          setWechatInstallationMessage(null);
                        }}
                      />
                      <span>
                        {WECHAT_TERMS_NOTICE} 只有勾选后才会请求原生 host
                        {wechatNeedsRepair ? '重新安装、验证并修复本地集成。' : '安装。'}
                      </span>
                    </label>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingLeft: 24 }}>
                      <a
                        href={WECHAT_OFFICIAL_DESTINATIONS.license.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: TEXT_COLOR[preferences.theme], fontWeight: 700 }}
                      >
                        阅读腾讯官方许可协议
                      </a>
                      <a
                        href={WECHAT_OFFICIAL_DESTINATIONS.privacy.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: TEXT_COLOR[preferences.theme], fontWeight: 700 }}
                      >
                        阅读腾讯官方隐私指引
                      </a>
                    </div>
                  </div>
                ) : !selectedInstalled ? (
                  <div role="alert" style={{ flexBasis: '100%', color: '#ef4444', fontSize: 13.5, lineHeight: 1.6 }}>
                    当前浏览器未连接 AlSniper OS 原生 host，不能真实安装微信，也不会创建桌面图标。
                    请改用腾讯官网或 Microsoft Store 官方入口。
                  </div>
                ) : null
              ) : null}
              {selected.id === 'wechat' && !selectedInstalled && nativeWeChatStatusError ? (
                <div role="alert" style={{ flexBasis: '100%', color: '#ef4444', fontSize: 13.5, lineHeight: 1.6 }}>
                  已配置原生应用通道，但无法通过 AlSniper OS sidecar 查询微信状态。
                  可在同意协议后重试安装；若仍失败，请使用下方官方入口。
                </div>
              ) : null}
              {selected.id === 'wechat' && selectedInstalled && !trustedNativeWeChat ? (
                <div role="alert" style={{ flexBasis: '100%', color: '#ef4444', fontSize: 13.5, lineHeight: 1.6 }}>
                  {!nativeApplications
                    ? '原生 host 当前不可用，无法将本地桌面记录作为真实微信安装证据。本地记录已保留，请恢复 host 后重试。'
                    : nativeWeChatStatusError
                      ? `无法验证原生微信状态：${nativeWeChatStatusError}。本地记录已保留。`
                      : nativeWeChatStatus === null
                        ? '正在通过原生 host 验证微信安装状态…'
                        : '原生 host 未确认微信同时满足已安装、可启动与发布者签名已验证。本地记录已保留，但不会显示为可信安装。'}
                </div>
              ) : null}
              {selected.id === 'wechat' && (!nativeApplications || nativeWeChatStatusError || wechatNeedsRepair) ? (
                <div style={{ display: 'flex', flexBasis: '100%', gap: 10, flexWrap: 'wrap' }}>
                  <a
                    href={WECHAT_OFFICIAL_DESTINATIONS.windows.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: TEXT_COLOR[preferences.theme], fontWeight: 700 }}
                  >
                    腾讯官方 Windows 下载
                  </a>
                  <a
                    href={WECHAT_OFFICIAL_DESTINATIONS.microsoftStore.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: TEXT_COLOR[preferences.theme], fontWeight: 700 }}
                  >
                    Microsoft Store 官方入口
                  </a>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => { void handlePrimaryAction(selected); }}
                disabled={primaryDisabled}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '13px 16px',
                  borderRadius: 16,
                  border: 'none',
                  background: accent,
                  color: '#111827',
                  fontWeight: 800,
                  cursor: primaryDisabled ? 'not-allowed' : 'pointer',
                  opacity: primaryDisabled ? 0.6 : 1,
                }}
              >
                {selectedOperationPending ? <Clock3 size={16} /> : canOpen ? <ArrowRight size={16} /> : <Download size={16} />}
                {selectedOperationPending
                  ? selectedOperationLabel
                  : canOpen
                  ? 'Open'
                  : wechatRequiresNativeInstall && !nativeApplications
                    ? 'Native host required'
                  : wechatRequiresNativeInstall && !wechatTermsAccepted
                    ? 'Accept terms to install'
                  : wechatNeedsRepair && !nativeApplications
                    ? 'Native host required'
                  : wechatNeedsRepair
                    ? wechatTermsAccepted ? 'Repair & verify' : 'Accept terms to repair'
                  : selectedInstalled && !selectedEnabled
                    ? 'Enable'
                    : selected.agentId && selectedEnabled
                      ? 'Enabled'
                      : primarySupported
                        ? 'Install'
                        : 'Unavailable'}
              </button>
              {selectedInstalled && selectedEnabled && (
                !selected.appId || !APP_REGISTRY[selected.appId].protectedSystemApp
              ) ? (
                <button
                  type="button"
                  onClick={() => { void handleDisable(selected); }}
                  disabled={selectedOperationPending}
                  style={{
                    padding: '13px 16px', borderRadius: 16, border: `1px solid ${BORDER[preferences.theme]}`,
                    background: 'transparent', color: TEXT_COLOR[preferences.theme], fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Disable
                </button>
              ) : null}
              {selectedInstalled && (
                !selected.appId || !APP_REGISTRY[selected.appId].protectedSystemApp
              ) ? (
                <button
                  type="button"
                  onClick={() => { void handleUninstall(selected); }}
                  disabled={selectedOperationPending}
                  style={{
                    padding: '13px 16px', borderRadius: 16, border: `1px solid ${BORDER[preferences.theme]}`,
                    background: 'transparent', color: MUTED[preferences.theme], fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  {selected.appId === 'wechat' ? 'Remove from AlSniper OS' : 'Uninstall'}
                </button>
              ) : null}
              {isRunning ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '13px 16px',
                    borderRadius: 16,
                    border: `1px solid ${BORDER[preferences.theme]}`,
                    color: MUTED[preferences.theme],
                  }}
                >
                  <Clock3 size={15} />
                  Running
                </span>
              ) : null}
            </div>

            {agentOperationError?.listingId === selected.id ? (
              <div role="alert" style={{ color: '#ef4444', fontSize: 13.5, lineHeight: 1.5 }}>
                {agentOperationError.message}
              </div>
            ) : selectedOperationPending ? (
              <div role="status" aria-live="polite" style={{ color: MUTED[preferences.theme], fontSize: 13.5 }}>
                {selectedOperationLabel} in progress…
              </div>
            ) : null}

            {selected.id === 'wechat' && wechatInstallationMessage ? (
              <div
                role={wechatInstallationMessage.ok ? 'status' : 'alert'}
                aria-live="polite"
                style={{ color: wechatInstallationMessage.ok ? TEXT_COLOR[preferences.theme] : '#ef4444', fontSize: 13.5, lineHeight: 1.55 }}
              >
                {wechatInstallationMessage.message}
              </div>
            ) : null}

            <section style={{ display: 'grid', gap: 10 }}>
              <strong style={{ fontSize: 16 }}>Capabilities</strong>
              <div style={{ display: 'grid', gap: 8 }}>
                {selected.capabilities.map((capability) => (
                  <div
                    key={capability}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 16,
                      border: `1px solid ${BORDER[preferences.theme]}`,
                      background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.7)' : 'rgba(13,17,34,0.84)',
                      fontSize: 13.5,
                    }}
                  >
                    {capability}
                  </div>
                ))}
              </div>
            </section>

            <section style={{ display: 'grid', gap: 10 }}>
              <strong style={{ fontSize: 16 }}>Permissions</strong>
              <div style={{ display: 'grid', gap: 10 }}>
                {selected.permissions.map((permission) => (
                  <div
                    key={permission.name}
                    style={{
                      display: 'grid',
                      gap: 6,
                      padding: 14,
                      borderRadius: 18,
                      border: `1px solid ${BORDER[preferences.theme]}`,
                      background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.72)' : 'rgba(11,15,28,0.84)',
                    }}
                  >
                    <strong style={{ fontSize: 14 }}>{permission.name}</strong>
                    <span style={{ fontSize: 12.5, color: MUTED[preferences.theme] }}>Scope: {permission.scope}</span>
                    <span style={{ fontSize: 13, lineHeight: 1.55, color: MUTED[preferences.theme] }}>{permission.reason}</span>
                  </div>
                ))}
              </div>
            </section>

            <section
              style={{
                display: 'grid',
                gap: 8,
                padding: 16,
                borderRadius: 20,
                border: `1px solid ${BORDER[preferences.theme]}`,
                background: preferences.theme === 'aurora' ? 'rgba(255,255,255,0.74)' : 'rgba(13,17,34,0.84)',
              }}
            >
              <strong style={{ fontSize: 15 }}>Execution model</strong>
              <span style={{ fontSize: 13.5, lineHeight: 1.6, color: MUTED[preferences.theme] }}>{selected.execution}</span>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
