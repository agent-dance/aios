export const ASSISTANT_MESSAGE_HISTORY_LIMIT = 40;
export const ASSISTANT_RECEIPT_HISTORY_LIMIT = 12;
export const ASSISTANT_DEBUG_EVENT_LIMIT = 200;

export const appendBounded = <T>(
  current: readonly T[],
  value: T,
  limit: number,
): readonly T[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('History limit must be a positive safe integer.');
  }
  const overflow = current.length + 1 - limit;
  return overflow > 0 ? [...current.slice(overflow), value] : [...current, value];
};

export const retainMostRecent = <T>(
  values: readonly T[],
  limit: number,
): readonly T[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('History limit must be a positive safe integer.');
  }
  return values.length > limit ? values.slice(values.length - limit) : [...values];
};
