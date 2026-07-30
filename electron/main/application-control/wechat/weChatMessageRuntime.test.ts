import { runInContext, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createWeChatMessageRuntimeSource,
  WECHAT_MESSAGE_PROFILE,
  type WeChatMessageRuntimeInput,
  type WeChatMessageRuntimeResult,
} from './weChatMessageRuntime.js';

class FixtureNode {
  readonly nodeType: number;
  readonly tagName?: string;
  textContent: string;

  constructor(nodeType: number, textContent = '', tagName?: string) {
    this.nodeType = nodeType;
    this.textContent = textContent;
    this.tagName = tagName;
  }
}

class FixtureElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly selectors = new Map<string, FixtureElement[]>();
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn();
  readonly dispatchEvent = vi.fn((_event: unknown) => true);
  readonly click = vi.fn();
  isConnected = true;
  visible = true;
  className = '';
  childNodes: FixtureNode[] = [];
  #textContent = '';

  constructor(tagName = 'DIV', textContent = '') {
    this.tagName = tagName;
    this.textContent = textContent;
  }

  get textContent(): string {
    return this.#textContent;
  }

  set textContent(value: string) {
    this.#textContent = value;
    this.childNodes = value.length === 0 ? [] : [new FixtureNode(3, value)];
  }

  querySelectorAll(selector: string): FixtureElement[] {
    return this.selectors.get(selector) ?? [];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getClientRects(): readonly object[] {
    return [{}];
  }

  matches(selector: string): boolean {
    return selector.toUpperCase() === this.tagName;
  }
}

class FixtureDocument {
  readonly selectors = new Map<string, FixtureElement[]>();

  querySelectorAll(selector: string): FixtureElement[] {
    return this.selectors.get(selector) ?? [];
  }
}

class FixtureEvent {
  constructor(readonly type: string, readonly init: object) {}
}

interface WeChatFixture {
  readonly context: ReturnType<typeof createContext>;
  readonly document: FixtureDocument;
  readonly root: FixtureElement;
  readonly activeChat: FixtureElement;
  readonly activeTitle: FixtureElement;
  readonly conversationTitle: FixtureElement;
  readonly editor: FixtureElement;
  readonly sendButton: FixtureElement;
  readonly outbounds: FixtureElement[];
  readonly username: string;
  replaceRoot(replacement: WeChatFixture): void;
  addOutbound(text: string, status: number): FixtureElement;
  setOutboundStatus(outbound: FixtureElement, status: number): void;
  setOutboundMessageId(outbound: FixtureElement, msgId: string): void;
  setOutboundRenderedLines(outbound: FixtureElement, lines: readonly string[]): void;
  execute(input: WeChatMessageRuntimeInput): Promise<WeChatMessageRuntimeResult>;
}

