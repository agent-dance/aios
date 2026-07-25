import { describe, expect, it } from 'vitest';
import { createInitialCalculatorState, reduceCalculatorState } from './calculatorLogic';

const dispatchMany = (types: Parameters<typeof reduceCalculatorState>[1][]) =>
  types.reduce(reduceCalculatorState, createInitialCalculatorState());

describe('calculatorLogic', () => {
  it('supports continuous chained operations', () => {
    const state = dispatchMany([
      { type: 'digit', digit: '8' },
      { type: 'operator', operator: '+' },
      { type: 'digit', digit: '4' },
      { type: 'operator', operator: '×' },
      { type: 'digit', digit: '3' },
      { type: 'equals' },
    ]);

    expect(state.display).toBe('36');
    expect(state.history[0]?.expression).toBe('12 × 3');
  });

  it('converts percentages relative to the accumulator', () => {
    const state = dispatchMany([
      { type: 'digit', digit: '2' },
      { type: 'digit', digit: '0' },
      { type: 'digit', digit: '0' },
      { type: 'operator', operator: '+' },
      { type: 'digit', digit: '1' },
      { type: 'digit', digit: '0' },
      { type: 'percent' },
      { type: 'equals' },
    ]);

    expect(state.display).toBe('220');
  });

  it('guards against divide by zero and records it in history', () => {
    const state = dispatchMany([
      { type: 'digit', digit: '9' },
      { type: 'operator', operator: '÷' },
      { type: 'digit', digit: '0' },
      { type: 'equals' },
    ]);

    expect(state.error).toBe('Cannot divide by zero');
    expect(state.history[0]?.isError).toBe(true);
  });

  it('repeats the previous operation when equals is pressed again', () => {
    const state = dispatchMany([
      { type: 'digit', digit: '5' },
      { type: 'operator', operator: '+' },
      { type: 'digit', digit: '2' },
      { type: 'equals' },
      { type: 'equals' },
    ]);

    expect(state.display).toBe('9');
  });
});
