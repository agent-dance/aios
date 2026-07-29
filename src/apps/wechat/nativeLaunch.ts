import type { NativeApplicationPort } from '../../native-apps';

export interface WeChatNativeLaunchFeedback {
  readonly ok: boolean;
  readonly message: string;
}

export async function launchNativeWeChat(
  nativeApplications: NativeApplicationPort,
): Promise<WeChatNativeLaunchFeedback> {
  try {
    const result = await nativeApplications.launch('wechat');
    if (
      result.operation === 'launch' &&
      result.code === 'launched' &&
      result.installed === true &&
      result.launchable === true &&
      result.publisherVerified === true
    ) {
      return {
        ok: true,
        message: '原生 host 已确认启动由腾讯签名的微信客户端。',
      };
    }
  } catch {
    return {
      ok: false,
      message: '原生 host 启动微信失败。请在此窗口检查 host，或使用腾讯官网与 Microsoft Store 官方入口修复安装。',
    };
  }

  return {
    ok: false,
    message: '原生 host 未确认微信已启动。请在此窗口使用腾讯官网或 Microsoft Store 官方入口修复安装。',
  };
}
