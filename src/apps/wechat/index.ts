export { WeChatApp } from './WeChatApp';
export type { WeChatAppProps } from './WeChatApp';
export {
  describeWeChatViewError,
  isWeChatSurfaceActive,
  isWeChatViewState,
  resolveWeChatEmbeddedViewBridge,
  shouldShowWeChatNativeView,
  toWeChatViewBounds,
  WECHAT_VIEW_ERROR_CODES,
  WECHAT_VIEW_PHASES,
} from './bridge';
export type {
  WeChatEmbeddedViewBridge,
  WeChatShellOcclusionState,
  WeChatViewBounds,
  WeChatViewErrorCode,
  WeChatViewPhase,
  WeChatViewState,
  WeChatViewStateListener,
  WeChatViewVisibilityContext,
} from './bridge';
