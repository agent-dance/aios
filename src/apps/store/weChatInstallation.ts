import type { AppInstallation, AppInstallationResult } from '../../system/types';
import type { NativeApplicationInstallResult, NativeApplicationPort } from '../../native-apps';

export const WECHAT_TERMS_NOTICE =
  '我已通过下方腾讯官方链接阅读并同意《微信软件许可及服务协议》和《微信隐私保护指引》。';

export type WeChatInstallationFailureCode =
  | 'terms-not-accepted'
  | 'native-host-unavailable'
  | 'native-install-rejected'
  | 'local-commit-rejected';

export interface WeChatInstallationSuccess {
  readonly ok: true;
  readonly nativeResult: NativeApplicationInstallResult;
  readonly localResult: AppInstallationResult;
}

export interface WeChatInstallationFailure {
  readonly ok: false;
  readonly code: WeChatInstallationFailureCode;
  readonly message: string;
}

export type WeChatInstallationOutcome = WeChatInstallationSuccess | WeChatInstallationFailure;

export interface WeChatInstallationRequest {
  readonly nativeApplications?: NativeApplicationPort;
  readonly acceptedTerms: boolean;
  readonly commitLocalInstallation: () => AppInstallationResult;
}

export function commitWeChatProjection(
  currentInstallation: AppInstallation | undefined,
  installLocalApplication: () => AppInstallationResult,
  enableLocalApplication: () => AppInstallationResult,
): AppInstallationResult {
  if (!currentInstallation) return installLocalApplication();
  if (!currentInstallation.enabled) return enableLocalApplication();
  return installLocalApplication();
}

function isTrustedInstallation(result: NativeApplicationInstallResult): boolean {
  return (
    result.operation === 'install' &&
    (result.code === 'installed' || result.code === 'already-installed') &&
    result.installed === true &&
    result.launchable === true &&
    result.publisherVerified === true
  );
}

/**
 * Installs the native application first and commits the shell projection last.
 * This ordering prevents a failed or unverified native installation from ever
 * appearing as an installed desktop application.
 */
export async function installWeChatTransaction({
  nativeApplications,
  acceptedTerms,
  commitLocalInstallation,
}: WeChatInstallationRequest): Promise<WeChatInstallationOutcome> {
  if (!acceptedTerms) {
    return {
      ok: false,
      code: 'terms-not-accepted',
      message: '安装前需要明确同意腾讯的微信软件许可及服务说明和隐私保护说明。',
    };
  }

  if (!nativeApplications) {
    return {
      ok: false,
      code: 'native-host-unavailable',
      message: '当前浏览器未连接 AlSniper OS 原生 host，因此不会假装安装微信。请使用腾讯官网或 Microsoft Store 官方入口安装。',
    };
  }

  let nativeResult: NativeApplicationInstallResult;
  try {
    nativeResult = await nativeApplications.install('wechat', { acceptedTerms: true });
  } catch {
    return {
      ok: false,
      code: 'native-install-rejected',
      message: '微信原生安装失败。未创建桌面图标，请检查 AlSniper OS 原生 host 后重试，或改用腾讯官网与 Microsoft Store 官方入口。',
    };
  }

  if (!isTrustedInstallation(nativeResult)) {
    return {
      ok: false,
      code: 'native-install-rejected',
      message: '原生 host 未能确认微信已安装、可启动且发布者签名已验证。未创建桌面图标。',
    };
  }

  let localResult: AppInstallationResult;
  try {
    localResult = commitLocalInstallation();
  } catch {
    return {
      ok: false,
      code: 'local-commit-rejected',
      message: '微信已由原生 host 安装，但 AlSniper OS 未能提交桌面图标。请重试或使用下方官方入口。',
    };
  }
  if (!localResult.ok || localResult.installation?.enabled !== true) {
    return {
      ok: false,
      code: 'local-commit-rejected',
      message: '微信已由原生 host 安装，但 AlSniper OS 未能提交桌面图标。请重试或使用下方官方入口。',
    };
  }

  return { ok: true, nativeResult, localResult };
}
