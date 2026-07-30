export const WECHAT_MESSAGE_PROFILE = Object.freeze({
  id: 'web-wechat-classic.1',
  signedInRoot: '.main_inner',
  loginRoot: '.login',
  activeChat: '.chat_item.active[data-username]',
  activeChatTitle: '.nickname > .nickname_text',
  conversationTitle: '#chatArea .box_hd .title_name[data-username]',
  editor: '#chatArea .box_ft #editArea.flex.edit_area[contenteditable="true"]',
  sendButton: '#chatArea .box_ft .action > .btn.btn_send[ng-click="sendTextMessage()"]',
  outboundMessage: '#chatArea .message.me .js_message_bubble[data-cm]',
  outboundText: '.bubble_cont .plain > pre.js_message_plain',
  outboundLoading: '.bubble_cont .plain > .ico_loading',
  outboundFailure: '.bubble_cont .plain > .ico_fail.web_wechat_message_fail',
  pollMs: 100,
} as const);

export const WECHAT_MESSAGE_OBSERVATION_TIMEOUT_MS = 12_000;
export const WECHAT_MESSAGE_RUNTIME_POLL_MS = WECHAT_MESSAGE_PROFILE.pollMs;

export interface WeChatMessageRuntimePrepareInput {
  readonly operation: 'prepare';
  readonly rootToken: string;
}

export interface WeChatMessageRuntimeCommitInput {
  readonly operation: 'commit';
  readonly rootToken: string;
  readonly recipientUsername: string;
  readonly recipientTitle: string;
  readonly text: string;
  readonly observationTimeoutMs: number;
}

export type WeChatMessageRuntimeInput =
  | WeChatMessageRuntimePrepareInput
  | WeChatMessageRuntimeCommitInput;

export type WeChatMessageRuntimeResult =
  | {
      readonly kind: 'prepared';
      readonly rootToken: string;
      readonly recipientUsername: string;
      readonly recipientTitle: string;
    }
  | {
      readonly kind: 'precondition-failed';
      readonly reason: string;
      readonly dispatched: false;
    }
  | { readonly kind: 'committed'; readonly dispatched: true }
  | { readonly kind: 'failed'; readonly dispatched: true }
  | { readonly kind: 'unknown'; readonly dispatched: true };

/**
 * This function is serialized into a dedicated Electron isolated world. Keep
 * every selector and operation compiled into this module: caller input is data
 * only and can never introduce JavaScript, selectors, CDP commands, Angular
 * internals, or network requests.
 */
