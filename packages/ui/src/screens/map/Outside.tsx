import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import { CopyButton } from "../run/shared.js";

/**
 * Map › Outside systems (plan item O4, ADR 0149): one page per system no estate repo belongs to
 * (a vendor, another team's). Who calls it, the operations its intaken spec publishes with how
 * many calls reach each, the calls that match nothing in that spec, and its open questions; a
 * system with no spec says how to add one. Another team's system shows the map that team shares
 * (ADR 0160, O3): their entries with the calls that reach each, or how to import it. `GET
 * /api/outside` reads files only; the app runs nothing.
 */

const O = COPY.outside;
type System = Api.OutsideSystemViewT;
type Call = Api.OutsideCallViewT;

export const outsideHash = (id: string) => `#/outside?system=${encodeURIComponent(id)}`;

export function OutsidePicker(p: { systems: readonly System[]; current: string | undefined }) {
  return (
    <nav aria-label={O.pick}>
      <ul
        className="row"
        style={{ gap: 6, flexWrap: "wrap", listStyle: "none", padding: 0, margin: 0 }}
      >
        {p.systems.map((s) => (
          <li key={s.id}>
            <a
              className="chip"
              href={outsideHash(s.id)}
              aria-current={s.id === p.current ? "page" : undefined}
            >
              {s.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const callText = (c: Call) => [c.method, c.path].filter(Boolean).join(" ") || (c.fact ?? "");

function Cmd({ text }: { text: string }) {
  return (
    <div className="work-cmd">
      <code className="mono">{text}</code>
      <CopyButton text={text} label={O.copy(text)} />
    </div>
  );
}

function CallList({ calls, extra }: { calls: readonly Call[]; extra: (c: Call) => string }) {
  return (
    <ul className="ev-list" style={{ margin: 0 }}>
      {calls.map((c) => (
        <li key={`${c.repo}|${c.at}`}>
          <code className="mono">{callText(c)}</code> · {c.repo}{" "}
          <code className="mono">{c.at}</code> · {extra(c)}
        </li>
      ))}
    </ul>
  );
}

/** One outside system's page, from its view, so tests can render it. */
export function OutsideSystemPanels({ system: s }: { system: System }) {
  const id = `outside-${s.id}`;
  return (
    <>
      <Panel title={s.name} span="1 / -1" labelledBy={`${id}-name`}>
        <p className="work-say" style={{ margin: 0 }}>
          {O.boundary[s.boundary] ?? s.boundary}
          {s.owner ? ` · ${O.owner(s.owner)}` : ""}
          {s.aliases.length ? ` · ${O.aliases(s.aliases.join(", "))}` : ""}
        </p>
      </Panel>
      <Panel title={O.callers} span="1 / -1" labelledBy={`${id}-callers`}>
        {s.callers.length ? (
          <table className="run-table">
            <caption className="sr">{O.callers}</caption>
            <thead>
              <tr>
                <th scope="col">{O.callerCols.from}</th>
                <th scope="col">{O.callerCols.call}</th>
                <th scope="col">{O.callerCols.line}</th>
                <th scope="col">{O.callerCols.operation}</th>
                <th scope="col">{O.callerCols.seen}</th>
              </tr>
            </thead>
            <tbody>
              {s.callers.map((c) => (
                <tr key={`${c.repo}|${c.at}`}>
                  <td>
                    {c.repo}
                    {c.component && c.component !== c.repo ? ` (${c.component})` : ""}
                  </td>
                  <td>
                    <code className="mono">{callText(c)}</code>
                    {c.through && (
                      <span className="work-say"> {O.through(c.through.repo, c.through.at)}</span>
                    )}
                  </td>
                  <td>
                    <code className="mono">{c.at}</code>
                  </td>
                  <td>
                    {c.operation ? <code className="mono">{c.operation}</code> : O.noOperation}
                  </td>
                  <td>{c.seen.map((x) => O.seen[x] ?? x).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="work-say">{O.noCallers}</p>
        )}
      </Panel>
      <Panel title={O.operations} span="span 6" labelledBy={`${id}-ops`}>
        {s.spec ? (
          <>
            <p className="work-say">{O.specFrom(s.spec.path, s.spec.title, s.spec.version)}</p>
            <table className="run-table">
              <caption className="sr">{O.operations}</caption>
              <thead>
                <tr>
                  <th scope="col">{O.opCols.op}</th>
                  <th scope="col">{O.opCols.line}</th>
                  <th scope="col">{O.opCols.calls}</th>
                </tr>
              </thead>
              <tbody>
                {s.spec.operations.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <code className="mono">{`${o.method} ${o.path}`}</code>
                    </td>
                    <td>
                      <code className="mono">{o.cite}</code>
                    </td>
                    <td>{o.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <p className="work-say">{O.noSpec}</p>
            {(s.addSpec ?? []).map((c) => (
              <Cmd key={c} text={c} />
            ))}
            <p className="work-say">{O.noSpecWhy}</p>
          </>
        )}
      </Panel>
      <Panel title={O.unmatched} span="span 6" labelledBy={`${id}-unmatched`}>
        {s.unmatched.length ? (
          <CallList calls={s.unmatched} extra={(c) => (c as Call & { message: string }).message} />
        ) : (
          <p className="work-say">{s.spec ? O.noUnmatched : O.noSpec}</p>
        )}
        {s.ambiguous.length > 0 && (
          <>
            <h3 className="hud">{O.ambiguous}</h3>
            <CallList
              calls={s.ambiguous}
              extra={(c) =>
                O.ambiguousOf((c as Call & { candidates: string[] }).candidates.join(", "))
              }
            />
          </>
        )}
      </Panel>
      {(s.shared || s.boundary === "internal") && (
        <Panel title={O.shared} span="1 / -1" labelledBy={`${id}-shared`}>
          {s.shared ? (
            <>
              <p className="work-say">
                {O.sharedFrom(s.shared.name, s.shared.commit, s.shared.importedAt)}
              </p>
              <table className="run-table">
                <caption className="sr">{O.shared}</caption>
                <thead>
                  <tr>
                    <th scope="col">{O.sharedCols.entry}</th>
                    <th scope="col">{O.sharedCols.repo}</th>
                    <th scope="col">{O.sharedCols.line}</th>
                    <th scope="col">{O.sharedCols.calls}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.shared.entries.map((e) => (
                    <tr key={`${e.repo}|${e.fact}`}>
                      <td>
                        <code className="mono">{[e.method, e.path].filter(Boolean).join(" ")}</code>
                      </td>
                      <td>
                        {e.repo}
                        {e.component !== e.repo ? ` (${e.component})` : ""}
                      </td>
                      <td>
                        <code className="mono">{e.at}</code>
                      </td>
                      <td>{e.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="hud">{O.sharedUnmatched}</h3>
              {s.shared.unmatched.length ? (
                <CallList
                  calls={s.shared.unmatched}
                  extra={(c) => (c as Call & { message: string }).message}
                />
              ) : (
                <p className="work-say">{O.noSharedUnmatched}</p>
              )}
            </>
          ) : (
            <>
              <p className="work-say">{O.noShared}</p>
              <Cmd text={O.sharedImport(s.id)} />
            </>
          )}
        </Panel>
      )}
      {(s.spec || s.contracts) && (
        // ADR 0164: the calls to it against its newest spec; what that spec brought, marked.
        <Panel title={O.contracts} span="1 / -1" labelledBy={`${id}-contracts`}>
          <p className="work-say">{O.contractsIntro}</p>
          {s.contracts?.findings.length ? (
            <ul className="ev-list" style={{ margin: 0 }}>
              {s.contracts.findings.map((f) => (
                <li key={f.id}>
                  <span className={`chip ${f.status === "mismatch" ? "warn" : ""}`}>
                    {COPY.mismatches.status[f.status]}
                  </span>{" "}
                  {s.contracts?.new?.includes(f.id) && (
                    <span className="chip warn">{O.newWithSpec}</span>
                  )}{" "}
                  {f.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="work-say">{O.noContracts}</p>
          )}
        </Panel>
      )}
      <Panel title={O.questions} span="1 / -1" labelledBy={`${id}-questions`}>
        {s.questions.length ? (
          <ul className="ev-list" style={{ margin: 0 }}>
            {s.questions.map((q) => (
              <li key={q.id}>
                {q.question} <span className="muted">({q.repo})</span>{" "}
                <a href={`#/questions/${q.id}`}>{O.answer}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="work-say">{O.noQuestions}</p>
        )}
      </Panel>
    </>
  );
}

export function Outside({ hash }: { hash: string }) {
  const view = useApi<Api.OutsideViewT>("/api/outside");
  useReloadOnFiles(view);
  const asked = queryParam(hash, "system");
  const systems = view.state === "ready" ? view.data.systems : [];
  const current = asked ?? systems[0]?.id;
  const system = systems.find((s) => s.id === current);
  return (
    <div className="bento">
      <Panel title={O.title} span="1 / -1">
        <p className="work-say">{O.intro}</p>
        <View of={view} empty={(d) => d.systems.length === 0} emptyText={O.empty}>
          {(d) => (
            <>
              <OutsidePicker systems={d.systems} current={current} />
              {asked && !system && (
                <p role="alert" className="state error">
                  {O.noSuchSystem(asked)}
                </p>
              )}
              {d.notes.length > 0 && (
                <details>
                  <summary>{O.notes}</summary>
                  <ul className="ev-list">
                    {d.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </View>
      </Panel>
      {system && <OutsideSystemPanels system={system} />}
    </div>
  );
}
