import { Component, type ReactNode } from 'react';

interface A2uiErrorBoundaryProps {
  readonly resetKey: object;
  readonly children: ReactNode;
}

interface A2uiErrorBoundaryState {
  readonly failed: boolean;
}

export function A2uiFailureFallback() {
  return (
    <section
      role="alert"
      aria-label="Agent interactive UI unavailable"
      style={{
        marginTop: 12,
        border: '1px solid rgba(255, 156, 156, 0.36)',
        borderRadius: 16,
        padding: 12,
        color: '#ffd4d4',
        background: 'rgba(225, 69, 75, 0.15)',
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      Agent 返回的交互界面无法安全呈现。本次界面已被隔离，对话和 AlSniper OS 仍可继续使用。
    </section>
  );
}

/** Contains model-authored A2UI failures inside the assistant surface. */
export class A2uiErrorBoundary extends Component<A2uiErrorBoundaryProps, A2uiErrorBoundaryState> {
  state: A2uiErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): A2uiErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: A2uiErrorBoundaryProps): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? <A2uiFailureFallback /> : this.props.children;
  }
}
