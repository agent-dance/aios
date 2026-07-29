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

  it('requires explicit Tencent terms acceptance and a verified native install transaction', () => {
    expect(SOURCE).toContain("id: 'wechat'");
    expect(SOURCE).toContain("appId: 'wechat'");
    expect(SOURCE).toContain("publisher: 'AlSniper OS'");
    expect(SOURCE).toContain('installWeChatTransaction({');
    expect(SOURCE).toContain('acceptedTerms: wechatTermsAccepted');
    expect(SOURCE).toContain('commitLocalInstallation: () => {');
    expect(SOURCE).toContain('return commitWeChatProjection(');
    expect(SOURCE).toContain('type="checkbox"');
    expect(SOURCE).toContain('WECHAT_OFFICIAL_DESTINATIONS.license.url');
    expect(SOURCE).toContain('WECHAT_OFFICIAL_DESTINATIONS.privacy.url');
    expect(SOURCE).toContain('阅读腾讯官方许可协议');
    expect(SOURCE).toContain('阅读腾讯官方隐私指引');
    expect(SOURCE).toContain('不能真实安装微信，也不会创建桌面图标');
    expect(SOURCE).toContain('Microsoft Store 官方入口');
    expect(SOURCE).toContain('AlSniper OS listing');
    expect(SOURCE).toContain('requestOpenApp(listing.appId)');
    expect(SOURCE).toContain('Remove from AlSniper OS');
    expect(SOURCE).toContain('color="#07c160"');
  });

  it('does not trust persisted WeChat projection without native status verification', () => {
    expect(SOURCE).toContain("nativeApplications.getStatus('wechat'");
    expect(SOURCE).toContain("status?.state === 'installed'");
    expect(SOURCE).toContain('status.publisherVerified');
    expect(SOURCE).toContain("const wechatNeedsRepair = selected.id === 'wechat' && Boolean(selectedInstallation) && !trustedNativeWeChat;");
    expect(SOURCE).toContain("? wechatTermsAccepted ? 'Repair & verify' : 'Accept terms to repair'");
    expect(SOURCE).toContain('无法通过 AlSniper OS sidecar 查询微信状态');
    expect(SOURCE).toContain('!nativeApplications || nativeWeChatStatusError || wechatNeedsRepair');
  });
});
