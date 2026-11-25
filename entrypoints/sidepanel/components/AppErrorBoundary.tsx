import { Component, StrictMode, type ComponentProps, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BuildMismatchNotice } from './BuildMismatchNotice';
import { errorMessage } from '../lib/notify';
import './AppErrorBoundary.css';

interface AppErrorBoundaryProps {
  children: ReactNode;
  label: string;
}

interface AppErrorBoundaryState {
  message?: string;
}

/**
 * A render failure must degrade to a recoverable surface rather than an empty
 * document, so the fallback reads no application state.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { message: errorMessage(error, 'An unexpected error occurred.') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Unable to render ${this.props.label}.`, error, info.componentStack);
  }

  override render() {
    if (this.state.message === undefined) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert">
        <p className="app-error-boundary__title">
          {this.props.label} stopped responding.
        </p>
        <p className="app-error-boundary__detail">{this.state.message}</p>
        <button
          className="app-error-boundary__action"
          onClick={() => location.reload()}
          type="button"
        >
          Reload
        </button>
      </div>
    );
  }
}

/** Renders a Hyper page into its root, with the error boundary and the stale build notice. */
export function mountApp(App: ComponentType, label: string, notice: ComponentProps<typeof BuildMismatchNotice>) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary label={label}>
        <App />
      </AppErrorBoundary>
      <BuildMismatchNotice {...notice} />
    </StrictMode>,
  );
}
