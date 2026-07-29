import {
  Download,
  ExternalLink,
  Globe2,
  Laptop,
  ShoppingBag,
  QrCode,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { NativeApplicationPort } from '../../native-apps';
import { useSystemStore } from '../../system/useSystemStore';
import { launchNativeWeChat, type WeChatNativeLaunchFeedback } from './nativeLaunch';
import {
  openOfficialWeChatDestination,
  requestDesktopWeChatLaunch,
  WECHAT_OFFICIAL_DESTINATIONS,
  type ExternalWindowOpener,
  type DesktopProtocolLauncher,
  type WeChatDesktopLaunchResult,
  type WeChatDestinationId,
  type WeChatNavigationResult,
} from './officialNavigation';
import './WeChatApp.css';

export interface WeChatAppProps {
  nativeApplications?: NativeApplicationPort;
  nativeLaunchFeedback?: WeChatNativeLaunchFeedback | null;
  onNativeLaunchFeedback?: (feedback: WeChatNativeLaunchFeedback) => void;
  openExternalWindow?: ExternalWindowOpener;
  launchDesktopProtocol?: DesktopProtocolLauncher;
}

interface DestinationCard {
  readonly id: WeChatDestinationId;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly officialBadge: string;
  readonly icon: typeof Globe2;
}

const DESTINATION_CARDS: readonly DestinationCard[] = [
  {
    id: 'web',
    title: '微信网页版',
    description: '在腾讯官方网页中登录微信。通常需要使用手机微信扫码确认。',
    action: '打开网页版',
    officialBadge: '腾讯官方入口',
    icon: Globe2,
  },
  {
    id: 'microsoftStore',
    title: 'Microsoft Store',
    description: '打开微软官方商店中的微信页面，安装由腾讯提供的 Windows 客户端。',
    action: '在商店中查看',
    officialBadge: 'Microsoft 官方入口',
    icon: ShoppingBag,
  },
  {
    id: 'windows',
    title: 'Windows 微信',
    description: '前往腾讯官方 Windows 下载页，获取并安装桌面客户端。',
    action: '前往官方下载',
    officialBadge: '腾讯官方入口',
    icon: Laptop,
  },
  {
    id: 'mac',
    title: 'macOS 微信',
    description: '前往腾讯官方 macOS 下载页，获取适用于 Mac 的客户端。',
    action: '前往官方下载',
    officialBadge: '腾讯官方入口',
    icon: Download,
  },
];

function WeChatMark() {
  return (
    <span className="wechat-mark" aria-hidden="true">
      <span className="wechat-mark__bubble wechat-mark__bubble--large">
        <i />
        <i />
      </span>
      <span className="wechat-mark__bubble wechat-mark__bubble--small">
        <i />
        <i />
      </span>
    </span>
  );
}

export function WeChatApp({
  nativeApplications,
  nativeLaunchFeedback,
  onNativeLaunchFeedback,
  openExternalWindow,
  launchDesktopProtocol,
}: WeChatAppProps = {}) {
  const theme = useSystemStore((state) => state.preferences.theme);
  const [navigationResult, setNavigationResult] = useState<WeChatNavigationResult | WeChatDesktopLaunchResult | null>(null);
  const [localNativeFeedback, setLocalNativeFeedback] = useState<WeChatNativeLaunchFeedback | null>(null);
  const [nativeLaunchPending, setNativeLaunchPending] = useState(false);
  const nativeLaunchPendingRef = useRef(false);
  const visibleFeedback = navigationResult ?? localNativeFeedback ?? nativeLaunchFeedback;

  const openDestination = (destinationId: WeChatDestinationId) => {
    setNavigationResult(openOfficialWeChatDestination(destinationId, openExternalWindow));
  };

  const launchDesktopClient = async () => {
    if (!nativeApplications) {
      setLocalNativeFeedback(null);
      setNavigationResult(requestDesktopWeChatLaunch(launchDesktopProtocol));
      return;
    }

    if (nativeLaunchPendingRef.current) return;
    nativeLaunchPendingRef.current = true;
    setNativeLaunchPending(true);
    setNavigationResult(null);
    try {
      const feedback = await launchNativeWeChat(nativeApplications);
      setLocalNativeFeedback(feedback);
      onNativeLaunchFeedback?.(feedback);
    } finally {
      nativeLaunchPendingRef.current = false;
      setNativeLaunchPending(false);
    }
  };

  return (
    <div className="wechat-app" data-theme={theme}>
      <header className="wechat-app__header">
        <div className="wechat-app__identity">
          <WeChatMark />
          <div>
            <span className="wechat-app__eyebrow">官方服务启动中心</span>
            <h1>微信</h1>
            <p>从 AlSniper OS 安全前往腾讯官方微信服务。</p>
          </div>
        </div>
        <span className="wechat-app__verified">
          <ShieldCheck size={17} aria-hidden="true" />
          AlSniper OS 已验证入口范围
        </span>
      </header>

      <main className="wechat-app__content">
        <section className="wechat-app__hero" aria-labelledby="wechat-launch-heading">
          <div className="wechat-app__hero-copy">
            <span className="wechat-app__section-label">WeChat Desktop</span>
            <h2 id="wechat-launch-heading">启动已安装的微信</h2>
            <p>
              {nativeApplications
                ? 'AlSniper OS 会请求原生 host 启动已验证腾讯发布者签名的微信客户端。'
                : '当前未连接原生 host；下方 xweixin:// 启动只是浏览器的尽力尝试，无法确认客户端是否真实启动。'}
              微信客户端本体、登录和消息服务由腾讯提供。
              此应用不会仿造微信登录或聊天界面，也不会读取你的微信账号、消息或二维码。
            </p>
            <button
              className="wechat-app__primary"
              type="button"
              disabled={nativeLaunchPending}
              onClick={() => { void launchDesktopClient(); }}
            >
              <ExternalLink size={18} aria-hidden="true" />
              {nativeLaunchPending
                ? '正在请求原生 host…'
                : nativeApplications
                  ? '通过原生 host 启动微信'
                  : '尝试 xweixin:// 启动（尽力而为）'}
            </button>
          </div>

          <div className="wechat-app__scan-note">
            <span className="wechat-app__scan-icon"><QrCode size={38} aria-hidden="true" /></span>
            <strong>未安装或需要登录？</strong>
            <p>
              使用下方 Microsoft Store 或腾讯官网下载入口安装官方客户端；网页版通常需要手机微信扫码确认。
            </p>
          </div>
        </section>

        {visibleFeedback ? (
          <div
            className={`wechat-app__notice ${visibleFeedback.ok ? 'wechat-app__notice--success' : 'wechat-app__notice--error'}`}
            role={visibleFeedback.ok ? 'status' : 'alert'}
            aria-live="polite"
          >
            {visibleFeedback.message}
          </div>
        ) : null}

        <section className="wechat-app__destinations" aria-labelledby="wechat-options-heading">
          <div className="wechat-app__section-heading">
            <div>
              <span className="wechat-app__section-label">官方入口</span>
              <h2 id="wechat-options-heading">选择使用方式</h2>
            </div>
            <button className="wechat-app__text-action" type="button" onClick={() => openDestination('website')}>
              微信官网
              <ExternalLink size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="wechat-app__destination-grid">
            {DESTINATION_CARDS.map((card) => {
              const Icon = card.icon;
              const destination = WECHAT_OFFICIAL_DESTINATIONS[card.id];
              return (
                <article className="wechat-app__destination" key={card.id}>
                  <span className="wechat-app__destination-icon"><Icon size={23} aria-hidden="true" /></span>
                  <h3>{card.title}</h3>
                  <strong>{card.officialBadge}</strong>
                  <p>{card.description}</p>
                  <code>{new URL(destination.url).hostname}</code>
                  <button type="button" onClick={() => openDestination(card.id)}>
                    {card.action}
                    <ExternalLink size={15} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <section className="wechat-app__trust" aria-label="安全与安装说明">
          <div>
            <ShieldCheck size={20} aria-hidden="true" />
            <p><strong>隔离打开</strong><span>新页面使用 noopener 与 noreferrer，不能回控 AlSniper OS。</span></p>
          </div>
          <div>
            <Smartphone size={20} aria-hidden="true" />
            <p><strong>账号归腾讯管理</strong><span>登录、扫码、风控与消息数据均由微信官方服务处理。</span></p>
          </div>
          <div>
            <QrCode size={20} aria-hidden="true" />
            <p><strong>网页版作为次选</strong><span>网页版可用性和账号资格受腾讯策略、所在地区及账号状态影响。</span></p>
          </div>
        </section>
      </main>
    </div>
  );
}
