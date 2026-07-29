import type { ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_REGISTRY, DOCK_APPS } from '../system/appRegistry';
import type { AppId, AppInstallation, SystemStatusModel, WindowState } from '../system/types';
import { useSystemStore } from '../system/useSystemStore';
import { AppWindow } from './AppWindow';
import { ClockPanel } from './ClockPanel';
import { ControlCenter } from './ControlCenter';
import { DesktopIcon } from './DesktopIcon';
import { getDefaultDesktopIcons } from './desktopProjection';
import { Dock } from './Dock';
import { MenuBar } from './MenuBar';
import type {
  AppContentMap,
  AppContentRenderContext,
  DesktopIconDefinition,
  FocusSession,
  ShellSurfaceProps,
  ShellViewport,
} from './shellTypes';
import { useDismissibleLayer } from './useDismissibleLayer';

export interface DesktopShellProps extends ShellSurfaceProps {
  appContents?: AppContentMap;
  children?: ReactNode;
  assistant?: ReactNode;
  brand?: ReactNode;
  desktopIcons?: DesktopIconDefinition[];
  onOpenApp?: (appId: AppId) => void;
}

export interface DesktopIconsProps {
  appInstallations: Partial<Record<AppId, AppInstallation>>;
  desktopIcons?: DesktopIconDefinition[];
  selectedAppId: AppId | null;
  onSelect: (appId: AppId | null) => void;
  onOpen: (appId: AppId) => void;
}

const MENU_BAR_HEIGHT = 68;
// Reserve the complete dock hit area plus a small visual gutter so clamped
// windows never sit underneath the launcher on short viewports.
const DOCK_HEIGHT = 126;

const DEFAULT_FOCUS: FocusSession = {
  active: false,
  label: 'Deep Work',
  durationMinutes: 50,
  startedAt: null,
};

export function DesktopIcons({
  appInstallations,
  desktopIcons,
  selectedAppId,
  onSelect,
  onOpen,
}: DesktopIconsProps) {
  const customDesktopLayout = desktopIcons !== undefined;
  const visibleDesktopIcons = useMemo<DesktopIconDefinition[]>(
    () => (desktopIcons ?? getDefaultDesktopIcons(appInstallations))
      .filter((icon) => appInstallations[icon.appId]?.enabled === true),
    [appInstallations, desktopIcons],
  );

  return (
    <div
      role="presentation"
      data-desktop-icons="true"
      data-layout={customDesktopLayout ? 'custom' : 'adaptive'}
      className={customDesktopLayout ? 'alsniper-desktop-icons--custom' : 'alsniper-desktop-icons--adaptive'}
      onPointerDown={() => onSelect(null)}
      style={customDesktopLayout
        ? { position: 'absolute', inset: 0, zIndex: 1 }
        : {
            position: 'absolute',
            top: MENU_BAR_HEIGHT + 8,
            right: 16,
            bottom: DOCK_HEIGHT,
            left: 16,
            zIndex: 1,
            overflow: 'auto',
          }}
    >
      {visibleDesktopIcons.map((icon) => {
        const app = APP_REGISTRY[icon.appId];
        const position = icon.position ?? { x: 28, y: 92 };
        return (
          <DesktopIcon
            key={icon.appId}
            app={app}
            icon={icon}
            selected={selectedAppId === icon.appId}
            onSelect={() => onSelect(icon.appId)}
            onOpen={() => {
              onSelect(icon.appId);
              onOpen(icon.appId);
            }}
            style={customDesktopLayout ? { position: 'absolute', left: position.x, top: position.y } : undefined}
            className="alsniper-desktop-icon"
          />
        );
      })}
    </div>
  );
}

interface ClockSurfacesProps {
  brand?: ReactNode;
  activeAppId: AppId | null;
  activeAppName?: string;
  status: SystemStatusModel;
  controlCenterOpen: boolean;
  clockOpen: boolean;
  onToggleControlCenter: () => void;
  onToggleClock: () => void;
  controlCenterButtonRef: RefObject<HTMLButtonElement | null>;
  clockButtonRef: RefObject<HTMLButtonElement | null>;
  clockPanelRef: RefObject<HTMLDivElement | null>;
}

