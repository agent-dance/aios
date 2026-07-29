import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { APP_REGISTRY } from '../system/appRegistry';
import type { AppInstallation } from '../system/types';
import { DesktopIcons } from './DesktopShell';

const finderInstallation: AppInstallation = {
  appId: 'finder',
  version: APP_REGISTRY.finder.version,
  enabled: true,
};

const wechatInstallation: AppInstallation = {
  appId: 'wechat',
  version: APP_REGISTRY.wechat.version,
  enabled: true,
};

function renderDesktop(
  appInstallations: Parameters<typeof DesktopIcons>[0]['appInstallations'],
  desktopIcons?: Parameters<typeof DesktopIcons>[0]['desktopIcons'],
) {
  return renderToStaticMarkup(
    <DesktopIcons
      appInstallations={appInstallations}
      desktopIcons={desktopIcons}
      selectedAppId={null}
      onSelect={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
}

describe('DesktopShell installed-app projection', () => {
  it('renders every enabled installation in the adaptive desktop region', () => {
    const markup = renderDesktop({ finder: finderInstallation, wechat: wechatInstallation });

    expect(markup).toContain('data-desktop-icons="true"');
    expect(markup).toContain('data-layout="adaptive"');
    expect(markup.match(/data-desktop-icon="true"/g)).toHaveLength(2);
    expect(markup).toContain('data-app-id="finder"');
    expect(markup).toContain('data-app-id="wechat"');
    expect(markup).toContain('bottom:126px');
    expect(markup).toContain('overflow:auto');
  });

  it('removes disabled and uninstalled applications from the rendered desktop', () => {
    expect(renderDesktop({
      finder: finderInstallation,
      wechat: { ...wechatInstallation, enabled: false },
    })).not.toContain('data-app-id="wechat"');
    expect(renderDesktop({ finder: finderInstallation })).not.toContain('data-app-id="wechat"');
  });

  it('preserves custom desktop icon order, labels, and absolute positioning', () => {
    const markup = renderDesktop(
      { finder: finderInstallation, wechat: wechatInstallation },
      [
        { appId: 'wechat', label: 'Chat', position: { x: 212, y: 144 } },
        { appId: 'finder', position: { x: 12, y: 88 } },
      ],
    );

    expect(markup).toContain('data-layout="custom"');
    expect(markup.indexOf('data-app-id="wechat"')).toBeLessThan(markup.indexOf('data-app-id="finder"'));
    expect(markup).toContain('left:212px;top:144px');
    expect(markup).toContain('>Chat</span>');
  });

  it('treats an explicit empty custom desktop as custom rather than falling back', () => {
    const markup = renderDesktop({ finder: finderInstallation, wechat: wechatInstallation }, []);

    expect(markup).toContain('data-layout="custom"');
    expect(markup).not.toContain('data-desktop-icon="true"');
  });
});
