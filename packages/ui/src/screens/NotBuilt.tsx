import type { ScreenDef } from "../app/screens.js";
import { Panel } from "../app/ui.js";

/** Screens still being built say so plainly and point at the command that does the same today. */
export function NotBuilt({ screen }: { screen: ScreenDef }) {
  return (
    <Panel title={screen.label}>
      <p style={{ margin: 0, color: "var(--text-2)", lineHeight: 1.6 }}>
        This screen is being built. Everything it will show is already available from the command
        line: run <code className="mono">atticus --help</code> to find the command.
      </p>
    </Panel>
  );
}
