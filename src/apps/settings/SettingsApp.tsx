import { Bot, Library, LockKeyhole, Monitor, MoonStar, Palette, Sparkles, Volume2, Waves, Zap } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useSystemStore } from '../../system/useSystemStore';
import type { SystemPreferences, Theme } from '../../system/types';
import './SettingsApp.css';

type SectionId = 'general' | 'appearance' | 'accessibility' | 'audio' | 'dock' | 'ai';

export interface AiPrivacyStatus {
  runtime: 'connected' | 'offline' | 'unconfigured';
  providerLabel: string;
  authenticationLabel: string;
  voiceInput: 'available' | 'unavailable' | 'permission-required';
  installedAgentCount: number;
  dataBoundary: string;
}

export interface SettingsAppProps {
  aiStatus?: AiPrivacyStatus;
  onOpenAgentLibrary?: () => void;
}

interface SectionDefinition {
  id: SectionId;
  label: string;
  description: string;
  icon: ReactNode;
}

const SECTIONS: SectionDefinition[] = [
  { id: 'general', label: 'General', description: 'Overview and active profile.', icon: <Sparkles size={18} /> },
  { id: 'appearance', label: 'Appearance', description: 'Theme and accent tone.', icon: <Palette size={18} /> },
  { id: 'accessibility', label: 'Accessibility', description: 'Comfort and motion preferences.', icon: <Waves size={18} /> },
  { id: 'audio', label: 'Audio', description: 'System sound response.', icon: <Volume2 size={18} /> },
  { id: 'dock', label: 'Dock', description: 'Magnification and glance behavior.', icon: <Zap size={18} /> },
  { id: 'ai', label: 'AI & Privacy', description: 'Runtime, Agent inventory, and data boundary.', icon: <Bot size={18} /> },
];

const ACCENT_META: Record<SystemPreferences['accent'], { label: string; color: string; glow: string }> = {
  lime: { label: 'Lime', color: '#C6F94D', glow: 'rgba(198, 249, 77, 0.4)' },
  cyan: { label: 'Cyan', color: '#64F5FF', glow: 'rgba(100, 245, 255, 0.4)' },
  amber: { label: 'Amber', color: '#FFC46B', glow: 'rgba(255, 196, 107, 0.42)' },
};

const THEME_META: Record<Theme, { label: string; description: string; icon: ReactNode }> = {
  aurora: {
    label: 'Aurora',
    description: 'Luminous desktop highlights with a bright task focus.',
    icon: <Monitor size={18} />,
  },
  midnight: {
    label: 'Midnight',
    description: 'Deeper contrast with cooler surfaces for low-light work.',
    icon: <MoonStar size={18} />,
  },
};

const SURFACE_GRADIENT: Record<Theme, string> = {
  aurora: 'linear-gradient(180deg, rgba(255,255,255,0.88), rgba(233,242,255,0.72))',
  midnight: 'linear-gradient(180deg, rgba(18,22,39,0.96), rgba(9,12,24,0.92))',
};

const TEXT_COLOR: Record<Theme, string> = {
  aurora: '#182033',
  midnight: '#F3F7FF',
};

const MUTED_TEXT: Record<Theme, string> = {
  aurora: '#55607C',
  midnight: '#9AA7C7',
};

const BORDER_COLOR: Record<Theme, string> = {
  aurora: 'rgba(76, 92, 133, 0.14)',
  midnight: 'rgba(173, 195, 255, 0.14)',
};

const PANEL_BG: Record<Theme, string> = {
  aurora: 'rgba(255,255,255,0.76)',
  midnight: 'rgba(12,16,31,0.72)',
};

const TRACK_BG: Record<Theme, string> = {
  aurora: 'rgba(138, 153, 184, 0.25)',
  midnight: 'rgba(120, 134, 166, 0.24)',
};

function formatToggle(value: boolean) {
  return value ? 'On' : 'Off';
}

