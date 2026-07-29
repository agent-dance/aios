import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./WeChatApp.tsx', import.meta.url), 'utf8');

describe('WeChat launcher trust boundary', () => {
  it('routes every external action through the allowlisted navigation service', () => {
    expect(SOURCE).toContain('openOfficialWeChatDestination(destinationId, openExternalWindow)');
    expect(SOURCE).toContain('requestDesktopWeChatLaunch(launchDesktopProtocol)');
    expect(SOURCE).toContain('await launchNativeWeChat(nativeApplications)');
    expect(SOURCE).toContain('尝试 xweixin:// 启动（尽力而为）');
    expect(SOURCE).not.toContain('<iframe');
    expect(SOURCE).not.toContain('dangerouslySetInnerHTML');
  });

  it('discloses official-service ownership and Tencent account policy constraints', () => {
    expect(SOURCE).toContain('不会仿造微信登录或聊天界面');
    expect(SOURCE).toContain('微信客户端本体、登录和消息服务由腾讯提供');
    expect(SOURCE).toContain('可用性和账号资格受腾讯策略');
    expect(SOURCE).toContain('登录、扫码、风控与消息数据均由微信官方服务处理');
    expect(SOURCE).toContain('AlSniper OS 已验证入口范围');
    expect(SOURCE).toContain('腾讯官方入口');
    expect(SOURCE).toContain('Microsoft 官方入口');
  });
});
