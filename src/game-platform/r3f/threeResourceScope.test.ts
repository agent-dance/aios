import { describe, expect, it, vi } from 'vitest';
import { ThreeResourceScope } from './threeResourceScope';

describe('ThreeResourceScope', () => {
  it('disposes only explicitly owned resources once in reverse order', () => {
    const order: string[] = [];
    const shared = { dispose: vi.fn() };
    const first = { dispose: vi.fn(() => order.push('first')) };
    const second = { dispose: vi.fn(() => order.push('second')) };
    const scope = new ThreeResourceScope();

    expect(scope.own(first)).toBe(first);
    scope.own(second);
    expect(scope.size).toBe(2);
    scope.dispose();
    scope.dispose();

    expect(order).toEqual(['second', 'first']);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(shared.dispose).not.toHaveBeenCalled();
    expect(scope.disposed).toBe(true);
    expect(scope.size).toBe(0);
  });

  it('can transfer a resource without disposing it', () => {
    const resource = { dispose: vi.fn() };
    const scope = new ThreeResourceScope();
    scope.own(resource);
    expect(scope.release(resource)).toBe(resource);
    scope.dispose();
    expect(resource.dispose).not.toHaveBeenCalled();
  });

  it('continues cleanup and aggregates disposal failures', () => {
    const succeeds = { dispose: vi.fn() };
    const fails = { dispose: vi.fn(() => { throw new Error('GPU cleanup failed'); }) };
    const scope = new ThreeResourceScope();
    scope.own(succeeds);
    scope.own(fails);

    expect(() => scope.dispose()).toThrow(AggregateError);
    expect(succeeds.dispose).toHaveBeenCalledOnce();
    expect(fails.dispose).toHaveBeenCalledOnce();
  });

  it('rejects ownership after disposal', () => {
    const scope = new ThreeResourceScope();
    scope.dispose();
    expect(() => scope.own({ dispose: vi.fn() })).toThrowError(/after ThreeResourceScope\.dispose/);
  });
});
