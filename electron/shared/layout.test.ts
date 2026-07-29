import { describe, expect, it } from 'vitest';
import { fitBoundsToContent } from './layout.js';

describe('fitBoundsToContent', () => {
  it('leaves contained bounds unchanged', () => {
    expect(fitBoundsToContent(
      { x: 20, y: 30, width: 500, height: 400 },
      { width: 1024, height: 768 },
    )).toEqual({ x: 20, y: 30, width: 500, height: 400 });
  });

  it('clips every edge into the host content area', () => {
    expect(fitBoundsToContent(
      { x: 900, y: 700, width: 500, height: 400 },
      { width: 1024, height: 768 },
    )).toEqual({ x: 900, y: 700, width: 124, height: 68 });
  });

  it('keeps a one-pixel valid rectangle when the origin exceeds the host', () => {
    expect(fitBoundsToContent(
      { x: 5000, y: 5000, width: 200, height: 200 },
      { width: 800, height: 600 },
    )).toEqual({ x: 799, y: 599, width: 1, height: 1 });
  });

  it.each([
    { width: 0, height: 600 },
    { width: 800, height: 0 },
    { width: 800.5, height: 600 },
  ])('does not produce invalid View bounds for unusable content size: %j', (content) => {
    expect(fitBoundsToContent({ x: 0, y: 0, width: 20, height: 20 }, content)).toBeNull();
  });
});
