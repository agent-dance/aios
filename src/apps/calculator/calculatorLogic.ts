export type CalculatorOperator = '+' | '-' | '×' | '÷';

export interface CalculatorHistoryEntry {
  id: string;
  expression: string;
  result: string;
  isError?: boolean;
}

export interface CalculatorState {
  display: string;
  accumulator: number | null;
  operator: CalculatorOperator | null;
  awaitingNextValue: boolean;
  expressionLabel: string;
  history: CalculatorHistoryEntry[];
  error: string | null;
  lastOperator: CalculatorOperator | null;
  lastOperand: number | null;
}

export type CalculatorAction =
  | { type: 'digit'; digit: string }
  | { type: 'decimal' }
  | { type: 'operator'; operator: CalculatorOperator }
  | { type: 'equals' }
  | { type: 'percent' }
  | { type: 'toggle-sign' }
  | { type: 'clear' }
  | { type: 'all-clear' }
  | { type: 'backspace' }
  | { type: 'restore-history'; entry: CalculatorHistoryEntry };

const MAX_DISPLAY_LENGTH = 14;
const DIVIDE_BY_ZERO_MESSAGE = 'Cannot divide by zero';

export const createInitialCalculatorState = (): CalculatorState => ({
  display: '0',
  accumulator: null,
  operator: null,
  awaitingNextValue: false,
  expressionLabel: 'Ready',
  history: [],
  error: null,
  lastOperator: null,
  lastOperand: null,
});

const trimDisplay = (value: string) => {
  if (value.length <= MAX_DISPLAY_LENGTH) {
    return value;
  }

  return Number(value).toPrecision(9).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
};

export const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return 'Error';
  }

  if (Number.isInteger(value)) {
    return trimDisplay(String(value));
  }

  return trimDisplay(value.toString());
};

const readDisplayNumber = (state: CalculatorState) => Number(state.display);

const pushHistory = (
  history: CalculatorHistoryEntry[],
  expression: string,
  result: string,
  isError = false,
) => [
  {
    id: `${Date.now()}-${history.length}`,
    expression,
    result,
    isError,
  },
  ...history,
].slice(0, 8);

const clearOnError = (state: CalculatorState) => (
  state.error ? { ...createInitialCalculatorState(), history: state.history } : state
);

const applyBinaryOperator = (
  left: number,
  right: number,
  operator: CalculatorOperator,
): { value: number } | { error: string } => {
  if (operator === '÷' && right === 0) {
    return { error: DIVIDE_BY_ZERO_MESSAGE };
  }

  switch (operator) {
    case '+':
      return { value: left + right };
    case '-':
      return { value: left - right };
    case '×':
      return { value: left * right };
    case '÷':
      return { value: left / right };
    default:
      return { value: left };
  }
};

const evaluatePending = (
  state: CalculatorState,
  nextOperator: CalculatorOperator | null,
  invokedByEquals: boolean,
) => {
  if (state.operator === null || state.accumulator === null) {
    if (nextOperator) {
      return {
        ...state,
        accumulator: readDisplayNumber(state),
        operator: nextOperator,
        awaitingNextValue: true,
        expressionLabel: `${state.display} ${nextOperator}`,
        lastOperator: null,
        lastOperand: null,
      };
    }

    return state;
  }

  const rightOperand = state.awaitingNextValue && state.lastOperand !== null && invokedByEquals
    ? state.lastOperand
    : readDisplayNumber(state);
  const calculation = applyBinaryOperator(state.accumulator, rightOperand, state.operator);
  const expression = `${formatNumber(state.accumulator)} ${state.operator} ${formatNumber(rightOperand)}`;

  if ('error' in calculation) {
    const errorMessage = calculation.error;
    return {
      ...createInitialCalculatorState(),
      display: 'Error',
      expressionLabel: expression,
      error: errorMessage,
      history: pushHistory(state.history, expression, errorMessage, true),
    };
  }

  const nextDisplay = formatNumber(calculation.value);
  const updatedState: CalculatorState = {
    ...state,
    display: nextDisplay,
    accumulator: nextOperator ? calculation.value : null,
    operator: nextOperator,
    awaitingNextValue: nextOperator !== null || invokedByEquals,
    expressionLabel: nextOperator ? `${nextDisplay} ${nextOperator}` : expression,
    error: null,
    lastOperator: state.operator,
    lastOperand: rightOperand,
    history: invokedByEquals
      ? pushHistory(state.history, expression, nextDisplay)
      : state.history,
  };

  return updatedState;
};

export const reduceCalculatorState = (
  currentState: CalculatorState,
  action: CalculatorAction,
): CalculatorState => {
  const state = clearOnError(currentState);

  switch (action.type) {
    case 'digit': {
      if (state.awaitingNextValue) {
        return {
          ...state,
          display: action.digit,
          awaitingNextValue: false,
          expressionLabel: state.operator && state.accumulator !== null
            ? `${formatNumber(state.accumulator)} ${state.operator}`
            : state.expressionLabel,
        };
      }

      const nextDisplay = state.display === '0' ? action.digit : `${state.display}${action.digit}`;
      return { ...state, display: trimDisplay(nextDisplay) };
    }

    case 'decimal': {
      if (state.awaitingNextValue) {
        return { ...state, display: '0.', awaitingNextValue: false };
      }

      if (state.display.includes('.')) {
        return state;
      }

      return { ...state, display: `${state.display}.` };
    }

    case 'operator': {
      if (state.operator !== null && state.accumulator !== null && !state.awaitingNextValue) {
        return evaluatePending(state, action.operator, false);
      }

      return {
        ...state,
        accumulator: readDisplayNumber(state),
        operator: action.operator,
        awaitingNextValue: true,
        expressionLabel: `${state.display} ${action.operator}`,
      };
    }

    case 'equals': {
      if (state.operator !== null && state.accumulator !== null) {
        return evaluatePending(state, null, true);
      }

      if (state.lastOperator !== null && state.lastOperand !== null) {
        const replayState: CalculatorState = {
          ...state,
          accumulator: readDisplayNumber(state),
          operator: state.lastOperator,
          awaitingNextValue: true,
        };
        return evaluatePending(replayState, null, true);
      }

      return state;
    }

    case 'percent': {
      const currentValue = readDisplayNumber(state);
      const nextValue = state.operator !== null && state.accumulator !== null
        ? state.accumulator * (currentValue / 100)
        : currentValue / 100;

      return {
        ...state,
        display: formatNumber(nextValue),
        awaitingNextValue: false,
      };
    }

    case 'toggle-sign': {
      if (state.display === '0') {
        return state;
      }

      return {
        ...state,
        display: state.display.startsWith('-') ? state.display.slice(1) : `-${state.display}`,
      };
    }

    case 'clear': {
      if (state.display !== '0' || state.error) {
        return {
          ...state,
          display: '0',
          error: null,
          awaitingNextValue: false,
        };
      }

      return createInitialCalculatorState();
    }

    case 'all-clear':
      return createInitialCalculatorState();

    case 'backspace': {
      if (state.awaitingNextValue) {
        return state;
      }

      if (state.display.length <= 1 || (state.display.startsWith('-') && state.display.length === 2)) {
        return { ...state, display: '0' };
      }

      return { ...state, display: state.display.slice(0, -1) };
    }

    case 'restore-history':
      return {
        ...createInitialCalculatorState(),
        display: action.entry.isError ? '0' : action.entry.result,
        expressionLabel: action.entry.expression,
        history: state.history,
      };

    default:
      return state;
  }
};
