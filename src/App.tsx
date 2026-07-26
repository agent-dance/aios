import { lazy, Suspense } from 'react';
import { CalculatorApp } from './apps/calculator';
import { FinderApp } from './apps/finder';
import { SettingsApp } from './apps/settings';
import { AppStoreApp } from './apps/store';
import { TerminalApp } from './apps/terminal';
import { DesktopShell, type AppContentMap } from './shell';
import { useSystemStore } from './system/useSystemStore';

const SpaceGameApp = lazy(() =>
  import('./apps/space-game').then((module) => ({ default: module.SpaceGameApp })),
);
const DoudizhuApp = lazy(() =>
  import('./apps/doudizhu').then((module) => ({ default: module.DoudizhuApp })),
);

function AppLoading({ label }: { label: string }) {
  return (
    <div className="app-loading" role="status">
      <span className="app-loading__mark" aria-hidden="true" />
      <span>Preparing {label}</span>
    </div>
  );
}

export default function App() {
  const preferences = useSystemStore((state) => state.preferences);

  const appContents: AppContentMap = {
    finder: ({ isActive }) => <FinderApp isActive={isActive} />,
    calculator: ({ isActive }) => <CalculatorApp isActive={isActive} />,
    settings: <SettingsApp />,
    terminal: <TerminalApp />,
    store: <AppStoreApp />,
    'space-game': ({ isActive }) => (
      <Suspense fallback={<AppLoading label="Cosmic Vanguard" />}>
        <SpaceGameApp isActive={isActive} />
      </Suspense>
    ),
    doudizhu: ({ isActive }) => (
      <Suspense fallback={<AppLoading label="斗地主" />}>
        <DoudizhuApp isActive={isActive} />
      </Suspense>
    ),
  };

  return (
    <main
      className="alsniper-os"
      data-theme={preferences.theme}
      data-accent={preferences.accent}
      data-reduce-motion={preferences.reduceMotion ? 'true' : 'false'}
    >
      <DesktopShell
        className="desktop-shell"
        appContents={appContents}
        brand={
          <span className="brand-lockup">
            <span className="brand-lockup__glyph" aria-hidden="true">A</span>
            <span>AlSniper</span>
          </span>
        }
      >
        <div className="wallpaper-art" aria-hidden="true">
          <div className="wallpaper-art__orbit wallpaper-art__orbit--one" />
          <div className="wallpaper-art__orbit wallpaper-art__orbit--two" />
          <div className="wallpaper-art__core">
            <span>ALS</span>
            <small>ORBITAL SYSTEM</small>
          </div>
          <div className="wallpaper-art__grid" />
        </div>
        <div className="desktop-watermark" aria-hidden="true">
          <span>ALSNIPER OS</span>
          <small>Build 27.7 · Secure Channel</small>
        </div>
      </DesktopShell>
    </main>
  );
}