function SettingCard({
  title,
  description,
  action,
  children,
  theme,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  theme: Theme;
}) {
  return (
    <section
      style={{
        display: 'grid',
        gap: 18,
        padding: 22,
        borderRadius: 24,
        background: PANEL_BG[theme],
        border: `1px solid ${BORDER_COLOR[theme]}`,
        boxShadow: theme === 'aurora' ? '0 18px 42px rgba(69, 89, 136, 0.12)' : '0 20px 44px rgba(0, 0, 0, 0.26)',
        backdropFilter: 'blur(22px)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <strong style={{ fontSize: 17, color: TEXT_COLOR[theme] }}>{title}</strong>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: MUTED_TEXT[theme] }}>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  accent,
  theme,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
  accent: SystemPreferences['accent'];
  theme: Theme;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 20,
        width: '100%',
        padding: '16px 18px',
        borderRadius: 18,
        border: `1px solid ${BORDER_COLOR[theme]}`,
        background: theme === 'aurora' ? 'rgba(255,255,255,0.68)' : 'rgba(15,18,34,0.82)',
        color: TEXT_COLOR[theme],
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'grid', gap: 4, textAlign: 'left' }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 13, color: MUTED_TEXT[theme], lineHeight: 1.5 }}>{hint}</span>
      </div>
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          width: 52,
          height: 30,
          flexShrink: 0,
          borderRadius: 999,
          background: checked ? ACCENT_META[accent].color : TRACK_BG[theme],
          boxShadow: checked ? `0 0 0 6px ${ACCENT_META[accent].glow}` : 'none',
          transition: 'background 160ms ease, box-shadow 160ms ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: checked ? 25 : 3,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 6px 12px rgba(15, 23, 42, 0.18)',
            transition: 'left 160ms ease',
          }}
        />
      </span>
    </button>
  );
}

const DEFAULT_AI_STATUS: AiPrivacyStatus = {
  runtime: 'unconfigured',
  providerLabel: 'No Agent runtime connected',
  authenticationLabel: 'Credentials are not exposed to the browser',
  voiceInput: 'unavailable',
  installedAgentCount: 0,
  dataBoundary: 'Only explicit requests and OS-authorized context may leave the browser through the sidecar.',
};

