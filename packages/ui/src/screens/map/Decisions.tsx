import { useEffect, useState } from "react";
import type { Api } from "@maycombhq/core";
import type { Loaded } from "../../api/client.js";
import {
  AiChip,
  AiMark,
  DecidePaused,
  SplitCounts,
  UndoBatch,
  useDecisions,
  type Decision,
} from "../../app/decisions.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, setQueryParam } from "../know/common.js";

/**
 * Map › Decided by AI (ADR 0181 parts 1 to 3): what the AI decided that still stands, pairings and
 * answers, each with its chip, run, bar and lines, and Correct; the counts split three ways; the
 * batches, newest first, each one Undo away (asked first). Beside Trust, which audits them.
 */

const D = COPY.decisions;
const day = (at: string) => at.slice(0, 10);

/**
 * Ninth UX walk: where deciding happens here, as runtime.yaml allows the runs; nothing when
 * neither kind decides (the mode line says propose) or the server doesn't say.
 */
export function decideWhere(decide: Api.DecisionsViewT["decide"]): string | undefined {
  const on = decide.now.links === "auto" || decide.now.questions === "auto";
  const runs = decide.decideIn;
  if (!on || !runs) return undefined;
  const acp = runs.includes("copilot-acp");
  const handoff = runs.includes("hand-off");
  return acp && handoff
    ? D.decideIn.both
    : handoff
      ? D.decideIn.handoff
      : acp
        ? D.decideIn.acp
        : D.decideIn.none;
}

/** The batch's kind in words: by AI, a person's rule, or a person's correction alone. */
export const batchKindOf = (b: Api.DecisionBatchViewT): string =>
  b.kind === "ai"
    ? D.batchKind.ai!
    : b.correction?.rule
      ? D.batchKind.rule!
      : D.batchKind.correction!;

/** The decisions a filter keeps: one repo, one kind, or all. */
export function decisionsShown(
  items: readonly Decision[],
  f: { repo: string; kind: string },
): Decision[] {
  return items.filter((d) => (!f.repo || d.repo === f.repo) && (!f.kind || d.kind === f.kind));
}

function DecisionRow(p: { d: Decision; onOpen: (d: Decision) => void; onClose: () => void }) {
  const { d } = p;
  return (
    <li className="stack" style={{ gap: 4 }}>
      <p style={{ margin: 0 }}>
        <span className="hud">{D.kind[d.kind] ?? d.kind}</span> <span>{d.what}</span>
      </p>
      <p className="ev-say" style={{ margin: 0 }}>
        {D.decided(
          d.kind === "link" && d.to
            ? `${d.to.repo} ${`${d.to.method ?? ""} ${d.to.path}`.trim()}`
            : d.decided,
        )}
        {d.bar && ` ${D.because(D.bar[d.bar] ?? d.bar)}`}
      </p>
      {d.cites.length > 0 && (
        <p className="hud" style={{ margin: 0 }}>
          {D.restsOn}: <span className="mono">{d.cites.join(", ")}</span>
        </p>
      )}
      <AiMark item={d.item} run={d.run} onOpen={p.onOpen} onClose={p.onClose} />
    </li>
  );
}

