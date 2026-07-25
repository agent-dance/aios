import { describe, expect, it } from 'vitest';
import { getBreadcrumbItems, getFolderSummary, getVisibleEntries } from './finderUtils';

describe('finderUtils', () => {
  it('returns nested breadcrumbs for a child folder', () => {
    const breadcrumbs = getBreadcrumbItems('visuals');
    expect(breadcrumbs.map((item) => item.name)).toEqual(['Documents', 'Visual System']);
  });

  it('filters tag collections by query', () => {
    const results = getVisibleEntries('shared-tag', null, 'receipt');
    expect(results.map((item) => item.name)).toContain('receipt-log.csv');
  });

  it('summarizes folders with descendant counts', () => {
    const summary = getFolderSummary('documents');
    expect(summary.childrenCount).toBeGreaterThan(0);
    expect(summary.descendantCount).toBeGreaterThan(summary.childrenCount);
  });
});