function runWebWeChatMessageRuntime(profile: typeof WECHAT_MESSAGE_PROFILE, input: WeChatMessageRuntimeInput): unknown {
  const remoteGlobal = globalThis as unknown as Record<string, any>;
  const documentObject = remoteGlobal.document as any;
  const HTMLElementConstructor = remoteGlobal.HTMLElement as any;
  const runtimeKey = '__alsniperWebWeChatMessageRuntimeV1__';
  let runtimeState = remoteGlobal[runtimeKey] as {
    currentAction: {
      root: object;
      token: string;
      phase: 'prepared' | 'dispatching' | 'used';
    } | null;
  } | undefined;
  if (runtimeState === undefined || !Object.hasOwn(runtimeState, 'currentAction')) {
    runtimeState = { currentAction: null };
    Object.defineProperty(remoteGlobal, runtimeKey, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: runtimeState,
    });
  }
  const state = runtimeState;

  const normalizeTitle = (value: unknown): string => String(value ?? '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const normalizeMessage = (value: unknown): string => String(value ?? '').replace(/\r\n?/gu, '\n');
  const isElement = (value: unknown): boolean => (
    typeof HTMLElementConstructor === 'function'
    && value instanceof HTMLElementConstructor
  );
  const isVisible = (element: any): boolean => {
    if (!isElement(element) || element.isConnected === false) return false;
    const style = remoteGlobal.getComputedStyle(element);
    const opacity = Number.parseFloat(String(style.opacity));
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && style.contentVisibility !== 'hidden'
      && (!Number.isFinite(opacity) || opacity > 0)
      && element.getClientRects().length > 0;
  };
  const unique = (root: any, selector: string, visibleOnly = true): any | null => {
    const matches = Array.from(root.querySelectorAll(selector) as Iterable<unknown>)
      .filter((candidate) => isElement(candidate) && (!visibleOnly || isVisible(candidate)));
    return matches.length === 1 ? matches[0] : null;
  };
  const anyVisible = (root: any, selector: string): boolean => (
    Array.from(root.querySelectorAll(selector) as Iterable<unknown>).some(isVisible)
  );
  const isSemanticallyEmptyEditor = (editor: any): boolean => {
    const nodes = Array.from(editor.childNodes as Iterable<any>);
    if (nodes.length === 0) return true;
    if (nodes.length !== 1) return false;
    const node = nodes[0];
    if (node.nodeType === 1) return String(node.tagName).toUpperCase() === 'BR';
    return node.nodeType === 3 && /^[\u200b\ufeff]*$/u.test(String(node.textContent ?? ''));
  };
  const findContext = (expected?: {
    readonly rootToken: string;
    readonly recipientUsername: string;
    readonly recipientTitle: string;
  }, requireComposer = true): {
    root: any;
    activeChat: any;
    editor: any | null;
    sendButton: any | null;
    username: string;
    title: string;
  } | string => {
    const root = unique(documentObject, profile.signedInRoot);
    if (anyVisible(documentObject, profile.loginRoot) || root === null) return 'not-signed-in';
    if (expected !== undefined) {
      const action = state.currentAction;
      if (action === null || action.root !== root || action.token !== expected.rootToken) {
        return 'root-replaced';
      }
    }
    const activeChat = unique(root, profile.activeChat);
    if (activeChat === null) return 'ambiguous-active-chat';
    const username = String(activeChat.getAttribute('data-username') ?? '');
    if (username.length === 0 || username.length > 512) return 'invalid-active-chat';
    const activeTitle = unique(activeChat, profile.activeChatTitle, false);
    const conversationTitle = unique(root, profile.conversationTitle);
    if (activeTitle === null || conversationTitle === null) return 'ambiguous-chat-title';
    const conversationUsername = String(conversationTitle.getAttribute('data-username') ?? '');
    if (conversationUsername !== username) return 'chat-identity-mismatch';
    const activeTitleText = normalizeTitle(activeTitle.textContent);
    const conversationTitleText = normalizeTitle(conversationTitle.textContent);
    if (
      activeTitleText.length === 0
      || activeTitleText.length > 256
      || activeTitleText !== conversationTitleText
    ) return 'chat-title-mismatch';
    if (
      expected !== undefined
      && (username !== expected.recipientUsername || conversationTitleText !== expected.recipientTitle)
    ) return 'active-chat-changed';
    if (!requireComposer) {
      return {
        root,
        activeChat,
        editor: null,
        sendButton: null,
        username,
        title: conversationTitleText,
      };
    }
    const editor = unique(root, profile.editor);
    if (editor === null || editor.getAttribute('contenteditable') !== 'true') return 'composer-unavailable';
    const sendButton = unique(root, profile.sendButton);
    if (
      sendButton === null
      || sendButton.hasAttribute('disabled')
      || sendButton.getAttribute('aria-disabled') === 'true'
      || String(sendButton.className ?? '').split(/\s+/u).includes('disabled')
    ) return 'send-unavailable';
    return { root, activeChat, editor, sendButton, username, title: conversationTitleText };
  };

  if (input.operation === 'prepare') {
    const context = findContext();
    if (typeof context === 'string') {
      return { kind: 'precondition-failed', reason: context, dispatched: false };
    }
    if (context.editor === null || !isSemanticallyEmptyEditor(context.editor)) {
      return { kind: 'precondition-failed', reason: 'draft-present', dispatched: false };
    }
    state.currentAction = { root: context.root, token: input.rootToken, phase: 'prepared' };
    return {
      kind: 'prepared',
      rootToken: input.rootToken,
      recipientUsername: context.username,
      recipientTitle: context.title,
    };
  }

  const expected = {
    rootToken: input.rootToken,
    recipientUsername: input.recipientUsername,
    recipientTitle: input.recipientTitle,
  };
  const context = findContext(expected);
  if (typeof context === 'string') {
    return { kind: 'precondition-failed', reason: context, dispatched: false };
  }
  const runtimeAction = state.currentAction;
  if (
    runtimeAction === null
    || runtimeAction.root !== context.root
    || runtimeAction.token !== input.rootToken
  ) {
    return { kind: 'precondition-failed', reason: 'root-replaced', dispatched: false };
  }
  if (runtimeAction.phase !== 'prepared') {
    return { kind: 'unknown', dispatched: true };
  }
  if (context.editor === null || context.sendButton === null || !isSemanticallyEmptyEditor(context.editor)) {
    return { kind: 'precondition-failed', reason: 'draft-present', dispatched: false };
  }

  const baseline = new Set(
    Array.from(context.root.querySelectorAll(profile.outboundMessage) as Iterable<unknown>)
      .filter((candidate) => isElement(candidate)),
  );
  // Consume before composing so concurrent/replayed executions cannot reach
  // the single click dispatch while this action is in flight.
  runtimeAction.phase = 'dispatching';
  context.editor.focus();
  context.editor.textContent = input.text;
  const InputEventConstructor = remoteGlobal.InputEvent;
  const EventConstructor = remoteGlobal.Event;
  const inputEvent = typeof InputEventConstructor === 'function'
    ? new InputEventConstructor('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: input.text,
        inputType: 'insertText',
      })
    : new EventConstructor('input', { bubbles: true, cancelable: false, composed: true });
  context.editor.dispatchEvent(inputEvent);

  const beforeClick = findContext(expected);
  if (
    typeof beforeClick === 'string'
    || beforeClick.editor !== context.editor
    || beforeClick.sendButton !== context.sendButton
    || normalizeMessage(context.editor.textContent) !== input.text
  ) {
    const canCleanOwnDraft = state.currentAction === runtimeAction
      && context.root.isConnected !== false
      && context.editor.isConnected !== false
      && unique(context.root, profile.editor) === context.editor
      && normalizeMessage(context.editor.textContent) === input.text;
    if (canCleanOwnDraft) {
      context.editor.textContent = '';
      const cleanupEvent = typeof InputEventConstructor === 'function'
        ? new InputEventConstructor('input', {
            bubbles: true,
            cancelable: false,
            composed: true,
            data: null,
            inputType: 'deleteContentBackward',
          })
        : new EventConstructor('input', { bubbles: true, cancelable: false, composed: true });
      context.editor.dispatchEvent(cleanupEvent);
    }
    runtimeAction.phase = 'used';
    return { kind: 'precondition-failed', reason: 'composer-changed', dispatched: false };
  }

  // This is the sole side-effect dispatch point in the whole profile.
  runtimeAction.phase = 'used';
  context.sendButton.click();
  const deadline = Date.now() + input.observationTimeoutMs;
  const readMessageState = (element: any): { readonly msgId: string; readonly status: number } | null => {
    const raw = element.getAttribute('data-cm');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32_768) return null;
    let cm: Record<string, unknown>;
    try {
      cm = JSON.parse(raw) as Record<string, unknown>;
      if (cm.type !== 'message' || typeof cm.msgId !== 'string' || cm.msgId.length === 0) return null;
    } catch {
      return null;
    }
    const explicitValue = cm.status ?? cm.Status ?? cm.MMStatus;
    const explicitStatus = typeof explicitValue === 'string' && /^\d+$/u.test(explicitValue)
      ? Number(explicitValue)
      : explicitValue;
    if (explicitStatus === 1 || explicitStatus === 2 || explicitStatus === 5) {
      return { msgId: cm.msgId as string, status: explicitStatus };
    }
    // The audited Web WeChat template exposes MMStatus through two ng-show
    // indicators: loading is status 1, failure is 5, and their mutually
    // exclusive hidden state on a newly materialized text message is status 2.
    const loading = unique(element, profile.outboundLoading, false);
    const failure = unique(element, profile.outboundFailure, false);
    if (loading === null || failure === null) return null;
    const loadingVisible = isVisible(loading);
    const failureVisible = isVisible(failure);
    if (loadingVisible && failureVisible) return null;
    if (failureVisible) return { msgId: cm.msgId as string, status: 5 };
    if (loadingVisible) return { msgId: cm.msgId as string, status: 1 };
    return { msgId: cm.msgId as string, status: 2 };
  };
  const readMessageText = (element: any): string | null => {
    const candidates = Array.from(element.querySelectorAll(profile.outboundText) as Iterable<unknown>)
      .filter((candidate) => isElement(candidate));
    if (candidates.length === 0) return null;
    const leaf = candidates.find((candidate: any) => candidate.matches?.('pre')) ?? candidates[0];
    const renderNode = (node: any): string => {
      if (node?.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? '');
      if (node?.nodeType !== 1) return '';
      if (String(node.tagName ?? '').toUpperCase() === 'BR') return '\n';
      return Array.from(node.childNodes as Iterable<unknown>).map(renderNode).join('');
    };
    return normalizeMessage(renderNode(leaf));
  };

  return new Promise((resolve) => {
    let trackedBubble: any | null = null;
    let trackedLocalMsgId: string | null = null;
    let trackedServerMsgId: string | null = null;
    const observe = (): void => {
      const current = findContext(expected, false);
      if (typeof current === 'string') {
        resolve({ kind: 'unknown', dispatched: true });
        return;
      }
      const matches = Array.from(current.root.querySelectorAll(profile.outboundMessage) as Iterable<unknown>)
        .filter((candidate) => (
          isElement(candidate)
          && !baseline.has(candidate)
          && readMessageText(candidate) === input.text
        ));
      if (matches.length > 1) {
        resolve({ kind: 'unknown', dispatched: true });
        return;
      }
      if (matches.length === 1) {
        const messageState = readMessageState(matches[0]);
        if (messageState === null) {
          resolve({ kind: 'unknown', dispatched: true });
          return;
        }
        if (trackedBubble === null) {
          if (messageState.status !== 1) {
            // A same-text message that appears already terminal may have come
            // from another device or concurrent human action. It is not proof
            // of this click.
            resolve({ kind: 'unknown', dispatched: true });
            return;
          }
          trackedBubble = matches[0];
          trackedLocalMsgId = messageState.msgId;
        } else if (matches[0] !== trackedBubble) {
          resolve({ kind: 'unknown', dispatched: true });
          return;
        } else if (messageState.status === 1) {
          if (messageState.msgId !== trackedLocalMsgId || trackedServerMsgId !== null) {
            resolve({ kind: 'unknown', dispatched: true });
            return;
          }
        } else if (messageState.status === 2) {
          if (messageState.msgId !== trackedLocalMsgId) {
            if (trackedServerMsgId !== null && trackedServerMsgId !== messageState.msgId) {
              resolve({ kind: 'unknown', dispatched: true });
              return;
            }
            trackedServerMsgId = messageState.msgId;
          }
          resolve({ kind: 'committed', dispatched: true });
          return;
        } else if (messageState.status === 5) {
          if (messageState.msgId !== trackedLocalMsgId || trackedServerMsgId !== null) {
            resolve({ kind: 'unknown', dispatched: true });
            return;
          }
          resolve({ kind: 'failed', dispatched: true });
          return;
        }
      } else if (trackedBubble !== null) {
        resolve({ kind: 'unknown', dispatched: true });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ kind: 'unknown', dispatched: true });
        return;
      }
      remoteGlobal.setTimeout(observe, profile.pollMs);
    };
    observe();
  });
}

function serializeAsJavaScriptData(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function createWeChatMessageRuntimeSource(input: WeChatMessageRuntimeInput): string {
  return `(${runWebWeChatMessageRuntime.toString()})(${serializeAsJavaScriptData(WECHAT_MESSAGE_PROFILE)},${serializeAsJavaScriptData(input)})`;
}
