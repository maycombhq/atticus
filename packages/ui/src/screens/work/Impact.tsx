import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Command } from "./RunNext.js";

/**
 * A change's impact, as designed (ADR 0144, V1), on its Architecture tab: what its target flows
 * break, who each break reaches, the fields that stop crossing and the gateway routes to update,
 * each with its owner team. A guessed link says it may break and is never counted as a break; the
 * critic's rule asks about it. It reads; it runs nothing.
 */

const I = COPY.changeImpact;
type Owner = Api.ChangeImpactT["owners"][number]["owner"];

export const ownerWords = (o: Owner) =>
  "none" in o ? I.noTeam(o.none) : o.name ? `${o.team} (${o.name})` : o.team;

/** One change's impact. */
export function ImpactView({ i }: { i: Api.ChangeImpactT }) {
  if (!i.flows)
    return (
      <>
        <p>{I.noTargets(i.change)}</p>
        <Command text={`atticus change architecture ${i.change}`} label={COPY.runNext.copy} />
      </>
    );
  return (
    <>
      {i.items.length === 0 ? (
        <p>{I.nothing}</p>
      ) : (
        <>
          <p className="est-big">{I.counts(i.breaks, i.mayBreak, i.routes)}</p>
          {i.upstream && (i.upstream.breaks > 0 || i.upstream.mayBreak > 0) && (
            <p>{I.upstream(i.upstream.breaks, i.upstream.mayBreak)}</p>
          )}
          {i.items.map((it, n) => {
            const head = `impact-${n}`;
            return (
              <section key={`${it.flow}.${it.id ?? n}`} aria-labelledby={head} className="est-band">
                <h3 id={head} className="hud">
                  <span className="mono">{it.name}</span> <span className="muted">({it.flow})</span>
                </h3>
                <p className="muted" style={{ margin: "0 0 6px" }}>
                  {I.owned(ownerWords(it.owner))}
                </p>
                <p>
                  <strong>{I.why}:</strong> {it.why.join("; ")}
                </p>
                {it.fields.gone.length > 0 && (
                  <p>
                    <strong>{I.gone}:</strong>{" "}
                    <span className="mono">{it.fields.gone.join(", ")}</span>
                  </p>
                )}
                {it.fields.required.length > 0 && (
                  <p>
                    <strong>{I.required}:</strong>{" "}
                    <span className="mono">{it.fields.required.join(", ")}</span>
                  </p>
                )}
                {it.callers.length === 0 ? (
                  <p>{I.nobody}</p>
                ) : (
                  <table className="run-table">
                    <caption className="sr">{I.callersCaption(it.name)}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{I.col.who}</th>
                        <th scope="col">{I.col.verdict}</th>
                        <th scope="col">{I.col.owner}</th>
                        <th scope="col">{I.col.where}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {it.callers.map((c) => (
                        <tr key={c.component}>
                          <td className="mono">{c.component}</td>
                          <td>
                            {c.verdict === "breaks" ? (
                              <strong>{I.breaks}</strong>
                            ) : (
                              I.mayBreak(I.guessWords[c.guessed ?? ""] ?? "")
                            )}
                          </td>
                          <td>{ownerWords(c.owner)}</td>
                          <td className="mono">{[...c.at, ...c.flows, ...c.routes].join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(it.chain ?? []).length > 0 && (
                  <>
                    <h4 className="hud">{I.chain}</h4>
                    <table className="run-table">
                      <caption className="sr">{I.chainCaption(it.name)}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{I.chainCol.who}</th>
                          <th scope="col">{I.chainCol.via}</th>
                          <th scope="col">{I.chainCol.verdict}</th>
                          <th scope="col">{I.chainCol.owner}</th>
                          <th scope="col">{I.chainCol.where}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(it.chain ?? []).map((h) => {
                          const how = I.guessWords[h.guessed ?? ""] ?? "";
                          return (
                            <tr key={h.component}>
                              <td
                                className="mono"
                                style={{ paddingLeft: `${(h.depth - 1) * 14}px` }}
                              >
                                {h.component} <span className="sr">({I.depth(h.depth)})</span>
                              </td>
                              <td>
                                <span className="mono">{I.via(h.via)}</span>
                                {h.entries.length > 0 && (
                                  <span className="muted mono"> ({h.entries.join(", ")})</span>
                                )}
                              </td>
                              <td>
                                {h.verdict === "breaks" ? (
                                  <strong>{I.breaks}</strong>
                                ) : h.restsOn ? (
                                  I.restsOn(h.restsOn, how)
                                ) : (
                                  I.restsOwn(how)
                                )}
                              </td>
                              <td>{ownerWords(h.owner)}</td>
                              <td className="mono">
                                {[...h.at, ...h.flows, ...h.routes].join(", ")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}
                {it.capped && (
                  <p className="muted">
                    {I.capped(Math.max(...(it.chain ?? []).map((h) => h.depth)))}
                  </p>
                )}
                {[...it.callers, ...(it.chain ?? [])].some((c) => c.verdict === "may-break") && (
                  <p role="note" className="muted">
                    {I.confirm(i.rule)}
                  </p>
                )}
                {it.routes.length > 0 && (
                  <>
                    <h4 className="hud">{I.routes}</h4>
                    <ul>
                      {it.routes.map((r) => (
                        <li key={r.id}>
                          <span className="mono">{I.route(r.id, r.callers)}</span>{" "}
                          <span className="muted">
                            ({[r.proxy, r.basepath, r.repo].filter(Boolean).join(", ")}){" "}
                            {I.owned(ownerWords(r.owner))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            );
          })}
          <h3 className="hud">{I.teams}</h3>
          <ul>
            {i.owners.map((o) => (
              <li key={`${ownerWords(o.owner)}.${o.repos.join(",")}`}>
                {ownerWords(o.owner)}: <span className="mono">{o.repos.join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {i.problems.length > 0 && (
        <div role="note" className="cd-problems">
          <h3 className="hud">{I.problems}</h3>
          <ul>
            {i.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <Command text={I.command(i.change)} label={COPY.runNext.copy} />
    </>
  );
}

/** The panel on a change's Architecture tab. */
export function ChangeImpactPanel({ change }: { change: string }) {
  const impact = useApi<Api.ChangeImpactT>(`/api/changes/${encodeURIComponent(change)}/impact`);
  useLiveEvents((e) => {
    if (e.type === "file.changed") impact.reload();
  });
  return (
    <Panel title={I.title}>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {I.intro}
      </p>
      <View of={impact}>{(i) => <ImpactView i={i} />}</View>
    </Panel>
  );
}