function createWeChatFixture(username = '@@fixture-chat', title = '可靠性讨论组'): WeChatFixture {
  const document = new FixtureDocument();
  const root = new FixtureElement();
  const activeChat = new FixtureElement();
  const activeTitle = new FixtureElement('SPAN', title);
  const conversationTitle = new FixtureElement('SPAN', title);
  const editor = new FixtureElement();
  const sendButton = new FixtureElement('A');
  const outbounds: FixtureElement[] = [];
  activeChat.attributes.set('data-username', username);
  conversationTitle.attributes.set('data-username', username);
  editor.attributes.set('contenteditable', 'true');
  sendButton.attributes.set('ng-click', 'sendTextMessage()');
  activeChat.selectors.set(WECHAT_MESSAGE_PROFILE.activeChatTitle, [activeTitle]);
  document.selectors.set(WECHAT_MESSAGE_PROFILE.loginRoot, []);
  document.selectors.set(WECHAT_MESSAGE_PROFILE.signedInRoot, [root]);
  root.selectors.set(WECHAT_MESSAGE_PROFILE.activeChat, [activeChat]);
  root.selectors.set(WECHAT_MESSAGE_PROFILE.conversationTitle, [conversationTitle]);
  root.selectors.set(WECHAT_MESSAGE_PROFILE.editor, [editor]);
  root.selectors.set(WECHAT_MESSAGE_PROFILE.sendButton, [sendButton]);
  root.selectors.set(WECHAT_MESSAGE_PROFILE.outboundMessage, outbounds);

  const context = createContext({
    document,
    HTMLElement: FixtureElement,
    Event: FixtureEvent,
    InputEvent: FixtureEvent,
    getComputedStyle: (element: FixtureElement) => ({
      display: element.visible ? 'block' : 'none',
      visibility: 'visible',
      contentVisibility: 'visible',
      opacity: '1',
    }),
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Promise,
    WeakMap,
    Set,
  });

  const fixture: WeChatFixture = {
    context,
    document,
    root,
    activeChat,
    activeTitle,
    conversationTitle,
    editor,
    sendButton,
    outbounds,
    username,
    replaceRoot(replacement) {
      root.isConnected = false;
      document.selectors.set(WECHAT_MESSAGE_PROFILE.signedInRoot, [replacement.root]);
    },
    addOutbound(text, status) {
      const outbound = new FixtureElement();
      const pre = new FixtureElement('PRE', text);
      const loading = new FixtureElement('IMG');
      const failure = new FixtureElement('I');
      outbound.attributes.set('data-cm', JSON.stringify({
        type: 'message',
        msgId: `fixture-message-${outbounds.length + 1}`,
      }));
      outbound.selectors.set(WECHAT_MESSAGE_PROFILE.outboundText, [pre]);
      outbound.selectors.set(WECHAT_MESSAGE_PROFILE.outboundLoading, [loading]);
      outbound.selectors.set(WECHAT_MESSAGE_PROFILE.outboundFailure, [failure]);
      outbounds.push(outbound);
      fixture.setOutboundStatus(outbound, status);
      return outbound;
    },
    setOutboundStatus(outbound, status) {
      const loading = outbound.selectors.get(WECHAT_MESSAGE_PROFILE.outboundLoading)?.[0];
      const failure = outbound.selectors.get(WECHAT_MESSAGE_PROFILE.outboundFailure)?.[0];
      if (loading === undefined || failure === undefined) throw new Error('fixture status controls missing');
      loading.visible = status === 1;
      failure.visible = status === 5;
    },
    setOutboundMessageId(outbound, msgId) {
      outbound.attributes.set('data-cm', JSON.stringify({ type: 'message', msgId }));
    },
    setOutboundRenderedLines(outbound, lines) {
      const pre = outbound.selectors.get(WECHAT_MESSAGE_PROFILE.outboundText)?.[0];
      if (pre === undefined) throw new Error('fixture message text missing');
      pre.textContent = lines.join('');
      pre.childNodes = lines.flatMap((line, index) => (
        index === lines.length - 1
          ? [new FixtureNode(3, line)]
          : [new FixtureNode(3, line), new FixtureNode(1, '', 'BR')]
      ));
    },
    async execute(input) {
      return await runInContext(
        createWeChatMessageRuntimeSource(input),
        context,
      ) as WeChatMessageRuntimeResult;
    },
  };
  return fixture;
}

async function prepare(fixture: WeChatFixture, rootToken = 'opaque-root-token') {
  const result = await fixture.execute({ operation: 'prepare', rootToken });
  expect(result).toMatchObject({ kind: 'prepared', rootToken });
  return result;
}

