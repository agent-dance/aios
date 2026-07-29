import {
  ArrowLeft,
  LoaderCircle,
  LockKeyhole,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
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

function WeChatMark() {
  return (
    <span className="wechat-mark" aria-hidden="true">
      <span className="wechat-mark__bubble wechat-mark__bubble--large"><i /><i /></span>
      <span className="wechat-mark__bubble wechat-mark__bubble--small"><i /><i /></span>
    </span>
  );
}

export function WeChatApp({
  bridge,
  isActive = true,
  isMinimized = false,
}: WeChatAppProps = {}) {
  const view = useEmbeddedWeChatView({ bridge, isActive, isMinimized });
  const loading = view.hostState.phase === 'idle' || view.hostState.phase === 'loading';
  const failed = view.hostState.phase === 'failed' || view.errorMessage !== null;
  const statusLabel = view.bridgeAvailable
    ? view.errorMessage === null ? PHASE_LABELS[view.hostState.phase] : '宿主通信失败'
    : '需要桌面版';

  return (
    <div className="wechat-app" data-phase={view.hostState.phase}>
      <header className="wechat-app__toolbar">
        <div className="wechat-app__identity">
          <WeChatMark />
          <div>
            <h1>微信</h1>
            <p>AlSniper OS 安全嵌入视图</p>
          </div>
        </div>

        <div className="wechat-app__navigation" aria-label="微信浏览控制">
          <button
            type="button"
            aria-label="后退"
            title="后退"
            disabled={!view.bridgeAvailable || !view.hostState.canGoBack || view.commandPending !== null}
            onClick={() => { void view.runAction('back'); }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="刷新微信"
            title="刷新"
            disabled={!view.bridgeAvailable || view.commandPending !== null}
            onClick={() => { void view.runAction('reload'); }}
          >
            <RefreshCw
              className={view.commandPending === 'reload' ? 'wechat-app__spin' : undefined}
              size={17}
              aria-hidden="true"
            />
          </button>
        </div>

        <span className={`wechat-app__status wechat-app__status--${failed ? 'failed' : view.hostState.phase}`}>
          <span aria-hidden="true" />
          {statusLabel}
        </span>
      </header>

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
            {view.errorMessage === null ? (
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
            ) : null}
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

      <footer className="wechat-app__security">
        <span><ShieldCheck size={15} aria-hidden="true" />仅允许微信固定服务范围</span>
        <span><LockKeyhole size={15} aria-hidden="true" />会话由隔离的桌面宿主管理</span>
      </footer>
    </div>
  );
}