function ClockSurfaces({
  brand,
  activeAppId,
  activeAppName,
  status,
  controlCenterOpen,
  clockOpen,
  onToggleControlCenter,
  onToggleClock,
  controlCenterButtonRef,
  clockButtonRef,
  clockPanelRef,
}: ClockSurfacesProps) {
  const [now, setNow] = useState(() => new Date());
  const [focus, setFocus] = useState<FocusSession>(DEFAULT_FOCUS);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!focus.active || focus.startedAt === null) return;
    if (now.getTime() - focus.startedAt >= focus.durationMinutes * 60_000) {
      setFocus((current) => ({ ...current, active: false, startedAt: null }));
    }
  }, [focus.active, focus.durationMinutes, focus.startedAt, now]);

  return (
    <>
      <MenuBar
        brand={brand}
        activeAppId={activeAppId}
        activeAppName={activeAppName}
        now={now}
        status={status}
        controlCenterOpen={controlCenterOpen}
        clockOpen={clockOpen}
        onToggleControlCenter={onToggleControlCenter}
        onToggleClock={onToggleClock}
        controlCenterButtonRef={controlCenterButtonRef}
        clockButtonRef={clockButtonRef}
      />

      <div style={{ position: 'absolute', top: 64, right: 12, zIndex: 130 }}>
        <div ref={clockPanelRef}>
          <ClockPanel
            open={clockOpen}
            now={now}
            focus={focus}
            onToggleFocus={() =>
              setFocus((current) => ({
                ...current,
                active: !current.active,
                startedAt: current.active ? null : Date.now(),
              }))
            }
            onResetFocus={() => setFocus((current) => ({ ...current, active: false, startedAt: null }))}
          />
        </div>
      </div>
    </>
  );
}

