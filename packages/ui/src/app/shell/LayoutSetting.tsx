import { COPY } from "../../copy.js";
import { Panel } from "../ui.js";
import { LAYOUTS, useLayout, type Layout } from "./layout.js";

const L = COPY.ide.layout;
const WHAT: Record<Layout, { name: string; what: string }> = {
  ide: { name: L.ide, what: L.ideWhat },
  classic: { name: L.classic, what: L.classicWhat },
};

/**
 * Settings › Layout (ADR 0194): the IDE layout or the classic one, for this browser. It applies
 * at once; Ctrl+K's "Switch to the classic layout" does the same.
 */
export function LayoutSetting() {
  const [layout, setLayout] = useLayout();
  return (
    <Panel title={L.title} meta={L.meta} span="span 12">
      <fieldset className="stack" style={{ gap: 8, border: 0, margin: 0, padding: 0 }}>
        <legend className="sr">{L.legend}</legend>
        {LAYOUTS.map((l) => (
          <label key={l} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input
              type="radio"
              name="layout"
              value={l}
              checked={layout === l}
              onChange={() => setLayout(l)}
            />
            <span className="stack" style={{ gap: 2 }}>
              <span style={{ fontSize: 13 }}>{WHAT[l].name}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {WHAT[l].what}
              </span>
            </span>
          </label>
        ))}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {L.kept}
        </p>
      </fieldset>
    </Panel>
  );
}