/** The page from its loaded view, so tests can render every state. */
export function DecisionsPage(p: {
  of: Loaded<Api.DecisionsViewT> & { reload?: () => void };
  repo: string;
  kind: string;
  onRepo: (r: string) => void;
  onKind: (k: string) => void;
}) {
  // A decision being corrected stays listed (with its form and result) after the reload that
  // takes it off the AI's list, until the person closes it.
  const [held, setHeld] = useState<Record<string, Decision>>({});
  const hold = (d: Decision) => setHeld((h) => ({ ...h, [d.item]: d }));
  const release = (item: string) =>
    setHeld((h) => {
      const { [item]: _gone, ...rest } = h;
      return rest;
    });
  return (
    <div className="bento">
      <Panel title={D.title} span="1 / -1">
        <p className="work-why" style={{ marginTop: 0 }}>
          {D.intro}
        </p>
        <View of={p.of}>
          {(v) => {
            const live = [...v.links.items, ...v.questions.items];
            const items = [
              ...live,
              ...Object.values(held).filter((h) => !live.some((d) => d.item === h.item)),
            ];
            const repos = [...new Set([...items.map((d) => d.repo), ...(p.repo ? [p.repo] : [])])]
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b));
            const shown = decisionsShown(items, p);
            return (
              <div className="stack" style={{ gap: 12 }}>
                <DecidePaused decide={v.decide} />
                <p className="ev-say" style={{ margin: 0 }}>
                  {D.modeLine(
                    D.mode[v.decide.now.links] ?? v.decide.now.links,
                    D.mode[v.decide.now.questions] ?? v.decide.now.questions,
                  )}{" "}
                  {decideWhere(v.decide)} <a href="#/ai">{D.setUp}</a>
                </p>
                {/* Ninth UX walk: the catalog's counts are the map as last applied; the lines
                    standing now are said beside them when they differ. */}
                <SplitCounts counts={v.links.counts} what={D.counts.linksInMap} />
                {v.links.lines &&
                  (v.links.lines.byAi !== v.links.counts.byAi ||
                    v.links.lines.byPerson > v.links.counts.byPerson) && (
                    <p className="ev-say" style={{ margin: 0 }}>
                      {D.counts.lines(v.links.lines.byAi, v.links.lines.byPerson)}
                    </p>
                  )}
                <SplitCounts counts={v.questions.counts} what={D.counts.questions} />
                {v.problems.length > 0 && (
                  <div className="state error" role="alert">
                    <p style={{ margin: 0 }}>{D.problems}</p>
                    <ul style={{ margin: 0 }}>
                      {v.problems.map((x) => (
                        <li key={x.file}>
                          <span className="mono">{x.file}</span>: {x.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <section className="stack" aria-labelledby="decisions-items" style={{ gap: 8 }}>
                  <h3 id="decisions-items" className="hud" style={{ margin: 0 }}>
                    {D.itemsTitle}
                  </h3>
                  {items.length === 0 ? (
                    <div className="state">{D.itemsEmpty}</div>
                  ) : (
                    <>
                      <div
                        className="row"
                        style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
                      >
                        <div className="stack" style={{ gap: 4 }}>
                          <label htmlFor="decisions-repo" className="hud" style={{ fontSize: 10 }}>
                            {D.filterRepo}
                          </label>
                          <select
                            id="decisions-repo"
                            className="field"
                            value={p.repo}
                            onChange={(e) => p.onRepo(e.target.value)}
                          >
                            <option value="">{D.allRepos}</option>
                            {repos.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="stack" style={{ gap: 4 }}>
                          <label htmlFor="decisions-kind" className="hud" style={{ fontSize: 10 }}>
                            {D.filterKind}
                          </label>
                          <select
                            id="decisions-kind"
                            className="field"
                            value={p.kind}
                            onChange={(e) => p.onKind(e.target.value)}
                          >
                            <option value="">{D.allKinds}</option>
                            <option value="link">{D.kinds.link}</option>
                            <option value="question">{D.kinds.question}</option>
                          </select>
                        </div>
                        <p role="status" className="hud" style={{ margin: 0 }}>
                          {D.shown(shown.length, items.length)}
                        </p>
                      </div>
                      {shown.length === 0 ? (
                        <div className="state">{D.itemsFiltered}</div>
                      ) : (
                        <ul
                          className="stack"
                          aria-label={D.itemsCaption}
                          style={{ gap: 12, listStyle: "none", padding: 0, margin: 0 }}
                        >
                          {shown.map((d) => (
                            <DecisionRow
                              key={d.item}
                              d={d}
                              onOpen={hold}
                              onClose={() => release(d.item)}
                            />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>
                <section className="stack" aria-labelledby="decisions-batches" style={{ gap: 8 }}>
                  <h3 id="decisions-batches" className="hud" style={{ margin: 0 }}>
                    {D.batchesTitle}
                  </h3>
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {D.batchesIntro}
                  </p>
                  {v.batches.length === 0 ? (
                    <div className="state">{D.batchesEmpty}</div>
                  ) : (
                    <table className="run-table">
                      <caption className="sr">{D.batchesCaption}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{D.batchCol.batch}</th>
                          <th scope="col">{D.batchCol.by}</th>
                          <th scope="col">{D.batchCol.what}</th>
                          <th scope="col">{D.batchCol.undo}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.batches.map((b) => (
                          <tr key={b.id}>
                            <th scope="row" style={{ fontWeight: "normal" }}>
                              <code className="mono">{b.id}</code>
                              <div>
                                {b.kind === "ai" ? (
                                  <AiChip run={b.run} short />
                                ) : (
                                  <span className="chip done">{batchKindOf(b)}</span>
                                )}
                              </div>
                            </th>
                            <td>{D.batchBy(b.by, day(b.at))}</td>
                            <td>
                              {D.batchApplied(b.applied, b.reverted)}
                              {b.correction && (
                                <div className="muted">
                                  {D.batchFrom(b.correction.item, b.correction.answer)}
                                  {b.correction.rule && (
                                    <div className="mono">
                                      {D.batchRule(b.correction.rule.kind, b.correction.rule.match)}
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="hud">{D.record(b.file)}</div>
                            </td>
                            <td>
                              {b.undone ? (
                                <span className="chip dim">
                                  {D.undone(b.undone.by, day(b.undone.at))}
                                </span>
                              ) : (
                                <UndoBatch
                                  b={b}
                                  {...(p.of.reload ? { onDone: p.of.reload } : {})}
                                />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            );
          }}
        </View>
      </Panel>
    </div>
  );
}

/** Map › Decided by AI, with its filters in the address (?repo=, ?kind=). */
export function Decisions({ hash }: { hash: string }) {
  const ds = useDecisions();
  const [repo, setRepo] = useState(() => queryParam(hash, "repo") ?? "");
  const [kind, setKind] = useState(() => queryParam(hash, "kind") ?? "");
  useEffect(() => {
    setRepo(queryParam(hash, "repo") ?? "");
    setKind(queryParam(hash, "kind") ?? "");
  }, [hash]);
  const of: Loaded<Api.DecisionsViewT> & { reload?: () => void } = {
    ...(ds?.view ?? { state: "loading" }),
    ...(ds ? { reload: ds.reload } : {}),
  };
  return (
    <DecisionsPage
      of={of}
      repo={repo}
      kind={kind}
      onRepo={(r) => {
        setRepo(r);
        setQueryParam("decisions", "repo", r);
      }}
      onKind={(k) => {
        setKind(k);
        setQueryParam("decisions", "kind", k);
      }}
    />
  );
}
