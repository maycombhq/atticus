import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import { CopyButton } from "../run/shared.js";
import { Citation, EvidenceProvider } from "../../app/evidence.js";
import { sequence, targetSequence, type Lane, type Row, type Sequence } from "./model.js";
import "./flows.css";

const T = COPY.flowsScreen;

/**
 * The Flows screen (ADR 0092): a repo's spec flows (ADR 0079), and the picked one drawn as a
 * sequence of steps across lanes. It reads the specs API only; it changes nothing. A call that
 * the estate pass joined links to the flow it starts, in whichever repo that is. Loops and
 * retries are frames around the steps they repeat, and a change's target flows are drawn with
 * each step marked added, changed or removed (ADR 0095).
 */

const C = COPY.flows;

export const flowHref = (repo: string, flow?: string) =>
  `#/flows?repo=${encodeURIComponent(repo)}${flow ? `&flow=${encodeURIComponent(flow)}` : ""}`;

export const targetHref = (change: string, flow?: string) =>
  `#/flows?change=${encodeURIComponent(change)}${flow ? `&flow=${encodeURIComponent(flow)}` : ""}`;

const kindWord = (k: string) => C.kinds[k] ?? k;

/**
 * A citation (ADR 0124 addendum D-app, F3): its file and line on a button; hover or focus shows
 * the quote and who checked the fact, and pressing it opens Correct this. The repo is the flow's.
 */
function Cite({ at, repo }: { at: string; repo?: string | undefined }) {
  return <Citation repo={repo} at={at} />;
}

function Confirmed({ by }: { by: string | undefined }) {
  return by ? (
    <span className="seq-ok">
      <span aria-hidden="true">✓ </span>
      {C.confirmed[by] ?? by}
    </span>
  ) : (
    <span className="seq-unsure">
      <span aria-hidden="true">○ </span>
      {C.notConfirmed}
    </span>
  );
}

