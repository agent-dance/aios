import { sep } from 'node:path';

/**
 * Runtime packages contain production entrypoints only. Test/smoke entrypoints
 * are intentionally excluded from the ASAR attack surface.
 */
export function includeCompiledAsset(source) {
  return (
    !source.endsWith('.map')
    && !source.endsWith(`${sep}smoke.js`)
    && !source.endsWith(`${sep}persistenceSmoke.js`)
    && !source.endsWith(`${sep}applicationControlSmoke.js`)
  );
}
