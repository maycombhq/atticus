import { Component, type ReactNode } from "react";
import { COPY } from "../copy.js";

const T = COPY.boundary;

/** One screen that throws shows its own error state; the rest of the app keeps working. */
export class ScreenBoundary extends Component<
  { children: ReactNode; name: string },
  { error?: string }
> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override render() {
    if (this.state.error)
      return (
        <div className="bento">
          <section className="panel" style={{ gridColumn: "1 / -1" }} role="alert">
            <h2 className="h">{T.couldntBeShown(this.props.name)}</h2>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {T.somethingOnThisScreen(this.state.error)}
            </p>
          </section>
        </div>
      );
    return this.props.children;
  }
}

/** The whole app: a throw in the shell itself (menu, tabs, palette) shows a way home, not a blank page. */
export class AppBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override render() {
    if (this.state.error)
      return (
        <main className="bento" style={{ padding: 24 }}>
          <section className="panel" style={{ gridColumn: "1 / -1" }} role="alert">
            <h2 className="h">{T.appCouldntBeShown}</h2>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {T.somethingInTheApp(this.state.error)}
            </p>
            <p style={{ margin: "12px 0 0" }}>
              <a
                href="#/home"
                className="btn"
                onClick={() => {
                  location.hash = "#/home";
                  this.setState({ error: undefined });
                }}
              >
                {T.goHome}
              </a>
            </p>
          </section>
        </main>
      );
    return this.props.children;
  }
}
