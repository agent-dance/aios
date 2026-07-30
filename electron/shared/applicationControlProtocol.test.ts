import { describe, expect, it } from 'vitest';
import {
  cloneApplicationActionCapability,
  cloneApplicationControlReceipt,
  parseApplicationControlExecuteRequest,
  parseApplicationControlReceiptLookup,
  ApplicationControlContractError,
} from './applicationControlProtocol.js';

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    intentId: 'intent-1',
    idempotencyKey: 'idem-1',
    principal: {
      kind: 'agent',
      instanceId: 'domain-agent:assistant@1.0.0#sha256:abcdef:local',
      packageId: 'ai.alsniper.desktop-assistant@1.0.0',
      userId: 'user-1',
    },
    appId: 'wechat',
    actionId: 'wechat.message.send_to_current',
    arguments: { text: 'hello' },
    expectedRevision: 7,
    ...overrides,
  };
}

describe('application-control v1 shared protocol', () => {
  it('clones, normalizes, and deeply freezes a valid request', () => {
    const source = validRequest({ arguments: { text: 'line\u2028two', negativeZero: -0 } });
    const parsed = parseApplicationControlExecuteRequest(source);

    expect(parsed.principal.packageId).toBe('ai.alsniper.desktop-assistant@1.0.0');
    expect(parsed.arguments).toEqual({ text: 'line\u2028two', negativeZero: 0 });
    expect(Object.is((parsed.arguments as { negativeZero: number }).negativeZero, -0)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.principal)).toBe(true);
    expect(Object.isFrozen(parsed.arguments)).toBe(true);
    expect(parsed.arguments).not.toBe(source.arguments);
  });

  it.each([
    { protocolVersion: 2 },
    { appId: 'WeChat' },
    { actionId: 'send' },
    { actionId: 'wechat.message-send' },
    { expectedRevision: -1 },
    { arguments: { value: Number.NaN } },
    { arguments: { value: Number.POSITIVE_INFINITY } },
    { extra: true },
  ])('rejects invalid execute request fragment %j', (override) => {
    expect(() => parseApplicationControlExecuteRequest(validRequest(override))).toThrow(ApplicationControlContractError);
  });

  it('enforces depth, collection, and serialized wire limits', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 21; index += 1) nested = { child: nested };
    expect(() => parseApplicationControlExecuteRequest(validRequest({ arguments: { nested } }))).toThrow();
    expect(() => parseApplicationControlExecuteRequest(validRequest({ arguments: { values: Array(513).fill(0) } }))).toThrow();
    expect(() => parseApplicationControlExecuteRequest(validRequest({
      arguments: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`key${index}`, index])),
    }))).toThrow();
    expect(() => parseApplicationControlExecuteRequest(validRequest({ arguments: { text: 'x'.repeat(65_537) } }))).toThrow();
  });

  it('rejects prototype-pollution keys', () => {
    const argumentsWithConstructor = Object.create(null) as Record<string, unknown>;
    argumentsWithConstructor.constructor = 'blocked';
    expect(() => parseApplicationControlExecuteRequest(validRequest({ arguments: argumentsWithConstructor }))).toThrow();
  });

  it('validates capabilities, receipts, and principal-scoped receipt lookups', () => {
    expect(cloneApplicationActionCapability({
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      adapterVersion: '1.0.0',
      risk: 'R3',
      requiresApproval: true,
    })).toEqual({
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      adapterVersion: '1.0.0',
      risk: 'R3',
      requiresApproval: true,
    });
    expect(() => cloneApplicationActionCapability({
      appId: 'wechat', actionId: 'send', adapterVersion: '1.0.0', risk: 'R3', requiresApproval: true,
    })).toThrow();

    const receipt = cloneApplicationControlReceipt({
      protocolVersion: 1,
      receiptId: 'receipt-1',
      intentId: 'intent-1',
      idempotencyKey: 'idem-1',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      occurredAt: '2026-07-30T00:00:00.000Z',
      journalSequence: 0,
      errorCode: 'JOURNAL_UNAVAILABLE',
    });
    expect(receipt.journalSequence).toBe(0);
    expect(() => cloneApplicationControlReceipt({
      ...receipt,
      reconcilesReceiptId: 'receipt-previous',
    })).toThrow('Journal sequence zero');
    expect(() => cloneApplicationControlReceipt({
      ...receipt,
      errorCode: 'IDEMPOTENCY_CONFLICT',
    })).toThrow('Journal sequence zero');
    expect(() => cloneApplicationControlReceipt({
      ...receipt,
      journalSequence: 1,
    })).toThrow('Journal sequence zero');
    expect(() => cloneApplicationControlReceipt({
      ...receipt,
      status: 'committed',
      approvedByUser: false,
      retryable: true,
      errorCode: 'INTERNAL_ERROR',
    })).toThrow('impossible');
    expect(parseApplicationControlReceiptLookup({
      protocolVersion: 1,
      idempotencyKey: 'idem-1',
      principal: validRequest().principal,
    }).principal).toEqual(validRequest().principal);
  });
});
