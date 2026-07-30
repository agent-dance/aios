import { createHash, randomUUID } from 'node:crypto';
import type {
  ApplicationAdapter,
  ApplicationAdapterCommitResult,
  PreparedApplicationAction,
} from '../applicationAdapter.js';
import type {
  ApplicationActionCapability,
  ApplicationControlErrorCode,
  ApplicationControlExecuteRequest,
} from '../../../shared/applicationControlProtocol.js';
import type {
  WeChatAutomationBinding,
  WeChatAutomationTarget,
  WeChatAutomationTargetProvider,
} from './weChatAutomationTarget.js';
import {
  WECHAT_MESSAGE_OBSERVATION_TIMEOUT_MS,
  WECHAT_MESSAGE_PROFILE,
  type WeChatMessageRuntimeResult,
} from './weChatMessageRuntime.js';

export const WECHAT_APPLICATION_ID = 'wechat' as const;
export const WECHAT_SEND_TO_CURRENT_ACTION_ID = 'wechat.message.send_to_current' as const;
export const WECHAT_MESSAGE_ADAPTER_VERSION = '1.0.0' as const;
export const WECHAT_MESSAGE_MAX_UTF16_UNITS = 4_000;

const PREPARED_STATE_BRAND = Symbol('WeChatPreparedMessageState');
const TARGET_POLL_MS = 25;
const PREPARE_DEADLINE_MS = 3_000;
const COMMIT_DEADLINE_GRACE_MS = 1_000;
const DANGEROUS_DISPLAY_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const LONE_SURROGATE_PATTERN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

const CAPABILITY: ApplicationActionCapability = Object.freeze({
  appId: WECHAT_APPLICATION_ID,
  actionId: WECHAT_SEND_TO_CURRENT_ACTION_ID,
  adapterVersion: WECHAT_MESSAGE_ADAPTER_VERSION,
  risk: 'R3',
  requiresApproval: true,
});

type CommitPhase = 'prepared' | 'dispatching' | 'finished';

export interface WeChatPreparedMessageState {
  readonly [PREPARED_STATE_BRAND]: true;
  readonly requestFingerprint: string;
  readonly preparedFingerprint: string;
  readonly rootToken: string;
  readonly recipientUsername: string;
  readonly recipientTitle: string;
  readonly text: string;
  readonly binding: WeChatAutomationBinding;
  phase: CommitPhase;
}

export class WeChatApplicationControlError extends Error {
  readonly errorCode: ApplicationControlErrorCode;

  constructor(errorCode: ApplicationControlErrorCode, message: string) {
    super(message);
    this.name = 'WeChatApplicationControlError';
    this.errorCode = errorCode;
  }
}

type BoundOperationResult =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'invalidated' }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'execution-failed' };

function sha256(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function normalizeMessageText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function parseMessageText(request: ApplicationControlExecuteRequest): string {
  if (request.appId !== WECHAT_APPLICATION_ID || request.actionId !== WECHAT_SEND_TO_CURRENT_ACTION_ID) {
    throw new WeChatApplicationControlError('ACTION_UNAVAILABLE', 'The requested WeChat action is unavailable.');
  }
  const keys = Object.keys(request.arguments);
  const textValue = request.arguments.text;
  if (
    keys.length !== 1
    || keys[0] !== 'text'
    || typeof textValue !== 'string'
  ) {
    throw new WeChatApplicationControlError('INVALID_ARGUMENT', 'The WeChat message arguments are invalid.');
  }
  const text = normalizeMessageText(textValue);
  if (
    text.trim().length === 0
    || DANGEROUS_DISPLAY_PATTERN.test(text)
    || LONE_SURROGATE_PATTERN.test(text)
    || text.length > WECHAT_MESSAGE_MAX_UTF16_UNITS
  ) {
    throw new WeChatApplicationControlError('INVALID_ARGUMENT', 'The WeChat message body is invalid.');
  }
  return text;
}

function quoteApprovalField(value: string): string {
  return JSON.stringify(value);
}

function requestFingerprint(request: ApplicationControlExecuteRequest, text: string): string {
  return sha256(
    'alsniper-application-request-v1',
    String(request.protocolVersion),
    request.intentId,
    request.idempotencyKey,
    request.principal.kind,
    request.principal.instanceId,
    request.principal.packageId,
    request.principal.userId,
    request.appId,
    request.actionId,
    String(request.expectedRevision),
    text,
  );
}

function bindingsEqual(left: WeChatAutomationBinding, right: WeChatAutomationBinding): boolean {
  return left.controllerGeneration === right.controllerGeneration
    && left.documentSequence === right.documentSequence
    && left.origin === right.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRuntimeResult(value: unknown): WeChatMessageRuntimeResult | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'prepared':
      if (
        typeof value.rootToken !== 'string'
        || typeof value.recipientUsername !== 'string'
        || value.recipientUsername.length < 1
        || value.recipientUsername.length > 512
        || typeof value.recipientTitle !== 'string'
        || value.recipientTitle.length < 1
        || value.recipientTitle.length > 256
        || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value.recipientTitle)
      ) return null;
      return {
        kind: 'prepared',
        rootToken: value.rootToken,
        recipientUsername: value.recipientUsername,
        recipientTitle: value.recipientTitle,
      };
    case 'precondition-failed':
      return typeof value.reason === 'string' && value.reason.length <= 64 && value.dispatched === false
        ? { kind: 'precondition-failed', reason: value.reason, dispatched: false }
        : null;
    case 'committed':
    case 'failed':
    case 'unknown':
      return value.dispatched === true ? { kind: value.kind, dispatched: true } : null;
    default:
      return null;
  }
}

