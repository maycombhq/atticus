import type { ScreenDef } from "../app/screens.js";
import { Panel } from "../app/ui.js";
import { COPY } from "../copy.js";

const T = COPY.notBuilt;

/** Screens still being built say so plainly and point at the command that does the same today. */
export function NotBuilt({ screen }: { screen: ScreenDef }) {
  return (
    <Panel title={screen.label}>
      <p style={{ margin: 0, color: "var(--text-2)", lineHeight: 1.6 }}>
        {T.thisScreenIsBeing}
        <code className="mono">{T.atticusHelp}</code> {T.toFindTheCommand}
      </p>
    </Panel>
  );
}
