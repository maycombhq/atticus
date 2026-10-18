import { Component, type ReactNode } from "react";

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
            <h2 className="h">{this.props.name} couldn't be shown</h2>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Something on this screen failed: {this.state.error}. The other screens still work;
              reload to try again.
            </p>
          </section>
        </div>
      );
    return this.props.children;
  }
}