function runBoundOperation(
  target: WeChatAutomationTarget,
  operation: Promise<unknown>,
  deadlineMs: number,
): Promise<BoundOperationResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundOperationResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(deadlineTimer);
      resolve(result);
    };
    const pollTimer = setInterval(() => {
      if (!target.isCurrent()) finish({ kind: 'invalidated' });
    }, TARGET_POLL_MS);
    pollTimer.unref();
    const deadlineTimer = setTimeout(() => finish({ kind: 'timed-out' }), deadlineMs);
    deadlineTimer.unref();
    operation.then(
      (value) => finish(target.isCurrent() ? { kind: 'result', value } : { kind: 'invalidated' }),
      () => finish({ kind: 'execution-failed' }),
    );
  });
}

function commitResult(
  status: ApplicationAdapterCommitResult['status'],
  errorCode?: ApplicationControlErrorCode,
): ApplicationAdapterCommitResult {
  return {
    status,
    retryable: false,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export class WeChatMessageAdapter implements ApplicationAdapter<WeChatPreparedMessageState> {
  readonly appId = WECHAT_APPLICATION_ID;
  readonly #getTarget: WeChatAutomationTargetProvider;

  constructor(getTarget: WeChatAutomationTargetProvider) {
    this.#getTarget = getTarget;
  }

  listCapabilities(): readonly ApplicationActionCapability[] {
    return Object.freeze([CAPABILITY]);
  }

  async prepare(
    request: ApplicationControlExecuteRequest,
  ): Promise<PreparedApplicationAction<WeChatPreparedMessageState>> {
    const text = parseMessageText(request);
    const target = this.#getTarget();
    if (target === null || !target.isCurrent()) {
      throw new WeChatApplicationControlError('ADAPTER_UNAVAILABLE', 'The Web WeChat surface is unavailable.');
    }

    const rootToken = randomUUID();
    let execution: Promise<unknown>;
    try {
      execution = target.prepareMessage({ operation: 'prepare', rootToken });
    } catch {
      throw new WeChatApplicationControlError('ADAPTER_UNAVAILABLE', 'The Web WeChat surface is unavailable.');
    }
    const boundResult = await runBoundOperation(target, execution, PREPARE_DEADLINE_MS);
    if (boundResult.kind !== 'result') {
      throw new WeChatApplicationControlError('PRECONDITION_FAILED', 'The Web WeChat document changed during preparation.');
    }
    const runtimeResult = parseRuntimeResult(boundResult.value);
    if (
      runtimeResult === null
      || runtimeResult.kind === 'committed'
      || runtimeResult.kind === 'failed'
      || runtimeResult.kind === 'unknown'
    ) {
      throw new WeChatApplicationControlError('PRECONDITION_FAILED', 'The Web WeChat page profile did not match safely.');
    }
    if (runtimeResult.kind === 'precondition-failed') {
      throw new WeChatApplicationControlError('PRECONDITION_FAILED', 'The Web WeChat send preconditions were not satisfied.');
    }
    if (runtimeResult.rootToken !== rootToken || !target.isCurrent()) {
      throw new WeChatApplicationControlError('PRECONDITION_FAILED', 'The Web WeChat document changed during preparation.');
    }

    const targetBindingDigest = sha256(
      'alsniper-wechat-target-v1',
      WECHAT_MESSAGE_PROFILE.id,
      target.binding.origin,
      runtimeResult.recipientUsername,
    );
    const effectBindingDigest = sha256(
      'alsniper-wechat-effect-v1',
      targetBindingDigest,
      text,
    );
    const internalRequestFingerprint = requestFingerprint(request, text);
    const preparedFingerprint = sha256(
      'alsniper-wechat-prepared-v1',
      internalRequestFingerprint,
      targetBindingDigest,
      effectBindingDigest,
      String(target.binding.controllerGeneration),
      String(target.binding.documentSequence),
      rootToken,
    );
    const state: WeChatPreparedMessageState = {
      [PREPARED_STATE_BRAND]: true,
      requestFingerprint: internalRequestFingerprint,
      preparedFingerprint,
      rootToken,
      recipientUsername: runtimeResult.recipientUsername,
      recipientTitle: runtimeResult.recipientTitle,
      text,
      binding: Object.freeze({ ...target.binding }),
      phase: 'prepared',
    };

    return Object.freeze({
      preparedFingerprint,
      approval: Object.freeze({
        title: '确认通过微信发送消息',
        message: '此操作将以你的身份向当前微信会话发送消息。',
        detail: `收件人（显示名称）：\n${quoteApprovalField(state.recipientTitle)}\n\n消息正文（JSON 字符串）：\n${quoteApprovalField(state.text)}`,
        confirmLabel: '发送',
      }),
      state,
    });
  }

  async commit(input: {
    readonly request: ApplicationControlExecuteRequest;
    readonly prepared: PreparedApplicationAction<WeChatPreparedMessageState>;
    readonly grant: import('../applicationAdapter.js').ApplicationControlGrant;
  }): Promise<ApplicationAdapterCommitResult> {
    // A one-shot trusted grant is consumed before inspecting mutable page state.
    input.grant.consume(input.grant.requestFingerprint, input.prepared.preparedFingerprint);

    const state = input.prepared.state;
    if (
      state[PREPARED_STATE_BRAND] !== true
      || input.prepared.preparedFingerprint !== state.preparedFingerprint
      || state.phase !== 'prepared'
    ) {
      return commitResult('failed', 'REPLAY_REJECTED');
    }
    let text: string;
    try {
      text = parseMessageText(input.request);
    } catch {
      return commitResult('failed', 'INVALID_ARGUMENT');
    }
    if (requestFingerprint(input.request, text) !== state.requestFingerprint || text !== state.text) {
      return commitResult('failed', 'REPLAY_REJECTED');
    }
    const target = this.#getTarget();
    if (
      target === null
      || !target.isCurrent()
      || !bindingsEqual(target.binding, state.binding)
    ) {
      state.phase = 'finished';
      return commitResult('failed', 'PRECONDITION_FAILED');
    }

    state.phase = 'dispatching';
    let execution: Promise<unknown>;
    try {
      execution = target.commitMessage({
          operation: 'commit',
          rootToken: state.rootToken,
          recipientUsername: state.recipientUsername,
          recipientTitle: state.recipientTitle,
          text: state.text,
          observationTimeoutMs: WECHAT_MESSAGE_OBSERVATION_TIMEOUT_MS,
        });
    } catch {
      state.phase = 'finished';
      return commitResult('unknown', 'RECONCILIATION_FAILED');
    }
    const boundResult = await runBoundOperation(
      target,
      execution,
      WECHAT_MESSAGE_OBSERVATION_TIMEOUT_MS + COMMIT_DEADLINE_GRACE_MS,
    );
    state.phase = 'finished';
    if (boundResult.kind !== 'result') {
      return commitResult('unknown', 'RECONCILIATION_FAILED');
    }
    const runtimeResult = parseRuntimeResult(boundResult.value);
    let result: ApplicationAdapterCommitResult;
    if (runtimeResult?.kind === 'committed') {
      result = commitResult('committed');
    } else if (runtimeResult?.kind === 'failed') {
      result = commitResult('failed');
    } else if (runtimeResult?.kind === 'precondition-failed') {
      result = commitResult('failed', 'PRECONDITION_FAILED');
    } else {
      // Once execution was handed to the page, an unparseable/timeout result
      // may have followed the one permitted click and must never be retried.
      result = commitResult('unknown', 'RECONCILIATION_FAILED');
    }
    return result;
  }
}
