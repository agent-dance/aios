import { AGAP_ERROR_CODES, AgapError, type AgapErrorCode } from './errors';

const childPath = (path: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

const MAX_PROTOCOL_DEPTH = 64;
const MAX_PROTOCOL_NODES = 100_000;
const MAX_PROTOCOL_STRING_LENGTH = 1_000_000;

const fail = (code: AgapErrorCode, path: string, reason: string): never => {
  throw new AgapError(code, `Value at ${path} is not protocol-safe: ${reason}.`, {
    details: { path, reason },
  });
};

/** Clone and validate the JSON-shaped value crossing the trust boundary. */
export const cloneProtocolValue = <Value>(
  value: Value,
  code: AgapErrorCode = AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
): Value => {
  const ancestors = new Set<object>();
  let visitedNodes = 0;

  const visit = (current: unknown, path: string, depth: number): unknown => {
    visitedNodes += 1;
    if (visitedNodes > MAX_PROTOCOL_NODES) return fail(code, path, `value exceeds ${MAX_PROTOCOL_NODES} nodes`);
    if (depth > MAX_PROTOCOL_DEPTH) return fail(code, path, `value exceeds depth ${MAX_PROTOCOL_DEPTH}`);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (current.length > MAX_PROTOCOL_STRING_LENGTH) {
        return fail(code, path, `string exceeds ${MAX_PROTOCOL_STRING_LENGTH} UTF-16 code units`);
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return fail(code, path, 'numbers must be finite');
      // JSON transports normalize -0 to 0, so canonicalize it at ingress too.
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') return fail(code, path, `${typeof current} is unsupported`);
    if (ancestors.has(current)) return fail(code, path, 'cyclic references are unsupported');

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const clone: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            return fail(code, `${path}[${index}]`, 'sparse arrays are unsupported');
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor?.get || descriptor?.set) {
            return fail(code, `${path}[${index}]`, 'accessors are unsupported');
          }
          clone.push(visit(descriptor?.value, `${path}[${index}]`, depth + 1));
        }
        const extraKeys = Object.keys(current).filter((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length);
        if (extraKeys.length > 0) return fail(code, childPath(path, extraKeys[0]!), 'custom array keys are unsupported');
        const symbols = Object.getOwnPropertySymbols(current).filter(
          (symbol) => Object.getOwnPropertyDescriptor(current, symbol)?.enumerable,
        );
        if (symbols.length > 0) return fail(code, path, 'symbol keys are unsupported');
        return clone;
      }

      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        return fail(code, path, 'only plain objects are supported');
      }
      const symbols = Object.getOwnPropertySymbols(current).filter(
        (symbol) => Object.getOwnPropertyDescriptor(current, symbol)?.enumerable,
      );
      if (symbols.length > 0) return fail(code, path, 'symbol keys are unsupported');

      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor?.get || descriptor?.set) return fail(code, childPath(path, key), 'accessors are unsupported');
        Object.defineProperty(clone, key, {
          value: visit((current as Record<string, unknown>)[key], childPath(path, key), depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return clone;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, '$', 0) as Value;
};

/** Canonical JSON identity used only after cloneProtocolValue validation. */
export const canonicalProtocolValue = (value: unknown): string => {
  const cloned = cloneProtocolValue(value);
  const visit = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') return String(current);
    if (Array.isArray(current)) return `[${current.map(visit).join(',')}]`;
    const record = current as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`)
      .join(',')}}`;
  };
  return visit(cloned);
};
