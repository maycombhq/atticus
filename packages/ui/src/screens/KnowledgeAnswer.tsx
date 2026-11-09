import type { Api } from "@maycombhq/core";
import { COPY } from "../copy.js";
import { CopyButton } from "./run/shared.js";

/**
 * ADR 0191 (app-only audit): Ask Atticus searched only the catalog, so "How do I request a
 * firewall rule…" got "No record in the catalog is named…". The answer now carries what the
 * organisation's knowledge says: the knowledge items it matches, each with the quote it rests on,
 * and the passages of the wikis' snapshots and inputs/ files, each with where it is from. Nothing
 * is worded by AI here; the step that has your assistant word an answer from them is offered.
 */

const A = COPY.roleWork.ask;

export function KnowledgeAnswerBlock({ k }: { k: Api.KnowledgeAnswerViewT }) {
  const none = k.items.length === 0 && k.passages.length === 0;
  return (
    <section aria-labelledby="ask-knowledge" className="stack" style={{ gap: 8 }}>
      <h3 id="ask-knowledge" className="hud" style={{ margin: 0 }}>
        {A.knowledge}
      </h3>
      {none ? (
        <p className="muted" style={{ margin: 0 }}>
          {A.none}
        </p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {A.knowledgeIntro}
          </p>
          {k.items.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <h4 className="hud" style={{ margin: 0, fontSize: 10 }}>
                {A.items}
              </h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {k.items.map((i) => (
                  <li key={i.id} style={{ marginBottom: 6 }}>
                    <a href={`#/knowledge?item=${encodeURIComponent(i.id)}`}>{i.title}</a>
                    {i.quote && (
                      <>
                        <blockquote
                          style={{
                            margin: "2px 0",
                            paddingLeft: 10,
                            borderLeft: "2px solid var(--line-2)",
                          }}
                        >
                          {i.quote.text}
                        </blockquote>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {COPY.roleWork.passage.from(
                            i.quote.section ?? i.quote.page,
                            i.quote.source,
                          )}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {k.passages.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <h4 className="hud" style={{ margin: 0, fontSize: 10 }}>
                {A.passages}
              </h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {k.passages.map((p) => (
                  <li key={`${p.path}:${p.line}`} style={{ marginBottom: 8 }}>
                    <strong>{p.heading.split(" › ").at(-1) || p.page}</strong>{" "}
                    <span className="muted" style={{ fontSize: 12 }}>
                      {COPY.roleWork.passage.from(p.page, p.source)}
                    </span>
                    <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
                      {p.text}
                    </p>
                    <details>
                      <summary className="muted" style={{ fontSize: 11.5 }}>
                        {COPY.roleWork.passage.details}
                      </summary>
                      <code className="mono muted">
                        {p.path}:{p.line}
                      </code>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {A.askAi} <code className="mono">{k.command}</code>{" "}
            <CopyButton text={k.command} label={k.command} />
          </p>
        </>
      )}
    </section>
  );
}
