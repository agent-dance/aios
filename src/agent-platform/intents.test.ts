import { describe, expect, it } from 'vitest';
import {
  MAX_APPLICATION_ACTION_ARGUMENTS_BYTES,
  MAX_WECHAT_MESSAGE_TEXT_UTF16_UNITS,
  validateApplicationActionArguments,
  validateOsIntent,
} from './intents';

describe('application action intents', () => {
  it('accepts and deeply freezes a bounded generic application action', () => {
    const intent = validateOsIntent({
      id: 'intent-1',
      type: 'execute_app_action',
      appId: 'notes.app',
      actionId: 'notes.document.append',
      arguments: { block: { text: 'hello' }, tags: ['agent'] },
      expectedRevision: 4,
    });
    expect(intent).toMatchObject({ appId: 'notes.app', actionId: 'notes.document.append' });
    expect(Object.isFrozen(intent)).toBe(true);
    if (intent.type !== 'execute_app_action') throw new Error('unexpected intent');
    expect(Object.isFrozen(intent.arguments)).toBe(true);
    expect(Object.isFrozen(intent.arguments.block)).toBe(true);
    expect(Object.isFrozen(intent.arguments.tags)).toBe(true);
  });

  it('accepts the shipped underscore-delimited WeChat action identifier', () => {
    expect(validateOsIntent({
      id: 'wechat-send-1',
      type: 'execute_app_action',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'hello' },
    })).toMatchObject({ actionId: 'wechat.message.send_to_current', arguments: { text: 'hello' } });
  });

  it('applies the WeChat text limit in UTF-16 code units', () => {
    expect(() => validateOsIntent({
      id: 'wechat-send-unicode-ok',
      type: 'execute_app_action',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: '😀'.repeat(MAX_WECHAT_MESSAGE_TEXT_UTF16_UNITS / 2) },
    })).not.toThrow();
    expect(() => validateOsIntent({
      id: 'wechat-send-unicode-large',
      type: 'execute_app_action',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: '😀'.repeat((MAX_WECHAT_MESSAGE_TEXT_UTF16_UNITS / 2) + 1) },
    })).toThrow();
  });

  it.each([
    ['uppercase app id', { appId: 'WeChat', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello' } }],
    ['invalid action id', { appId: 'wechat', actionId: 'wechat/message/send', arguments: { text: 'hello' } }],
    ['single-segment action id', { appId: 'wechat', actionId: 'send', arguments: { text: 'hello' } }],
    ['wrong app for WeChat action', { appId: 'notes', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello' } }],
    ['unknown WeChat argument', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello', selector: '#send' } }],
    ['empty WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: '' } }],
    ['blank WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: ' \r\n\t ' } }],
    ['BOM-only WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: '\ufeff' } }],
    ['NUL in WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello\0world' } }],
    ['control in WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello\u0007world' } }],
    ['bidi override in WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: 'hello\u202eworld' } }],
    ['lone high surrogate in WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: '\ud800' } }],
    ['lone low surrogate in WeChat text', { appId: 'wechat', actionId: 'wechat.message.send_to_current', arguments: { text: '\udc00' } }],
    ['oversized WeChat text', {
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'x'.repeat(MAX_WECHAT_MESSAGE_TEXT_UTF16_UNITS + 1) },
    }],
  ])('rejects %s', (_name, action) => {
    expect(() => validateOsIntent({ id: 'intent-1', type: 'execute_app_action', ...action })).toThrow();
  });

  it('normalizes WeChat CRLF and lone CR before binding the effect payload', () => {
    expect(validateOsIntent({
      id: 'wechat-send-newlines',
      type: 'execute_app_action',
      appId: 'wechat',
      actionId: 'wechat.message.send_to_current',
      arguments: { text: 'line 1\r\nline 2\rline 3' },
    })).toMatchObject({ arguments: { text: 'line 1\nline 2\nline 3' } });
  });

  it('measures the 64 KiB generic arguments ceiling as serialized UTF-8 JSON bytes', () => {
    const accepted = validateApplicationActionArguments({ a: 'x'.repeat(32_760), b: 'y'.repeat(32_761) });
    expect(new TextEncoder().encode(JSON.stringify(accepted))).toHaveLength(MAX_APPLICATION_ACTION_ARGUMENTS_BYTES);
    expect(() => validateApplicationActionArguments({ text: '界'.repeat(22_000) })).toThrow(/65536 bytes/);
  });

  it('rejects generic argument strings and object keys outside the IPC transport contract', () => {
    expect(() => validateApplicationActionArguments({ text: 'x'.repeat(32_769) })).toThrow(/32768/);
    expect(() => validateApplicationActionArguments({ ['x'.repeat(129)]: true })).toThrow(/transport key/);
    expect(() => validateApplicationActionArguments(JSON.parse('{"__proto__":true}') as unknown)).toThrow(/transport key/);
  });
});
