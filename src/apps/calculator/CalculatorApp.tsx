import { useEffect, useReducer } from 'react';
import { Delete, Divide, Minus, Percent, Plus, X } from 'lucide-react';
import {
  createInitialCalculatorState,
  reduceCalculatorState,
  type CalculatorAction,
  type CalculatorOperator,
} from './calculatorLogic';

const buttonBaseStyle = {
  border: 'none',
  borderRadius: 18,
  minHeight: 64,
  fontSize: 22,
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'transform 120ms ease, box-shadow 120ms ease',
} as const;

const operatorButtonStyle = {
  ...buttonBaseStyle,
  background: 'linear-gradient(180deg, #ffcc7a, #ff9f46)',
  color: '#3b1d00',
  boxShadow: '0 16px 34px rgba(255, 159, 70, 0.22)',
} as const;

const neutralButtonStyle = {
  ...buttonBaseStyle,
  background: 'rgba(244, 247, 251, 0.92)',
  color: '#0f172a',
  boxShadow: '0 12px 24px rgba(15, 23, 42, 0.08)',
} as const;

const digitButtonStyle = {
  ...buttonBaseStyle,
  background: 'rgba(255, 255, 255, 0.96)',
  color: '#0f172a',
  boxShadow: '0 18px 36px rgba(148, 163, 184, 0.14)',
} as const;

const operatorMap: Record<string, CalculatorOperator> = {
  '+': '+',
  '-': '-',
  '*': '×',
  '/': '÷',
};

const keyToAction = (event: KeyboardEvent): CalculatorAction | null => {
  if (/^\d$/.test(event.key)) {
    return { type: 'digit', digit: event.key };
  }

  if (event.key === '.') {
    return { type: 'decimal' };
  }

  const operator = operatorMap[event.key];
  if (operator) {
    return { type: 'operator', operator };
  }

  if (event.key === 'Enter' || event.key === '=') {
    return { type: 'equals' };
  }

  if (event.key === '%') {
    return { type: 'percent' };
  }

  if (event.key === 'Backspace') {
    return { type: 'backspace' };
  }

  if (event.key === 'Delete') {
    return { type: 'clear' };
  }

  if (event.key === 'Escape') {
    return { type: 'all-clear' };
  }

  if (event.key === 'F9' || event.key.toLowerCase() === 'n') {
    return { type: 'toggle-sign' };
  }

  return null;
};

export interface CalculatorAppProps {
  isActive?: boolean;
}

