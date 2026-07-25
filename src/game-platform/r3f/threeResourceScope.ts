export interface ThreeDisposable {
  dispose(): void;
}
/**
 * Ownership boundary for resources created imperatively outside R3F's JSX
 * lifecycle. It intentionally never traverses Object3D/material/texture graphs:
 * shared and declarative resources are untouched unless explicitly registered.
 */
export class ThreeResourceScope {
  readonly #owned = new Set<ThreeDisposable>();
  #disposed = false;

  get size(): number {
    return this.#owned.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  own<T extends ThreeDisposable>(resource: T): T {
    if (this.#disposed) throw new Error('Cannot own a resource after ThreeResourceScope.dispose().');
    this.#owned.add(resource);
    return resource;
  }

  /** Transfers ownership out of this scope without disposing the resource. */
  release<T extends ThreeDisposable>(resource: T): T {
    this.#owned.delete(resource);
    return resource;
  }

  /** Disposes explicitly owned resources once, in reverse registration order. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const resources = [...this.#owned].reverse();
    this.#owned.clear();
    const errors: unknown[] = [];

    for (const resource of resources) {
      try {
        resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to dispose ${errors.length} owned Three.js resource(s).`);
    }
  }
}
