export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class ValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const assertRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new ValidationError(path, 'expected an object');
  return value;
};

export const assertExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`${path}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ValidationError(`${path}.${key}`, 'required field is missing');
  }
};

export const assertString = (
  value: unknown,
  path: string,
  options: { min?: number; max: number; pattern?: RegExp } = { max: 1024 },
): string => {
  if (typeof value !== 'string') throw new ValidationError(path, 'expected a string');
  const min = options.min ?? 0;
  if (value.length < min || value.length > options.max) {
    throw new ValidationError(path, `length must be between ${min} and ${options.max}`);
  }
  if (options.pattern && !options.pattern.test(value)) throw new ValidationError(path, 'invalid format');
  return value;
};

export const assertBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new ValidationError(path, 'expected a boolean');
  return value;
};

export const assertSafeInteger = (
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): number => {
  if (!Number.isSafeInteger(value)) throw new ValidationError(path, 'expected a safe integer');
  const result = value as number;
  if (options.min !== undefined && result < options.min) throw new ValidationError(path, `must be >= ${options.min}`);
  if (options.max !== undefined && result > options.max) throw new ValidationError(path, `must be <= ${options.max}`);
  return result;
};

export const assertFiniteNumber = (value: unknown, path: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new ValidationError(path, `expected a finite number >= ${min}`);
  }
  return value;
};

export const assertEnum = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
};

export const assertArray = <T>(
  value: unknown,
  path: string,
  options: { max: number; min?: number; item: (value: unknown, path: string) => T },
): readonly T[] => {
  if (!Array.isArray(value)) throw new ValidationError(path, 'expected an array');
  const min = options.min ?? 0;
  if (value.length < min || value.length > options.max) {
    throw new ValidationError(path, `item count must be between ${min} and ${options.max}`);
  }
  return value.map((item, index) => options.item(item, `${path}[${index}]`));
};

export const assertJsonValue = (value: unknown, path: string, depth = 0): JsonValue => {
  if (depth > 20) throw new ValidationError(path, 'JSON nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 512) throw new ValidationError(path, 'array is too large');
    return value.map((item, index) => assertJsonValue(item, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 256) throw new ValidationError(path, 'object is too large');
    return Object.fromEntries(keys.map((key) => [key, assertJsonValue(value[key], `${path}.${key}`, depth + 1)]));
  }
  throw new ValidationError(path, 'expected JSON-compatible data');
};

export const stableSerialize = (value: unknown): string => {
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (isRecord(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, visit(entry[key])]));
    }
    return entry;
  };
  return JSON.stringify(visit(value));
};
