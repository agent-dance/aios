import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_CONTENT_SECURITY_POLICY, PRODUCTION_CONTENT_SECURITY_POLICY } from './cspPolicy';

describe('browser CSP transport contract', () => {
  it('permits only the production sidecar HTTP endpoint and keeps HMR WebSockets development-only', () => {
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' http://127.0.0.1:*");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain('localhost');
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain('ws:');
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain('[::1]');

    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).toContain('ws://127.0.0.1:*');
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).toContain('ws://localhost:*');
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).not.toContain('http://localhost:');
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).not.toContain('[::1]');
  });
});
