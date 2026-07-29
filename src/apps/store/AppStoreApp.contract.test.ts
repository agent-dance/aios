import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./AppStoreApp.tsx', import.meta.url), 'utf8');

describe('Agent Store asynchronous operation boundary', () => {
  it('serializes Agent mutations and surfaces failures instead of leaking rejections', () => {
    expect(SOURCE).toContain('if (agentOperationRef.current !== null) return;');
    expect(SOURCE).toContain('await operation();');
    expect(SOURCE).toContain('setAgentOperationError({');
    expect(SOURCE).toContain('role="alert"');
    expect(SOURCE).not.toMatch(/void\s+agentLibrary\.(install|enable|disable|uninstall)/);
  });

  it('installs WeChat as a local embedded-web desktop integration', () => {
    expect(SOURCE).toContain("id: 'wechat'");
    expect(SOURCE).toContain("appId: 'wechat'");
    expect(SOURCE).toContain("publisher: 'AlSniper OS'");
    expect(SOURCE).toContain('runLocalApplicationPrimaryAction(listing.appId, installation, {');
    expect(SOURCE).toContain('install: installApp');
    expect(SOURCE).toContain('enable: enableApp');
    expect(SOURCE).toContain('open: requestOpenApp');
    expect(SOURCE).toContain('https://wx.qq.com');
    expect(SOURCE).toContain('隔离的桌面 WebContentsView');
    expect(SOURCE).toContain('账号登录资格和服务可用性由腾讯控制');
    expect(SOURCE).toContain('本集成仅支持 AlSniper OS 桌面版');
    expect(SOURCE).toContain('AlSniper OS listing');
    expect(SOURCE).toContain('color="#07c160"');
  });

  it('does not retain native-install, terms, sidecar-status, or repair behavior', () => {
    expect(SOURCE).not.toContain('installWeChatTransaction');
    expect(SOURCE).not.toContain('commitWeChatProjection');
    expect(SOURCE).not.toContain('nativeApplications.getStatus');
    expect(SOURCE).not.toContain('nativeApplications.install');
    expect(SOURCE).not.toContain('NativeApplicationPort');
    expect(SOURCE).not.toContain('nativeApplications?:');
    expect(SOURCE).not.toContain('wechatTermsAccepted');
    expect(SOURCE).not.toContain('trustedNativeWeChat');
    expect(SOURCE).not.toContain('wechatNeedsRepair');
    expect(SOURCE).not.toContain('Repair & verify');
    expect(SOURCE).not.toContain('sidecar');
  });
});
