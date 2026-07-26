import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { A2uiErrorBoundary, A2uiFailureFallback } from './A2uiErrorBoundary';

describe('A2UI error isolation', () => {
  it('provides a trusted accessible fallback without exposing model payloads', () => {
    const markup = renderToStaticMarkup(<A2uiFailureFallback />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('本次界面已被隔离');
    expect(A2uiErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('wraps both lazy loading and A2UI rendering at the eager Host boundary', () => {
    const source = readFileSync(new URL('./AgentRuntimeProvider.tsx', import.meta.url), 'utf8');
    const boundary = source.indexOf('<A2uiErrorBoundary resetKey={envelope}>');
    const suspense = source.indexOf('<Suspense fallback=', boundary);
    const surface = source.indexOf('<LazyAiosA2uiSurface', suspense);
    expect(boundary).toBeGreaterThan(-1);
    expect(suspense).toBeGreaterThan(boundary);
    expect(surface).toBeGreaterThan(suspense);
  });
});
