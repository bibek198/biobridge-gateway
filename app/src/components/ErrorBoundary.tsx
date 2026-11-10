import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Dashboard panel crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="callout fail" role="alert">
            <div>
              <strong>This page hit an error and stopped updating.</strong>
              <div className="mono small">{this.state.error.message}</div>
              <div className="small">Other pages keep working. Navigate away and back to retry; details are in the browser console.</div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
