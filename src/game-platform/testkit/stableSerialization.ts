const formatPathSegment = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

const unsupported = (path: string, detail: string): never => {
  throw new TypeError(`Cannot stably serialize ${detail} at ${path}.`);
};

/**
 * Serializes JSON-shaped deterministic state with recursively sorted object
 * keys. Unsupported or ambiguous values fail loudly instead of being silently
 * omitted as they are by JSON.stringify.
 */
export const stableSerialize = (value: unknown): string => {
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: string): string => {
    if (current === null) return 'null';

    switch (typeof current) {
      case 'string':
        return JSON.stringify(current);
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) unsupported(path, `non-finite number ${String(current)}`);
        if (Object.is(current, -0)) return '-0';
        return String(current);
      case 'undefined':
      case 'bigint':
      case 'function':
      case 'symbol':
        return unsupported(path, typeof current);
      case 'object':
        break;
      default:
        return unsupported(path, typeof current);
    }

    const objectValue = current as object;
    if (ancestors.has(objectValue)) unsupported(path, 'cyclic reference');
    ancestors.add(objectValue);
    try {
      if (Array.isArray(objectValue)) {
        const entries: string[] = [];
        for (let index = 0; index < objectValue.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(objectValue, index)) {
            unsupported(`${path}[${index}]`, 'sparse array slot');
          }
          entries.push(visit(objectValue[index], `${path}[${index}]`));
        }
        return `[${entries.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(objectValue) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        unsupported(path, `non-plain object ${prototype?.constructor?.name ?? 'unknown'}`);
      }

      const enumerableSymbols = Object.getOwnPropertySymbols(objectValue).filter(
        (symbol) => Object.getOwnPropertyDescriptor(objectValue, symbol)?.enumerable,
      );
      if (enumerableSymbols.length > 0) unsupported(path, 'symbol-keyed property');

      const record = objectValue as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const entries = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor?.get || descriptor?.set) unsupported(`${path}${formatPathSegment(key)}`, 'accessor property');
        return `${JSON.stringify(key)}:${visit(record[key], `${path}${formatPathSegment(key)}`)}`;
      });
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(objectValue);
    }
  };

  return visit(value, '$');
};

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

const updateFnvByte = (hash: bigint, byte: number) => ((hash ^ BigInt(byte)) * FNV_PRIME_64) & UINT64_MASK;

/** FNV-1a 64-bit hash over the canonical serialization's UTF-8 bytes. */
export const stableHash = (value: unknown): string => {
  const serialized = stableSerialize(value);
  let hash = FNV_OFFSET_64;

  for (const character of serialized) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      hash = updateFnvByte(hash, codePoint);
    } else if (codePoint <= 0x7ff) {
      hash = updateFnvByte(hash, 0xc0 | (codePoint >> 6));
      hash = updateFnvByte(hash, 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      hash = updateFnvByte(hash, 0xe0 | (codePoint >> 12));
      hash = updateFnvByte(hash, 0x80 | ((codePoint >> 6) & 0x3f));
      hash = updateFnvByte(hash, 0x80 | (codePoint & 0x3f));
    } else {
      hash = updateFnvByte(hash, 0xf0 | (codePoint >> 18));
      hash = updateFnvByte(hash, 0x80 | ((codePoint >> 12) & 0x3f));
      hash = updateFnvByte(hash, 0x80 | ((codePoint >> 6) & 0x3f));
      hash = updateFnvByte(hash, 0x80 | (codePoint & 0x3f));
    }
  }

  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`;
};
