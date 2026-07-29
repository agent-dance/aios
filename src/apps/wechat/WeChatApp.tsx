import {
  LoaderCircle,
  MonitorUp,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import type { WeChatEmbeddedViewBridge, WeChatViewPhase } from './bridge';
import { describeWeChatViewError } from './bridge';
import { useEmbeddedWeChatView } from './useEmbeddedWeChatView';
import './WeChatApp.css';

export interface WeChatAppProps {
  readonly bridge?: WeChatEmbeddedViewBridge | null;
  readonly isActive?: boolean;
  readonly isMinimized?: boolean;
}

const PHASE_LABELS: Readonly<Record<WeChatViewPhase, string>> = {
  idle: '正在初始化',
  loading: '正在连接微信',
  ready: '微信已就绪',
  failed: '加载失败',
};

export function WeChatApp({
  bridge,
  isActive = true,
  isMinimized = false,
}: WeChatAppProps = {}) {
  const view = useEmbeddedWeChatView({ bridge, isActive, isMinimized });
  const loading = view.hostState.phase === 'idle' || view.hostState.phase === 'loading';
  const failed = view.hostState.phase === 'failed' || view.errorMessage !== null;

  return (
    <div className="wechat-app" data-phase={view.hostState.phase}>
      <main
        className="wechat-app__surface"
        ref={view.surfaceRef}
        aria-busy={view.bridgeAvailable && loading ? 'true' : 'false'}
        onPointerDown={view.requestFocus}
      >
        {!view.bridgeAvailable ? (
          <section className="wechat-app__message" role="alert" aria-labelledby="wechat-desktop-required">
            <span className="wechat-app__message-icon"><MonitorUp size={34} aria-hidden="true" /></span>
            <h2 id="wechat-desktop-required">请使用 AlSniper OS 桌面版</h2>
            <p>
              当前环境没有桌面宿主，无法在系统内安全嵌入微信。浏览器版本不会伪装成可用微信，
              也不会把你跳转到另一个网页或尝试启动本机客户端。
            </p>
          </section>
        ) : failed ? (
          <section className="wechat-app__message wechat-app__message--error" role="alert">
            <span className="wechat-app__message-icon"><TriangleAlert size={32} aria-hidden="true" /></span>
            <h2>微信视图无法加载</h2>
            <p>{view.errorMessage ?? describeWeChatViewError(view.hostState.errorCode)}</p>
            <button
              className="wechat-app__retry"
              type="button"
              disabled={view.commandPending !== null}
              onClick={() => { void view.runAction('retry'); }}
            >
              <RefreshCw
                className={view.commandPending === 'retry' ? 'wechat-app__spin' : undefined}
                size={17}
                aria-hidden="true"
              />
              {view.commandPending === 'retry' ? '正在重试…' : '重试'}
            </button>
          </section>
        ) : loading ? (
          <section className="wechat-app__message" role="status" aria-live="polite">
            <span className="wechat-app__message-icon wechat-app__message-icon--loading">
              <LoaderCircle className="wechat-app__spin" size={34} aria-hidden="true" />
            </span>
            <h2>{PHASE_LABELS[view.hostState.phase]}</h2>
            <p>正在通过受隔离的桌面宿主加载微信官方服务。</p>
          </section>
        ) : (
          <p className="wechat-app__ready-description">
            微信内容已在 AlSniper OS 桌面宿主中加载。
          </p>
        )}
      </main>
    </div>
  );
}
