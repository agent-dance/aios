import { describe, expect, it } from 'vitest';
import { normalizeAssistantError } from './errors';

const remoteError = (remoteCode: string, message = 'provider text must not be shown') => {
  const error = new Error(message) as Error & { remoteCode: string; requestId?: string };
  error.remoteCode = remoteCode;
  return error;
};

describe('normalizeAssistantError', () => {
  it('provides an actionable localized recovery for rejected Codex authentication', () => {
    const message = normalizeAssistantError(remoteError('AGENT_AUTH_REQUIRED', 'RAW_PROVIDER_CANARY'));
    expect(message).toContain('codex login');
    expect(message).toContain('自动同步');
    expect(message).not.toContain('RAW_PROVIDER_CANARY');
  });

  it.each([
    ['INVALID_AGENT_OUTPUT', '结果格式'],
    ['AGENT_TIMEOUT', '超时'],
    ['AGENT_UNAVAILABLE', 'Codex Runtime'],
    ['BUSY', '任务较多'],
  ])('maps %s without exposing remote text', (code, expected) => {
    const message = normalizeAssistantError(remoteError(code, 'RAW_REMOTE_CANARY'));
    expect(message).toContain(expected);
    expect(message).not.toContain('RAW_REMOTE_CANARY');
  });

  it('preserves an ordinary local client error and has a safe unknown fallback', () => {
    expect(normalizeAssistantError(new Error('本机 Agent sidecar 尚未连接。'))).toBe('本机 Agent sidecar 尚未连接。');
    expect(normalizeAssistantError(null)).toBe('Agent 暂时无法响应，请稍后重试。');
  });

  it('does not expose text from an unknown remote error code', () => {
    const error = remoteError('FUTURE_REMOTE_CODE', 'RAW_FUTURE_REMOTE_CANARY');
    error.requestId = 'request-safe-1';
    const message = normalizeAssistantError(error);
    expect(message).toContain('request-safe-1');
    expect(message).not.toContain('RAW_FUTURE_REMOTE_CANARY');
  });
});
