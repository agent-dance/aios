import { describe, expect, it } from 'vitest';
import { shouldRejectWeChatClientCertificateRequest } from './clientCertificatePolicy.js';

describe('WeChat client-certificate policy', () => {
  it('rejects every request owned by embedded WeChat regardless of redirect URL', () => {
    expect(shouldRejectWeChatClientCertificateRequest(true)).toBe(true);
  });

  it('does not intercept certificate selection for other WebContents', () => {
    expect(shouldRejectWeChatClientCertificateRequest(false)).toBe(false);
  });
});