export function SettingsApp({ aiStatus = DEFAULT_AI_STATUS, onOpenAgentLibrary }: SettingsAppProps = {}) {
  const preferences = useSystemStore((state) => state.preferences);
  const updatePreferences = useSystemStore((state) => state.updatePreferences);
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');

  const summaryChips = useMemo(
    () => [
      `Theme: ${THEME_META[preferences.theme].label}`,
      `Accent: ${ACCENT_META[preferences.accent].label}`,
      `Motion: ${formatToggle(!preferences.reduceMotion)}`,
      `Sound: ${formatToggle(preferences.soundEffects)}`,
    ],
    [preferences],
  );

  const shellTheme = preferences.theme;
  const accentMeta = ACCENT_META[preferences.accent];

  const content: Record<SectionId, ReactNode> = {
    general: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Current profile"
          description="These preferences are saved locally and applied immediately across the AlSniper OS shell."
          theme={shellTheme}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 12,
            }}
          >
            {summaryChips.map((chip) => (
              <div
                key={chip}
                style={{
                  padding: '14px 16px',
                  borderRadius: 18,
                  border: `1px solid ${BORDER_COLOR[shellTheme]}`,
                  background: shellTheme === 'aurora' ? 'rgba(255,255,255,0.8)' : 'rgba(19,25,46,0.76)',
                  color: TEXT_COLOR[shellTheme],
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                {chip}
              </div>
            ))}
          </div>
        </SettingCard>
        <SettingCard
          title="System behavior"
          description="Settings here favor direct manipulation over hidden automation. Appearance and accessibility options stay explicit."
          theme={shellTheme}
        >
          <ul style={{ margin: 0, paddingLeft: 18, color: MUTED_TEXT[shellTheme], lineHeight: 1.8, fontSize: 14 }}>
            <li>Theme and accent update the shell instantly.</li>
            <li>Reduced motion disables decorative transitions while preserving feedback.</li>
            <li>Sound effects and Dock magnification remain user-controlled, not app-controlled.</li>
          </ul>
        </SettingCard>
      </div>
    ),
    appearance: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Theme"
          description="Choose the overall desktop lighting model used by windows, panels, and work surfaces."
          theme={shellTheme}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {(Object.entries(THEME_META) as [Theme, (typeof THEME_META)[Theme]][]).map(([themeKey, meta]) => {
              const active = preferences.theme === themeKey;
              return (
                <button
                  key={themeKey}
                  type="button"
                  onClick={() => updatePreferences({ theme: themeKey })}
                  aria-pressed={active}
                  style={{
                    display: 'grid',
                    gap: 12,
                    textAlign: 'left',
                    padding: 18,
                    borderRadius: 22,
                    border: `1px solid ${active ? accentMeta.color : BORDER_COLOR[shellTheme]}`,
                    background:
                      themeKey === 'aurora'
                        ? 'linear-gradient(160deg, rgba(255,255,255,0.92), rgba(221,234,255,0.84))'
                        : 'linear-gradient(160deg, rgba(23,29,54,0.96), rgba(5,10,25,0.98))',
                    color: themeKey === 'aurora' ? '#182033' : '#F4F7FF',
                    boxShadow: active ? `0 0 0 5px ${accentMeta.glow}` : 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontWeight: 700 }}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.82 }}>{meta.description}</span>
                </button>
              );
            })}
          </div>
        </SettingCard>
        <SettingCard
          title="Accent"
          description="Accent color is reserved for identity highlights, controls, and confirmation affordances."
          theme={shellTheme}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
            {(Object.entries(ACCENT_META) as [SystemPreferences['accent'], (typeof ACCENT_META)[SystemPreferences['accent']]][]).map(
              ([accent, meta]) => {
                const active = preferences.accent === accent;
                return (
                  <button
                    key={accent}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updatePreferences({ accent })}
                    style={{
                      display: 'grid',
                      gap: 12,
                      textAlign: 'left',
                      padding: 18,
                      borderRadius: 22,
                      border: `1px solid ${active ? meta.color : BORDER_COLOR[shellTheme]}`,
                      background: shellTheme === 'aurora' ? 'rgba(255,255,255,0.75)' : 'rgba(14,18,34,0.86)',
                      color: TEXT_COLOR[shellTheme],
                      cursor: 'pointer',
                      boxShadow: active ? `0 0 0 5px ${meta.glow}` : 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 12,
                        background: meta.color,
                        boxShadow: `0 10px 22px ${meta.glow}`,
                      }}
                    />
                    <span style={{ fontWeight: 700 }}>{meta.label}</span>
                  </button>
                );
              },
            )}
          </div>
        </SettingCard>
      </div>
    ),
    accessibility: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Motion"
          description="Reduce decorative movement while preserving layout continuity and keyboard feedback."
          theme={shellTheme}
        >
          <Toggle
            checked={preferences.reduceMotion}
            onChange={(checked) => updatePreferences({ reduceMotion: checked })}
            label="Reduce motion"
            hint="Turn off animated transitions across the shell for calmer interactions."
            accent={preferences.accent}
            theme={shellTheme}
          />
        </SettingCard>
        <SettingCard
          title="Reading comfort"
          description="The system keeps high-contrast structure and stable control placement regardless of motion preference."
          theme={shellTheme}
        >
          <div style={{ display: 'grid', gap: 10, color: MUTED_TEXT[shellTheme], fontSize: 14, lineHeight: 1.65 }}>
            <div>State changes remain text-visible and never rely only on animation.</div>
            <div>Current mode: {preferences.reduceMotion ? 'Reduced motion enabled.' : 'Standard motion enabled.'}</div>
          </div>
        </SettingCard>
      </div>
    ),
    audio: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Sound effects"
          description="Control whether shell interactions can use confirmation chimes and subtle auditory feedback."
          theme={shellTheme}
        >
          <Toggle
            checked={preferences.soundEffects}
            onChange={(checked) => updatePreferences({ soundEffects: checked })}
            label="Enable sound effects"
            hint="Allow click, completion, and warning sounds from the system layer."
            accent={preferences.accent}
            theme={shellTheme}
          />
        </SettingCard>
      </div>
    ),
    dock: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Dock magnification"
          description="Adjust how strongly the Dock enlarges nearby apps for glanceable targeting."
          theme={shellTheme}
        >
          <Toggle
            checked={preferences.dockMagnification}
            onChange={(checked) => updatePreferences({ dockMagnification: checked })}
            label="Magnify nearby apps"
            hint="Increase icon scale on hover to improve quick app targeting."
            accent={preferences.accent}
            theme={shellTheme}
          />
        </SettingCard>
      </div>
    ),
    ai: (
      <div style={{ display: 'grid', gap: 18 }}>
        <SettingCard
          title="Agent runtime"
          description="This is a read-only projection of the trusted sidecar connection. Runtime permissions are granted at the point of use, not through decorative switches."
          theme={shellTheme}
          action={(
            <span
              style={{
                padding: '8px 11px', borderRadius: 999, border: `1px solid ${BORDER_COLOR[shellTheme]}`,
                color: aiStatus.runtime === 'connected' ? accentMeta.color : MUTED_TEXT[shellTheme], fontSize: 12, fontWeight: 800,
              }}
            >
              {aiStatus.runtime === 'connected' ? 'Connected' : aiStatus.runtime === 'offline' ? 'Offline' : 'Not configured'}
            </span>
          )}
        >
          <div className="settings-ai-facts" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            {[
              ['Provider', aiStatus.providerLabel],
              ['Authentication', aiStatus.authenticationLabel],
              ['Voice input', aiStatus.voiceInput.replace('-', ' ')],
              ['Installed Agents', String(aiStatus.installedAgentCount)],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 15, borderRadius: 18, border: `1px solid ${BORDER_COLOR[shellTheme]}`, background: shellTheme === 'aurora' ? 'rgba(255,255,255,.72)' : 'rgba(15,18,34,.82)' }}>
                <div style={{ color: MUTED_TEXT[shellTheme], fontSize: 12 }}>{label}</div>
                <strong style={{ display: 'block', marginTop: 7, fontSize: 14 }}>{value}</strong>
              </div>
            ))}
          </div>
          {onOpenAgentLibrary ? (
            <button
              type="button"
              onClick={onOpenAgentLibrary}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9, justifySelf: 'start',
                padding: '11px 14px', borderRadius: 15, border: `1px solid ${accentMeta.color}`,
                background: `${accentMeta.color}1f`, color: TEXT_COLOR[shellTheme], fontWeight: 750, cursor: 'pointer',
              }}
            >
              <Library size={16} />
              Open Agent Library
            </button>
          ) : null}
        </SettingCard>
        <SettingCard
          title="Privacy boundary"
          description="Agent packages declare capabilities, while the OS remains the authority that approves and executes actions."
          theme={shellTheme}
          action={<LockKeyhole size={19} color={accentMeta.color} />}
        >
          <div style={{ display: 'grid', gap: 10, color: MUTED_TEXT[shellTheme], fontSize: 14, lineHeight: 1.65 }}>
            <div>{aiStatus.dataBoundary}</div>
            <div>Installed does not mean authorized: sensitive operations still require a trusted OS decision surface.</div>
            <div>Authentication secrets stay in the local sidecar profile and are never projected into app or Agent UI.</div>
          </div>
        </SettingCard>
      </div>
    ),
  };

  const sidebarButtonBase: CSSProperties = {
    display: 'grid',
    gap: 6,
    width: '100%',
    padding: '14px 16px',
    borderRadius: 18,
    textAlign: 'left',
    border: '1px solid transparent',
    background: 'transparent',
    cursor: 'pointer',
  };

  return (
    <div
      className="settings-app"
      style={{
        display: 'grid',
        gridTemplateColumns: '260px minmax(0, 1fr)',
        containerType: 'inline-size',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: SURFACE_GRADIENT[shellTheme],
        color: TEXT_COLOR[shellTheme],
      }}
    >
      <aside
        className="settings-sidebar"
        style={{
          padding: 24,
          borderRight: `1px solid ${BORDER_COLOR[shellTheme]}`,
          background: shellTheme === 'aurora' ? 'rgba(244,248,255,0.74)' : 'rgba(8,11,24,0.64)',
          backdropFilter: 'blur(22px)',
          overflowY: 'auto',
        }}
      >
        <div className="settings-sidebar-header" style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
          <span style={{ fontSize: 12, letterSpacing: 1.1, textTransform: 'uppercase', color: MUTED_TEXT[shellTheme] }}>
            System Settings
          </span>
          <strong style={{ fontSize: 28, lineHeight: 1.1 }}>Preferences</strong>
          <p style={{ margin: 0, color: MUTED_TEXT[shellTheme], fontSize: 14, lineHeight: 1.6 }}>
            Shape how the shell looks, sounds, and moves without handing those controls to apps.
          </p>
        </div>
        <nav className="settings-nav" style={{ display: 'grid', gap: 8 }}>
          {SECTIONS.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                className="settings-nav-item"
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                style={{
                  ...sidebarButtonBase,
                  background: active ? (shellTheme === 'aurora' ? 'rgba(255,255,255,0.82)' : 'rgba(16,20,38,0.9)') : 'transparent',
                  borderColor: active ? accentMeta.color : 'transparent',
                  boxShadow: active ? `0 0 0 4px ${accentMeta.glow}` : 'none',
                  color: TEXT_COLOR[shellTheme],
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontWeight: 700 }}>
                  {section.icon}
                  {section.label}
                </span>
                <span style={{ fontSize: 12.5, lineHeight: 1.45, color: MUTED_TEXT[shellTheme] }}>{section.description}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="settings-main" style={{ padding: 26, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gap: 20, maxWidth: 920, margin: '0 auto' }}>
          <section
            style={{
              padding: 24,
              borderRadius: 28,
              background: shellTheme === 'aurora' ? 'rgba(255,255,255,0.58)' : 'rgba(12,16,31,0.78)',
              border: `1px solid ${BORDER_COLOR[shellTheme]}`,
              boxShadow: shellTheme === 'aurora' ? '0 26px 58px rgba(68, 85, 132, 0.16)' : '0 28px 64px rgba(0, 0, 0, 0.28)',
            }}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, color: MUTED_TEXT[shellTheme] }}>
                {SECTIONS.find((section) => section.id === activeSection)?.label}
              </span>
              <strong style={{ fontSize: 30, lineHeight: 1.08 }}>
                {activeSection === 'appearance' && 'Tune visual identity'}
                {activeSection === 'general' && 'Review active shell profile'}
                {activeSection === 'accessibility' && 'Keep motion deliberate'}
                {activeSection === 'audio' && 'Adjust auditory feedback'}
                {activeSection === 'dock' && 'Refine Dock behavior'}
                {activeSection === 'ai' && 'Inspect AI trust boundaries'}
              </strong>
              <p style={{ margin: 0, color: MUTED_TEXT[shellTheme], fontSize: 14, lineHeight: 1.65 }}>
                Accent highlight: <span style={{ color: accentMeta.color, fontWeight: 700 }}>{accentMeta.label}</span>
              </p>
            </div>
          </section>
          {content[activeSection]}
        </div>
      </main>
    </div>
  );
}
