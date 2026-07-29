import type { NativeApplicationPort } from '../../native-apps';
import type { AppId } from '../../system/types';
import { launchNativeWeChat, type WeChatNativeLaunchFeedback } from './nativeLaunch';

export interface ApplicationLaunchDependencies {
  readonly nativeApplications?: NativeApplicationPort;
  readonly isLocallyLaunchable: (appId: AppId) => boolean;
  readonly openFallback: (appId: AppId) => void;
  readonly onWeChatLaunchFeedback: (feedback: WeChatNativeLaunchFeedback) => void;
}

export type ApplicationLaunchRouter = (appId: AppId) => Promise<void>;

/**
 * Routes installed shell applications while preserving a strict truth boundary
 * for WeChat: successful native launch never opens the fallback window, while
 * unavailable or failed native launch leaves an actionable fallback visible.
 */
export async function routeApplicationLaunch(
  appId: AppId,
  dependencies: ApplicationLaunchDependencies,
): Promise<void> {
  if (!dependencies.isLocallyLaunchable(appId)) return;

  if (appId !== 'wechat') {
    dependencies.openFallback(appId);
    return;
  }

  if (!dependencies.nativeApplications) {
    const feedback: WeChatNativeLaunchFeedback = {
      ok: false,
      message: '当前未连接 AlSniper OS 原生 host，无法确认微信真实启动。请使用此窗口中的腾讯官网或 Microsoft Store 官方入口。',
    };
    dependencies.onWeChatLaunchFeedback(feedback);
    dependencies.openFallback('wechat');
    return;
  }

  const feedback = await launchNativeWeChat(dependencies.nativeApplications);
  dependencies.onWeChatLaunchFeedback(feedback);
  if (!feedback.ok) dependencies.openFallback('wechat');
}

export function createApplicationLaunchRouter(
  dependencies: ApplicationLaunchDependencies,
): ApplicationLaunchRouter {
  let pendingWeChatLaunch: Promise<void> | null = null;

  return (appId) => {
    if (appId !== 'wechat') return routeApplicationLaunch(appId, dependencies);
    if (pendingWeChatLaunch) return pendingWeChatLaunch;

    pendingWeChatLaunch = routeApplicationLaunch(appId, dependencies);
    void pendingWeChatLaunch.then(
      () => { pendingWeChatLaunch = null; },
      () => { pendingWeChatLaunch = null; },
    );
    return pendingWeChatLaunch;
  };
}
