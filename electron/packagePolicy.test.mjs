import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { includeCompiledAsset } from './packagePolicy.mjs';

describe('desktop package policy', () => {
  it('excludes source maps and every smoke entrypoint from the ASAR staging tree', () => {
    expect(includeCompiledAsset(join('dist-electron', 'applicationControlSmoke.js'))).toBe(false);
    expect(includeCompiledAsset(join('dist-electron', 'persistenceSmoke.js'))).toBe(false);
    expect(includeCompiledAsset(join('dist-electron', 'smoke.js'))).toBe(false);
    expect(includeCompiledAsset(join('dist-electron', 'main.js.map'))).toBe(false);
    expect(includeCompiledAsset(join('dist-electron', 'main.js'))).toBe(true);
    expect(includeCompiledAsset(join('dist', 'index.html'))).toBe(true);
  });
});