function Step({
  r,
  lanes,
  now,
  repo,
}: {
  r: Row;
  lanes: Lane[];
  now: boolean;
  repo?: string | undefined;
}) {
  // The step a link points at is scrolled to and marked.
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (now) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [now]);
  const col = (id: string) => lanes.findIndex((l) => l.id === id) + 1;
  const from = col(r.from);
  const to = col(r.to);
  // What starts the flow is drawn in the caller's lane; every step in the flow's own.
  const box = r.n === 0 ? from : col("self");
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const span = hi - lo + 1;
  const toLane = lanes[to - 1]!;
  return (
    <li
      ref={ref}
      className={`seq-row${now ? " seq-now" : ""}`}
      {...(now ? { "aria-current": "step" as const } : {})}
    >
      {r.frames.map((f) => (
        <span
          key={f.depth}
          className={`seq-frame ${f.kind}${f.first ? " first" : ""}${f.last ? " last" : ""}`}
          style={{ "--depth": f.depth } as CSSProperties}
          aria-hidden="true"
        >
          {f.first && (
            <span className="seq-frame-label">{C.frame(f.kind, f.repeats.from, f.repeats.to)}</span>
          )}
        </span>
      ))}
      {lanes.map((l, i) => (
        <span key={l.id} className="seq-life" style={{ gridColumn: i + 1 }} aria-hidden="true" />
      ))}
      {from !== to && (
        <span
          className={`seq-arrow ${to > from ? "right" : "left"}${r.back ? " back" : ""}`}
          style={{ gridColumn: `${lo} / ${hi + 1}`, "--span": span } as CSSProperties}
          aria-hidden="true"
        >
          {r.label && <em>{r.label}</em>}
        </span>
      )}
      <div
        className={`seq-box k-${r.kind}${r.mark ? ` m-${r.mark}` : ""}`}
        style={{ gridColumn: box }}
      >
        <div className="seq-top">
          <span className="seq-n">{r.shown}</span>
          <span className="seq-kind">{kindWord(r.kind)}</span>
          {r.mark && <span className={`seq-mark m-${r.mark}`}>{C.marks[r.mark]}</span>}
        </div>
        <p className="seq-what">{r.what}</p>
        {r.was && <p className="seq-was">{C.was(r.was)}</p>}
        {r.why && <p className="seq-why">{r.why}</p>}
        {from !== to && (
          <p className="sr">
            {r.back ? C.backTo(toLane.label) : C.goesTo(r.label ?? toLane.label, toLane.label)}
          </p>
        )}
        {r.fields.length > 0 && (
          <ul className="seq-fields">
            {r.fields.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        {r.cite && (
          <p className="seq-cite">
            <Cite at={r.cite} repo={repo} />
            {r.more > 0 && <span> {C.more(r.more)}</span>}
          </p>
        )}
        {r.n > 0 && r.mark !== "added" && <Confirmed by={r.confirmedBy} />}
        {r.opens && (
          <a className="seq-opens" href={flowHref(r.opens.repo, r.opens.flow)}>
            {C.opens(r.opens.name ?? r.opens.flow, r.opens.repo)}
          </a>
        )}
        {r.unjoined && <p className="seq-unjoined">{C.unjoined(r.unjoined)}</p>}
      </div>
    </li>
  );
}

export function SequenceDiagram({
  seq,
  name,
  current,
  hideErrors,
  repo,
}: {
  seq: Sequence;
  name?: string;
  /** The repo the citations are in, so each shows its fact's quote (F3). */
  repo?: string | undefined;
  /** A target flow lists no error paths of its own. */
  hideErrors?: boolean;
  /** The step a link points at (?step=), 0 for the start. */
  current?: number;
}) {
  const depth = seq.frames.reduce((m, f) => Math.max(m, f.depth + 1), 0);
  const cols = { "--lanes": seq.lanes.length, "--frames": depth } as CSSProperties;
  return (
    <div className="seq-wrap">
      {/* A wide flow scrolls sideways: a keyboard reaches and scrolls it too (WCAG 2.1.1). */}
      <div
        className="seq"
        style={cols}
        tabIndex={0}
        role="region"
        aria-label={C.diagram(name ?? T.thisFlow)}
      >
        <div className="seq-row seq-head" aria-hidden="true">
          {seq.lanes.map((l, i) => (
            <div
              key={l.id}
              className={`seq-lane ${l.kind}${l.isNew ? " new" : ""}`}
              style={{ gridColumn: i + 1 }}
            >
              <strong>{l.label}</strong>
              <small>
                {C.lanes[l.kind]}
                {l.isNew ? ` · ${C.newLane}` : ""}
              </small>
            </div>
          ))}
        </div>
        <ol className="seq-steps" aria-label={C.diagram(name ?? T.thisFlow)}>
          {seq.rows.map((r) => (
            <Step key={r.n} r={r} lanes={seq.lanes} now={r.n === current} repo={repo} />
          ))}
        </ol>
      </div>
      {!hideErrors && <h3 className="h seq-h">{C.errorsTitle}</h3>}
      {hideErrors ? null : seq.errors.length ? (
        <ul className="seq-errors">
          {seq.errors.map((e, i) => (
            <li key={i}>
              <span>{e.when}</span> <span aria-hidden="true">→</span> <strong>{e.then}</strong>
              {e.cite && <Cite at={e.cite} repo={repo} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{C.noErrors}</p>
      )}
    </div>
  );
}

const matches = (f: Api.SpecViewT["flows"][number], q: string) => {
  const t = q.trim().toLowerCase();
  return !t || [f.name, f.id, f.trigger.what].some((x) => x.toLowerCase().includes(t));
};

export function FlowList(p: { spec: Api.SpecViewT; filter: string; current: string | undefined }) {
  const shown = p.spec.flows.filter((f) => matches(f, p.filter));
  return (
    <div className="stack">
      {p.spec.flows.length === 0 ? (
        <div className="state">{C.noFlows}</div>
      ) : shown.length === 0 ? (
        <div className="state">{C.noMatch}</div>
      ) : (
        <ul className="flow-list">
          {shown.map((f) => (
            <li key={f.id}>
              <a
                href={flowHref(p.spec.repo, f.id)}
                aria-current={f.id === p.current ? "true" : undefined}
              >
                <span className="flow-name">{f.name}</span>
                <span className="flow-trigger">
                  <span className="seq-kind">{kindWord(f.trigger.kind)}</span> {f.trigger.what}
                </span>
                <span className="flow-counts">{C.counts(f.steps, f.confirmed)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {p.spec.problems.length > 0 && (
        <div className="state error">
          {C.unreadable}
          <ul>
            {p.spec.problems.map((x) => (
              <li key={x.file}>
                <code>{x.file}</code>: {x.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FlowDetail({ repo, flow, step }: { repo: string; flow: string; step?: number }) {
  const v = useApi<Api.FlowViewT>(
    `/api/specs/${encodeURIComponent(repo)}/flows/${encodeURIComponent(flow)}`,
  );
  useLiveEvents((e) => {
    if (e.type === "file.changed" && typeof e.path === "string" && e.path.includes("specs"))
      v.reload();
  });
  return (
    <View of={v}>
      {(d) => {
        const seq = sequence(d);
        return (
          <div className="stack">
            <h2 className="h">{d.flow.name}</h2>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="hud">{C.file}</span>
              <code>{d.file}</code>
              <CopyButton text={d.file} label={C.copyFile} />
            </div>
            {d.calledBy.length > 0 && (
              <p>
                {C.calledBy}:{" "}
                {d.calledBy.map((c, i) => (
                  <span key={`${c.flow}.${c.step}`}>
                    {i > 0 && ", "}
                    <a href={flowHref(c.repo, c.flow)}>{c.name ?? c.flow}</a> ({c.repo})
                  </span>
                ))}
              </p>
            )}
            {!d.joined && <p className="muted">{C.notJoined}</p>}
            {seq.gaps.map((g) => (
              <p key={g} className="seq-unjoined">
                {g}
              </p>
            ))}
            <SequenceDiagram
              seq={seq}
              name={d.flow.name}
              repo={repo}
              {...(step !== undefined ? { current: step } : {})}
            />
          </div>
        );
      }}
    </View>
  );
}

function RepoFlows(p: {
  repo: string;
  flow: string | undefined;
  q: string | undefined;
  step: number | undefined;
}) {
  const { repo, flow } = p;
  const spec = useApi<Api.SpecViewT>(`/api/specs/${encodeURIComponent(repo)}`);
  // ?q= (from @atticus /diagram <repo> <words>) starts the search.
  const [filter, setFilter] = useState(p.q ?? "");
  return (
    <div className="flows-grid">
      <Panel title={C.listTitle}>
        <label className="stack" style={{ gap: 4, marginBottom: 10 }}>
          <span className="hud">{C.filter}</span>
          <input
            id="flow-filter"
            type="search"
            placeholder={C.filterHint}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <View of={spec}>{(d) => <FlowList spec={d} filter={filter} current={flow} />}</View>
      </Panel>
      <Panel>
        {flow ? (
          <FlowDetail repo={repo} flow={flow} {...(p.step !== undefined ? { step: p.step } : {})} />
        ) : (
          <div className="state">{C.pick}</div>
        )}
      </Panel>
    </div>
  );
}

export function TargetList(p: { list: Api.TargetFlowListT; current: string | undefined }) {
  return (
    <div className="stack">
      {p.list.flows.length === 0 ? (
        <div className="state">{C.noTargets(p.list.change)}</div>
      ) : (
        <ul className="flow-list">
          {p.list.flows.map((f) => (
            <li key={f.flow}>
              <a
                href={targetHref(p.list.change, f.flow)}
                aria-current={f.flow === p.current ? "true" : undefined}
              >
                <span className="flow-name">{f.name}</span>
                <span className="flow-trigger">
                  <span className={`seq-kind d-${f.change}`}>{C.deltaKinds[f.change]}</span>{" "}
                  {f.repo}
                </span>
                <span className="flow-counts">{C.targetCounts(f.added, f.changed, f.removed)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {p.list.problems.length > 0 && (
        <div className="state error">
          {C.unreadable}
          <ul>
            {p.list.problems.map((x) => (
              <li key={x}>
                <code>{x}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TargetDetail({ change, flow }: { change: string; flow: string }) {
  const v = useApi<Api.TargetFlowViewT>(
    `/api/changes/${encodeURIComponent(change)}/target-flows/${encodeURIComponent(flow)}`,
  );
  useLiveEvents((e) => {
    if (e.type === "file.changed" && typeof e.path === "string" && e.path.includes("changes"))
      v.reload();
  });
  return (
    <View of={v}>
      {(d) => {
        const seq = targetSequence(d);
        return (
          <div className="stack">
            <h2 className="h">{d.name}</h2>
            <p>
              <span className={`seq-kind d-${d.delta}`}>{C.deltaKinds[d.delta]}</span>{" "}
              {C.targetCounts(d.counts.added, d.counts.changed, d.counts.removed)}.{" "}
              {d.delta !== "new" && <a href={flowHref(d.repo, d.flow)}>{d.flow}</a>}
            </p>
            <p>
              <span className="hud">{C.whyChange}</span> {d.why}
            </p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="hud">{C.file}</span>
              <code>{d.file}</code>
              <CopyButton text={d.file} label={C.copyFile} />
            </div>
            {[...d.problems, ...seq.gaps].map((g) => (
              <p key={g} className="seq-unjoined">
                {g}
              </p>
            ))}
            <SequenceDiagram seq={seq} name={d.name} repo={d.repo} hideErrors />
          </div>
        );
      }}
    </View>
  );
}

function ChangeFlows({ change, flow }: { change: string; flow: string | undefined }) {
  const list = useApi<Api.TargetFlowListT>(
    `/api/changes/${encodeURIComponent(change)}/target-flows`,
  );
  return (
    <div className="flows-grid">
      <Panel title={C.targetsTitle}>
        <p className="muted" style={{ marginTop: 0 }}>
          {C.changeIntro}
        </p>
        <View of={list}>{(d) => <TargetList list={d} current={flow} />}</View>
      </Panel>
      <Panel>
        {flow ? (
          <TargetDetail change={change} flow={flow} />
        ) : (
          <div className="state">{C.pick}</div>
        )}
      </Panel>
    </div>
  );
}

/** The changes, for the picker: a change shows its target flows instead of a repo's flows. */
function ChangePicker(p: { list: Loaded<{ id: string; title: string }[]>; change?: string }) {
  if (p.list.state !== "ready" || p.list.data.length === 0) return null;
  return (
    <label className="row" style={{ gap: 8 }}>
      <span className="hud">{C.change}</span>
      <select
        id="flow-change"
        value={p.change ?? ""}
        onChange={(e) => (location.hash = e.target.value ? targetHref(e.target.value) : "#/flows")}
      >
        <option value="">{C.pickRepo}</option>
        {p.list.data.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Flows({ hash }: { hash: string }) {
  const list = useApi<Api.SpecListT>("/api/specs");
  const changes = useApi<{ id: string; title: string }[]>("/api/changes");
  const change = queryParam(hash, "change");
  const wanted = queryParam(hash, "repo");
  const flow = queryParam(hash, "flow");
  const q = queryParam(hash, "q");
  const stepParam = Number(queryParam(hash, "step"));
  const step = Number.isInteger(stepParam) && stepParam >= 0 ? stepParam : undefined;
  return (
    <EvidenceProvider>
      <div className="stack">
        <Panel title={C.title}>
          <p className="muted" style={{ marginTop: 0 }}>
            {C.intro}
          </p>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <ChangePicker list={changes} {...(change ? { change } : {})} />
            {!change && (
              <View of={list} empty={(d) => d.repos.length === 0} emptyText={C.noSpecs}>
                {(d) => {
                  const repo = wanted ?? d.repos[0]!.repo;
                  return (
                    <label className="row" style={{ gap: 8 }}>
                      <span className="hud">{C.repo}</span>
                      <select
                        id="flow-repo"
                        value={repo}
                        onChange={(e) => (location.hash = flowHref(e.target.value))}
                      >
                        {d.repos.map((r) => (
                          <option key={r.repo} value={r.repo}>
                            {r.repo} ({r.flows})
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }}
              </View>
            )}
          </div>
        </Panel>
        {change && <ChangeFlows change={change} flow={flow} key={change} />}
        {!change && list.state === "ready" && list.data.repos.length > 0 && (
          <RepoFlows
            repo={wanted ?? list.data.repos[0]!.repo}
            flow={flow}
            q={q}
            step={step}
            key={`${wanted}?${q}`}
          />
        )}
      </div>
    </EvidenceProvider>
  );
}
