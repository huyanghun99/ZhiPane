import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}
interface State {
  error: Error | null;
}

// Isolates Excalidraw render failures so a crash never blanks the whole page.
export class ExcalidrawErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[Excalidraw] render failed:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="excalidraw-error">
          <p>白板加载失败：{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
