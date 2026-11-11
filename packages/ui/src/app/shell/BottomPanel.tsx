import { ActivityConsole, ActivityStrip } from "../activity.js";

/**
 * The bottom panel (ADR 0194), under the page. A first cut: what runs (the strip) and the
 * Console (ADR 0187), as the classic layout has them, so nothing is lost; the panel with its own
 * tabs replaces it. `open` and `onToggle` are the shell's: whether the panel is open.
 */
export function BottomPanel(props: { open: boolean; onToggle: () => void }) {
  void props;
  return (
    <div className="sh-bottom">
      <ActivityStrip />
      <ActivityConsole />
    </div>
  );
}
