import { Panel } from "../../app/ui.js";
import { COPY } from "../../copy.js";

const G = COPY.glossary;

/** What the words mean (WP5.1): Atticus's own words, each in one plain sentence. */
export function Words() {
  return (
    <Panel title={G.title}>
      <p className="muted">{G.intro}</p>
      <dl className="words">
        {G.terms.map((t) => (
          <div key={t.term} id={`word-${t.term.replace(/ /g, "-")}`}>
            <dt>
              <strong>{t.term}</strong>
            </dt>
            <dd style={{ margin: "2px 0 10px" }}>{t.says}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
