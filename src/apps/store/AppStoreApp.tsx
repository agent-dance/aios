import {
  ArrowRight,
  BadgeCheck,
  Clock3,
  Download,
  Folder,
  Gamepad2,
  LockKeyhole,
  Search,
  Settings,
  ShoppingBag,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useSystemStore } from '../../system/useSystemStore';
import type { AppId, SystemPreferences, Theme } from '../../system/types';

type StoreCategory = 'all' | 'system' | 'productivity' | 'creative' | 'games';

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
}

const INSTALLED_KEY = 'alsniper-os-store-installed';

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
];

const FALLBACK_LISTING = LISTINGS[0]!;

const LISTING_ICONS: Record<string, ReactNode> = {
  'briefing-architect': <Sparkles size={18} />,
  settings: <Settings size={18} />,
  terminal: <SquareTerminal size={18} />,
  finder: <Folder size={18} />,
  'pulse-canvas': <BadgeCheck size={18} />,
  'cosmic-vanguard': <Gamepad2 size={18} />,
};

function getInitialInstalledIds() {
  if (typeof window === 'undefined') return ['store'];
  try {
    const raw = window.localStorage.getItem(INSTALLED_KEY);
    if (!raw) return ['store'];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : ['store'];
  } catch {
    return ['store'];
  }
}

export function AppStoreApp() {
  const preferences = useSystemStore((state) => state.preferences);
  const openApp = useSystemStore((state) => state.openApp);
  const windows = useSystemStore((state) => state.windows);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StoreCategory>('all');
  const [installedIds, setInstalledIds] = useState<string[]>(getInitialInstalledIds);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(FALLBACK_LISTING.id);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INSTALLED_KEY, JSON.stringify(installedIds));
    }
  }, [installedIds]);

  useEffect(() => {
    if (!installingId) return;
    const timer = window.setTimeout(() => {
      setInstalledIds((current) => (current.includes(installingId) ? current : [...current, installingId]));
      setInstallingId(null);
    }, 850);
    return () => window.clearTimeout(timer);
  }, [installingId]);

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return LISTINGS.filter((listing) => {
      if (category !== 'all' && listing.category !== category) return false;
      if (!lower) return true;
      return [listing.name, listing.publisher, listing.tagline, listing.description, listing.capabilities.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(lower);
    });
  }, [category, query]);

  useEffect(() => {
    if (!filtered.some((listing) => listing.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? FALLBACK_LISTING.id);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((listing) => listing.id === selectedId) ?? LISTINGS.find((listing) => listing.id === selectedId) ?? FALLBACK_LISTING;
  const accent = ACCENT_COLORS[preferences.accent];

  const isInstalled = (id: string) => installedIds.includes(id);
  const canOpen = Boolean(selected.appId && isInstalled(selected.id));
  const isRunning = selected.appId ? Boolean(windows[selected.appId]?.isOpen && !windows[selected.appId]?.isMinimized) : false;

  const handlePrimaryAction = (listing: StoreListing) => {
    if (listing.appId && isInstalled(listing.id)) {
      openApp(listing.appId);
      return;
    }
    if (!isInstalled(listing.id) && !installingId) {
      setInstallingId(listing.id);
    }
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
              const installed = isInstalled(listing.id);
              const active = selected.id === listing.id;
              const statusLabel = installingId === listing.id ? 'Installing...' : installed ? 'Installed' : 'Available';

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
                          Verified
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
              <button
                type="button"
                onClick={() => handlePrimaryAction(selected)}
                disabled={Boolean(installingId && installingId !== selected.id)}
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
                  cursor: installingId && installingId !== selected.id ? 'not-allowed' : 'pointer',
                  opacity: installingId && installingId !== selected.id ? 0.6 : 1,
                }}
              >
                {canOpen ? <ArrowRight size={16} /> : <Download size={16} />}
                {installingId === selected.id ? 'Installing…' : canOpen ? 'Open' : isInstalled(selected.id) ? 'Installed' : 'Install'}
              </button>
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
