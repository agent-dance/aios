import { describe, expect, it } from 'vitest';
import {
  assertNoPayload,
  cloneWeChatState,
  createWeChatState,
  parseWeChatBounds,
  parseWeChatVisibility,
  WeChatContractError,
} from './wechatProtocol.js';

describe('WeChat desktop protocol', () => {
  it('accepts and clones exact integer bounds', () => {
    const source = { x: 7, y: 9, width: 800, height: 600 };

    const parsed = parseWeChatBounds(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    null,
    [],
    { x: 0, y: 0, width: 1 },
    { x: 0, y: 0, width: 1, height: 1, url: 'https://example.com' },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1.5, height: 1 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
    { x: 0, y: 0, width: 32_769, height: 1 },
  ])('rejects non-exact or unsafe bounds: %j', (value) => {
    expect(() => parseWeChatBounds(value)).toThrow(WeChatContractError);
  });

  it('only accepts primitive booleans for visibility', () => {
    expect(parseWeChatVisibility(true)).toBe(true);
    expect(parseWeChatVisibility(false)).toBe(false);
    expect(() => parseWeChatVisibility(1)).toThrow(WeChatContractError);
    expect(() => parseWeChatVisibility({ value: true })).toThrow(WeChatContractError);
  });

  it('requires no-payload operations to receive undefined', () => {
    expect(() => assertNoPayload(undefined)).not.toThrow();
    expect(() => assertNoPayload(null)).toThrow(WeChatContractError);
    expect(() => assertNoPayload({})).toThrow(WeChatContractError);
  });

  it('validates, closes, and clones state payloads', () => {
    expect(cloneWeChatState({ phase: 'ready', visible: true, canGoBack: false })).toEqual({
      phase: 'ready',
      visible: true,
      canGoBack: false,
    });
    expect(createWeChatState('failed', true, false, 'NETWORK_ERROR')).toEqual({
      phase: 'failed',
      visible: true,
      canGoBack: false,
      errorCode: 'NETWORK_ERROR',
    });

    expect(() => cloneWeChatState({ phase: 'ready', visible: true, canGoBack: false, extra: true })).toThrow();
    expect(() => cloneWeChatState({ phase: 'failed', visible: true, canGoBack: false })).toThrow();
    expect(() => cloneWeChatState({ phase: 'ready', visible: true, canGoBack: false, errorCode: 'NETWORK_ERROR' })).toThrow();
    expect(() => cloneWeChatState({ phase: 'failed', visible: true, canGoBack: false, errorCode: 'OTHER' })).toThrow();
  });
});
