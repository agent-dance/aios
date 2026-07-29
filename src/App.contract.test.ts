import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const MAIN_SOURCE = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

describe('OS game runtime composition', () => {
  it('keeps every mounted game simulation alive independently of foreground focus', () => {
    expect(APP_SOURCE).toMatch(
      /'space-game': \(\{ isActive, window \}\)[\s\S]*?<SpaceGameApp[\s\S]*?isActive=\{isActive\}[\s\S]*?simulationActive=\{window\.isOpen\}/,
    );
    expect(APP_SOURCE).toMatch(
      /doudizhu: \(\{ isActive, window \}\)[\s\S]*?<DoudizhuApp[\s\S]*?isActive=\{isActive\}[\s\S]*?simulationActive=\{window\.isOpen\}/,
    );
  });

  it('offers a development-only first-render game canvas for the official harness', () => {
    expect(MAIN_SOURCE).toContain('if (import.meta.env.DEV)');
    expect(MAIN_SOURCE).toContain("get('automationGame')");
    expect(MAIN_SOURCE).toContain("openApp('space-game')");
  });
});

describe('embedded WeChat composition', () => {
  it('opens the internal app surface and hides the native view behind OS overlays', () => {
    expect(APP_SOURCE).not.toContain('createApplicationLaunchRouter');
    expect(APP_SOURCE).not.toContain('nativeApplications={agentRuntime.nativeApplications}');
    expect(APP_SOURCE).toContain('onOpenApp={handleOpenApp}');
    expect(APP_SOURCE).toContain('wechat: ({ isActive, window }) =>');
    expect(APP_SOURCE).toContain('const [assistantOpen, setAssistantOpen] = useState(false);');
    expect(APP_SOURCE).toContain('isActive={isWeChatSurfaceActive(isActive, {');
    expect(APP_SOURCE).toContain('assistantOpen,');
    expect(APP_SOURCE).toContain('onOpenChange={setAssistantOpen}');
    expect(APP_SOURCE).toContain('isMinimized={!window.isOpen || window.isMinimized}');
    expect(APP_SOURCE).toContain('openApp(appId);');
  });
});