export function DesktopShell({ appContents = {}, children, assistant, brand, desktopIcons, onOpenApp, className, style }: DesktopShellProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const controlCenterRef = useRef<HTMLDivElement | null>(null);
  const controlCenterButtonRef = useRef<HTMLButtonElement | null>(null);
  const clockPanelRef = useRef<HTMLDivElement | null>(null);
  const clockButtonRef = useRef<HTMLButtonElement | null>(null);

  const windows = useSystemStore((state) => state.windows);
  const activeAppId = useSystemStore((state) => state.activeAppId);
  const controlCenterOpen = useSystemStore((state) => state.controlCenterOpen);
  const clockOpen = useSystemStore((state) => state.clockOpen);
  const preferences = useSystemStore((state) => state.preferences);
  const appInstallations = useSystemStore((state) => state.appInstallations);
  const status = useSystemStore((state) => state.systemStatus);
  const openApp = useSystemStore((state) => state.openApp);
  const closeApp = useSystemStore((state) => state.closeApp);
  const minimizeApp = useSystemStore((state) => state.minimizeApp);
  const focusApp = useSystemStore((state) => state.focusApp);
  const toggleMaximize = useSystemStore((state) => state.toggleMaximize);
  const moveWindow = useSystemStore((state) => state.moveWindow);
  const resizeWindow = useSystemStore((state) => state.resizeWindow);
  const setControlCenterOpen = useSystemStore((state) => state.setControlCenterOpen);
  const setClockOpen = useSystemStore((state) => state.setClockOpen);
  const updatePreferences = useSystemStore((state) => state.updatePreferences);
  const updateSystemStatus = useSystemStore((state) => state.updateSystemStatus);
  const requestOpenApp = onOpenApp ?? openApp;

  const [selectedDesktopAppId, setSelectedDesktopAppId] = useState<AppId | null>(null);
  const [viewport, setViewport] = useState<ShellViewport>({
    width: 1280,
    height: 720,
    topInset: MENU_BAR_HEIGHT,
    bottomInset: DOCK_HEIGHT,
  });

  useEffect(() => {
    const node = shellRef.current;
    if (!node) {
      return;
    }

    const updateViewport = () => {
      const rect = node.getBoundingClientRect();
      setViewport({
        width: rect.width,
        height: rect.height,
        topInset: MENU_BAR_HEIGHT,
        bottomInset: DOCK_HEIGHT,
      });
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useDismissibleLayer({
    open: controlCenterOpen,
    onDismiss: () => setControlCenterOpen(false),
    refs: [controlCenterRef, controlCenterButtonRef],
    restoreFocusRef: controlCenterButtonRef,
  });

  useDismissibleLayer({
    open: clockOpen,
    onDismiss: () => setClockOpen(false),
    refs: [clockPanelRef, clockButtonRef],
    restoreFocusRef: clockButtonRef,
  });

  // Keep minimized applications mounted so their in-memory session survives;
  // visibility and focus are separate from the application lifecycle.
  const mountedWindowStates = useMemo(
    () =>
      Object.values(windows)
        .filter((entry): entry is WindowState => Boolean(entry?.isOpen))
        .sort((left, right) => left.zIndex - right.zIndex),
    [windows],
  );

  const visibleWindowStates = useMemo(
    () => mountedWindowStates.filter((entry) => !entry.isMinimized),
    [mountedWindowStates],
  );

  const openAppIds = useMemo(
    () =>
      Object.entries(windows)
        .filter(([, entry]) => entry?.isOpen)
        .map(([appId]) => appId as AppId),
    [windows],
  );

  const effectiveActiveAppId = activeAppId ?? visibleWindowStates.at(-1)?.appId ?? null;

  const activeAppName = effectiveActiveAppId ? APP_REGISTRY[effectiveActiveAppId].name : undefined;

  const themeGradient =
    preferences.theme === 'midnight'
      ? 'radial-gradient(circle at top left, rgba(93,128,255,0.34), transparent 34%), radial-gradient(circle at top right, rgba(63, 214, 196, 0.22), transparent 26%), linear-gradient(180deg, #09111e 0%, #091626 42%, #071019 100%)'
      : 'radial-gradient(circle at top left, rgba(109, 221, 196, 0.38), transparent 32%), radial-gradient(circle at top right, rgba(119,165,255,0.28), transparent 30%), linear-gradient(180deg, #123850 0%, #0b2035 38%, #08131f 100%)';

  const resolveAppContent = (appId: AppId, windowState: WindowState): ReactNode => {
    const app = APP_REGISTRY[appId];
    const content = appContents[appId];
    if (!content) {
      return (
        <div
          style={{
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            padding: 28,
            color: '#f7fbff',
            textAlign: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{app.name}</div>
            <div style={{ marginTop: 8, opacity: 0.72 }}>
              No app content was provided for <code>{appId}</code>.
            </div>
          </div>
        </div>
      );
    }

    if (typeof content === 'function') {
      const context: AppContentRenderContext = {
        appId,
        app,
        window: windowState,
        isActive: effectiveActiveAppId === appId,
        close: () => closeApp(appId),
        minimize: () => minimizeApp(appId),
        maximize: () => toggleMaximize(appId),
        focus: () => focusApp(appId),
      };
      return content(context);
    }

    return content;
  };

  return (
    <div
      ref={shellRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        minHeight: '100vh',
        overflow: 'hidden',
        background: themeGradient,
        color: '#f7fbff',
        fontFamily:
          '"Segoe UI Variable Display", "Segoe UI", "SF Pro Display", ui-sans-serif, system-ui, sans-serif',
        ...style,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(125deg, rgba(255,255,255,0.08) 0%, transparent 24%), radial-gradient(circle at 20% 20%, rgba(255,255,255,0.08), transparent 16%), radial-gradient(circle at 80% 12%, rgba(111,165,255,0.18), transparent 18%)',
        }}
      />

      {children}

      <ClockSurfaces
        brand={brand}
        activeAppId={effectiveActiveAppId}
        activeAppName={activeAppName}
        status={status}
        controlCenterOpen={controlCenterOpen}
        clockOpen={clockOpen}
        onToggleControlCenter={() => setControlCenterOpen(!controlCenterOpen)}
        onToggleClock={() => setClockOpen(!clockOpen)}
        controlCenterButtonRef={controlCenterButtonRef}
        clockButtonRef={clockButtonRef}
        clockPanelRef={clockPanelRef}
      />

      <DesktopIcons
        appInstallations={appInstallations}
        desktopIcons={desktopIcons}
        selectedAppId={selectedDesktopAppId}
        onSelect={setSelectedDesktopAppId}
        onOpen={requestOpenApp}
      />

      {mountedWindowStates.map((windowState) => {
        const app = APP_REGISTRY[windowState.appId];
        return (
          <AppWindow
            key={windowState.appId}
            app={app}
            window={windowState}
            active={effectiveActiveAppId === windowState.appId}
            viewport={viewport}
            onFocus={() => focusApp(windowState.appId)}
            onClose={() => closeApp(windowState.appId)}
            onMinimize={() => minimizeApp(windowState.appId)}
            onToggleMaximize={() => toggleMaximize(windowState.appId)}
            onMove={(x, y) => moveWindow(windowState.appId, x, y)}
            onResize={(width, height) => resizeWindow(windowState.appId, width, height)}
            style={windowState.isMinimized ? { display: 'none' } : undefined}
          >
            {resolveAppContent(windowState.appId, windowState)}
          </AppWindow>
        );
      })}

      {assistant}

      <div style={{ position: 'absolute', top: 64, right: 12, zIndex: 130 }}>
        <div ref={controlCenterRef}>
          <ControlCenter
            open={controlCenterOpen}
            preferences={preferences}
            status={status}
            onStatusChange={(patch) => { updateSystemStatus(patch); }}
            onPreferencesChange={updatePreferences}
          />
        </div>
      </div>

      <Dock
        apps={DOCK_APPS.filter((appId) => appInstallations[appId]?.enabled === true).map((appId) => APP_REGISTRY[appId])}
        activeAppId={effectiveActiveAppId}
        openAppIds={openAppIds}
        magnification={preferences.dockMagnification}
        onOpenApp={requestOpenApp}
      />
    </div>
  );
}
