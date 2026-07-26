import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./AppStoreApp.tsx', import.meta.url), 'utf8');

describe('Agent Store asynchronous operation boundary', () => {
  it('serializes Agent mutations and surfaces failures instead of leaking rejections', () => {
    expect(SOURCE).toContain('if (agentOperationRef.current !== null) return;');
    expect(SOURCE).toContain('await operation();');
    expect(SOURCE).toContain('setAgentOperationError({');
    expect(SOURCE).toContain('role="alert"');
    expect(SOURCE).not.toMatch(/void\s+agentLibrary\.(install|enable|disable|uninstall)/);
  });
});