describe.sequential('fixed Web WeChat message runtime fixture', () => {
  it('matches official BR multiline rendering and same-bubble LocalID to server MsgID success', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    const text = '第一行：你好 👋\n第二行：收到 ✅';
    fixture.sendButton.click.mockImplementationOnce(() => {
      const outbound = fixture.addOutbound(text, 1);
      fixture.setOutboundRenderedLines(outbound, ['第一行：你好 👋', '第二行：收到 ✅']);
      setTimeout(() => {
        fixture.setOutboundMessageId(outbound, 'server-message-9001');
        fixture.setOutboundStatus(outbound, 2);
      }, 10);
    });

    const result = await fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text,
      observationTimeoutMs: 500,
    });

    expect(result).toEqual({ kind: 'committed', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
    expect(fixture.editor.textContent).toBe(text);
  });

  it('rejects a replacement bubble even when its recipient text and terminal status match', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    fixture.sendButton.click.mockImplementationOnce(() => {
      fixture.addOutbound('元素身份不可替换', 1);
      setTimeout(() => {
        fixture.outbounds.splice(0, fixture.outbounds.length);
        const replacement = fixture.addOutbound('元素身份不可替换', 2);
        fixture.setOutboundMessageId(replacement, 'server-from-replacement');
      }, 10);
    });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '元素身份不可替换',
      observationTimeoutMs: 500,
    })).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
  });

  it('rejects concurrent multiple new outbound bubbles with the same text', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    fixture.sendButton.click.mockImplementationOnce(() => {
      const own = fixture.addOutbound('并发消息', 1);
      setTimeout(() => {
        fixture.setOutboundMessageId(own, 'server-own');
        fixture.setOutboundStatus(own, 2);
        const concurrent = fixture.addOutbound('并发消息', 2);
        fixture.setOutboundMessageId(concurrent, 'server-concurrent');
      }, 10);
    });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '并发消息',
      observationTimeoutMs: 500,
    })).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
  });

  it('maps status 5 to failed and a perpetually pending message to unknown without retry', async () => {
    const failed = createWeChatFixture();
    const failedPrepared = await prepare(failed);
    failed.sendButton.click.mockImplementationOnce(() => {
      const outbound = failed.addOutbound('失败消息', 1);
      setTimeout(() => failed.setOutboundStatus(outbound, 5), 10);
    });
    await expect(failed.execute({
      operation: 'commit',
      rootToken: failedPrepared.rootToken,
      recipientUsername: failedPrepared.recipientUsername,
      recipientTitle: failedPrepared.recipientTitle,
      text: '失败消息',
      observationTimeoutMs: 200,
    })).resolves.toEqual({ kind: 'failed', dispatched: true });
    expect(failed.sendButton.click).toHaveBeenCalledOnce();

    const pending = createWeChatFixture();
    const pendingPrepared = await prepare(pending);
    pending.sendButton.click.mockImplementationOnce(() => { pending.addOutbound('等待消息', 1); });
    await expect(pending.execute({
      operation: 'commit',
      rootToken: pendingPrepared.rootToken,
      recipientUsername: pendingPrepared.recipientUsername,
      recipientTitle: pendingPrepared.recipientTitle,
      text: '等待消息',
      observationTimeoutMs: 10,
    })).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(pending.sendButton.click).toHaveBeenCalledOnce();
  });

  it('does not treat a transient pre-digest hidden-indicator state as status 2', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    fixture.sendButton.click.mockImplementationOnce(() => {
      const outbound = fixture.addOutbound('尚在发送', 2);
      setTimeout(() => fixture.setOutboundStatus(outbound, 1), 10);
    });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '尚在发送',
      observationTimeoutMs: 120,
    })).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
  });

  it.each([2, 5])('does not attribute a same-text message first observed at terminal status %s', async (status) => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    fixture.sendButton.click.mockImplementationOnce(() => { fixture.addOutbound('并发同文', status); });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '并发同文',
      observationTimeoutMs: 200,
    })).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
  });

  it('consumes the isolated-world action token so replaying identical commit data never clicks twice', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    const text = '只能发送一次';
    fixture.sendButton.click.mockImplementationOnce(() => {
      const outbound = fixture.addOutbound(text, 1);
      setTimeout(() => {
        fixture.setOutboundMessageId(outbound, 'server-message-replay-test');
        fixture.setOutboundStatus(outbound, 2);
      }, 10);
    });
    const commitInput = {
      operation: 'commit' as const,
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text,
      observationTimeoutMs: 500,
    };

    await expect(fixture.execute(commitInput)).resolves.toEqual({ kind: 'committed', dispatched: true });
    await expect(fixture.execute(commitInput)).resolves.toEqual({ kind: 'unknown', dispatched: true });
    expect(fixture.sendButton.click).toHaveBeenCalledOnce();
  });

  it('invalidates preparation after a root replacement even when display and identity look identical', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    const replacement = createWeChatFixture(fixture.username);
    fixture.replaceRoot(replacement);

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '不应发送',
      observationTimeoutMs: 50,
    })).resolves.toMatchObject({ kind: 'precondition-failed', dispatched: false });
    expect(fixture.sendButton.click).not.toHaveBeenCalled();
    expect(replacement.sendButton.click).not.toHaveBeenCalled();
  });

  it('requires immutable data-username equality on active chat and conversation title', async () => {
    const fixture = createWeChatFixture();
    fixture.conversationTitle.attributes.set('data-username', '@@different-chat');
    await expect(fixture.execute({ operation: 'prepare', rootToken: 'token' })).resolves.toEqual({
      kind: 'precondition-failed',
      reason: 'chat-identity-mismatch',
      dispatched: false,
    });
    expect(fixture.sendButton.click).not.toHaveBeenCalled();
  });

  it('rejects image-only and markup-only drafts rather than overwriting them', async () => {
    const imageDraft = createWeChatFixture();
    imageDraft.editor.childNodes = [new FixtureNode(1, '', 'IMG')];
    await expect(imageDraft.execute({ operation: 'prepare', rootToken: 'image-token' })).resolves.toMatchObject({
      kind: 'precondition-failed',
      reason: 'draft-present',
    });

    const markupDraft = createWeChatFixture();
    markupDraft.editor.childNodes = [new FixtureNode(1, '', 'SPAN')];
    await expect(markupDraft.execute({ operation: 'prepare', rootToken: 'markup-token' })).resolves.toMatchObject({
      kind: 'precondition-failed',
      reason: 'draft-present',
    });
  });

  it('cleans only its own exact draft when synchronous DOM drift occurs before click', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    fixture.editor.dispatchEvent.mockImplementationOnce(() => {
      fixture.root.selectors.set(WECHAT_MESSAGE_PROFILE.sendButton, []);
      return true;
    });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '临时草稿',
      observationTimeoutMs: 50,
    })).resolves.toMatchObject({ kind: 'precondition-failed', dispatched: false });
    expect(fixture.editor.textContent).toBe('');
    expect(fixture.sendButton.click).not.toHaveBeenCalled();
  });

  it('does not touch a detached editor after root drift and still performs no click', async () => {
    const fixture = createWeChatFixture();
    const prepared = await prepare(fixture);
    const replacement = createWeChatFixture(fixture.username);
    fixture.editor.dispatchEvent.mockImplementationOnce(() => {
      fixture.replaceRoot(replacement);
      fixture.editor.isConnected = false;
      return true;
    });

    await expect(fixture.execute({
      operation: 'commit',
      rootToken: prepared.rootToken,
      recipientUsername: prepared.recipientUsername,
      recipientTitle: prepared.recipientTitle,
      text: '旧文档草稿',
      observationTimeoutMs: 50,
    })).resolves.toMatchObject({ kind: 'precondition-failed', dispatched: false });
    expect(fixture.editor.textContent).toBe('旧文档草稿');
    expect(fixture.sendButton.click).not.toHaveBeenCalled();
    expect(replacement.sendButton.click).not.toHaveBeenCalled();
  });

  it('contains exactly one fixed click dispatch and no network, Angular private API, or caller selector input', () => {
    const source = createWeChatMessageRuntimeSource({
      operation: 'commit',
      rootToken: 'token',
      recipientUsername: '@@id',
      recipientTitle: 'title',
      text: 'body',
      observationTimeoutMs: 100,
    });
    expect(source.match(/\.click\(\)/gu)).toHaveLength(1);
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|angular\.|\$http|webwx/iu);
    expect(source).toContain(JSON.stringify(WECHAT_MESSAGE_PROFILE.sendButton).slice(1, -1));
  });
});