export function CalculatorApp({ isActive = true }: CalculatorAppProps) {
  const [state, dispatch] = useReducer(reduceCalculatorState, undefined, createInitialCalculatorState);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = keyToAction(event);
      if (!action) {
        return;
      }

      event.preventDefault();
      dispatch(action);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive]);

  const clearLabel = state.display === '0' && !state.error ? 'AC' : 'C';
  const clearAction: CalculatorAction = clearLabel === 'AC' ? { type: 'all-clear' } : { type: 'clear' };

  return (
    <div
      className="calculator-app"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 180px',
        height: '100%',
        minHeight: 0,
        background: 'linear-gradient(180deg, rgba(28,34,48,0.98), rgba(18,22,33,0.98))',
        color: '#f8fafc',
        overflow: 'hidden',
      }}
    >
      <section className="calculator-main" style={{ display: 'flex', flexDirection: 'column', padding: 22, gap: 18 }}>
        <header className="calculator-display" style={{ display: 'grid', gap: 10 }}>
          <div
            style={{
              borderRadius: 24,
              padding: 18,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.05))',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
            }}
          >
            <p style={{ margin: 0, minHeight: 20, fontSize: 13, color: state.error ? '#fca5a5' : '#cbd5e1' }}>
              {state.error ?? state.expressionLabel}
            </p>
            <p
              style={{
                margin: '12px 0 0',
                textAlign: 'right',
                fontSize: 46,
                fontWeight: 800,
                letterSpacing: '-0.05em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {state.display}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, fontSize: 12, color: '#94a3b8' }}>
            <span>Keyboard: `0-9`, `+`, `-`, `*`, `/`, `%`, `Enter`</span>
            <span>Sign toggle: `F9` or `N`</span>
          </div>
        </header>

        <div className="calculator-keypad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, flex: 1 }}>
          <button type="button" style={neutralButtonStyle} onClick={() => dispatch(clearAction)}>
            {clearLabel}
          </button>
          <button type="button" style={neutralButtonStyle} onClick={() => dispatch({ type: 'toggle-sign' })}>
            +/-
          </button>
          <button type="button" style={neutralButtonStyle} onClick={() => dispatch({ type: 'percent' })}>
            <Percent size={22} />
          </button>
          <button type="button" style={operatorButtonStyle} onClick={() => dispatch({ type: 'operator', operator: '÷' })}>
            <Divide size={24} />
          </button>

          {['7', '8', '9'].map((digit) => (
            <button key={digit} type="button" style={digitButtonStyle} onClick={() => dispatch({ type: 'digit', digit })}>
              {digit}
            </button>
          ))}
          <button type="button" style={operatorButtonStyle} onClick={() => dispatch({ type: 'operator', operator: '×' })}>
            <X size={24} />
          </button>

          {['4', '5', '6'].map((digit) => (
            <button key={digit} type="button" style={digitButtonStyle} onClick={() => dispatch({ type: 'digit', digit })}>
              {digit}
            </button>
          ))}
          <button type="button" style={operatorButtonStyle} onClick={() => dispatch({ type: 'operator', operator: '-' })}>
            <Minus size={24} />
          </button>

          {['1', '2', '3'].map((digit) => (
            <button key={digit} type="button" style={digitButtonStyle} onClick={() => dispatch({ type: 'digit', digit })}>
              {digit}
            </button>
          ))}
          <button type="button" style={operatorButtonStyle} onClick={() => dispatch({ type: 'operator', operator: '+' })}>
            <Plus size={24} />
          </button>

          <button type="button" style={neutralButtonStyle} onClick={() => dispatch({ type: 'backspace' })}>
            <Delete size={22} />
          </button>
          <button type="button" style={digitButtonStyle} onClick={() => dispatch({ type: 'digit', digit: '0' })}>
            0
          </button>
          <button type="button" style={digitButtonStyle} onClick={() => dispatch({ type: 'decimal' })}>
            .
          </button>
          <button type="button" style={operatorButtonStyle} onClick={() => dispatch({ type: 'equals' })}>
            =
          </button>
        </div>
      </section>

      <aside
        className="calculator-history"
        style={{
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(10, 14, 24, 0.72)',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
            History
          </p>
          <h3 style={{ margin: '8px 0 0', fontSize: 20, fontWeight: 800, letterSpacing: '-0.03em' }}>Recent Results</h3>
        </div>

        <div style={{ display: 'grid', gap: 10, overflow: 'auto' }}>
          {state.history.length === 0 ? (
            <div
              style={{
                borderRadius: 18,
                padding: 16,
                background: 'rgba(255,255,255,0.04)',
                color: '#94a3b8',
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              Calculations appear here after `=` or when an invalid divide is blocked.
            </div>
          ) : (
            state.history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => dispatch({ type: 'restore-history', entry })}
                className={`calculator-history-entry${entry.isError ? ' is-error' : ''}`}
                style={{
                  display: 'grid',
                  gap: 6,
                  borderRadius: 18,
                  border: '1px solid rgba(255,255,255,0.06)',
                  background: entry.isError ? 'rgba(127, 29, 29, 0.3)' : 'rgba(255,255,255,0.04)',
                  padding: 14,
                  color: '#f8fafc',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 12, color: '#cbd5e1' }}>{entry.expression}</span>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{entry.result}</span>
              </button>
            ))
          )}
        </div>

        <div
          className="calculator-legend"
          style={{
            marginTop: 'auto',
            borderRadius: 18,
            padding: 14,
            background: 'rgba(255,255,255,0.04)',
            fontSize: 12,
            color: '#94a3b8',
            lineHeight: 1.6,
          }}
        >
          Continuous chaining is supported: press an operator after a result to keep calculating, or press `=` again to repeat the last operation.
        </div>
      </aside>
    </div>
  );
}

export default CalculatorApp;
