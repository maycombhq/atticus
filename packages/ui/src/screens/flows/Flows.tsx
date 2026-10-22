import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import { CopyButton } from "../run/shared.js";
import { sequence, type Lane, type Row, type Sequence } from "./model.js";
import "./flows.css";

/**
 * The Flows screen (ADR 0092): a repo's spec flows (ADR 0079), and the picked one drawn as a
 * sequence of steps across lanes. It reads the specs API only; it changes nothing. A call that
 * the estate pass joined links to the flow it starts, in whichever repo that is.
 */

const C = COPY.flows;

export const flowHref = (repo: string, flow?: string) =>
  `#/flows?repo=${encodeURIComponent(repo)}${flow ? `&flow=${encodeURIComponent(flow)}` : ""}`;

const kindWord = (k: string) => C.kinds[k] ?? k;

/** A citation as its file name and line; the whole path is its title and its text for readers. */
function Cite({ at }: { at: string }) {
  const short = at.split("/").pop()!;
  return (
    <code title={at} aria-label={at}>
      {short}
    </code>
  );
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

function Step({ r, lanes, now }: { r: Row; lanes: Lane[]; now: boolean }) {
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
      <div className={`seq-box k-${r.kind}`} style={{ gridColumn: box }}>
        <div className="seq-top">
          <span className="seq-n">{r.n === 0 ? C.start : r.n}</span>
          <span className="seq-kind">{kindWord(r.kind)}</span>
        </div>
        <p className="seq-what">{r.what}</p>
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
            <Cite at={r.cite} />
            {r.more > 0 && <span> {C.more(r.more)}</span>}
          </p>
        )}
        {r.n > 0 && <Confirmed by={r.confirmedBy} />}
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
}: {
  seq: Sequence;
  name?: string;
  /** The step a link points at (?step=), 0 for the start. */
  current?: number;
}) {
  const cols = { "--lanes": seq.lanes.length } as CSSProperties;
  return (
    <div className="seq-wrap">
      <div className="seq" style={cols}>
        <div className="seq-row seq-head" aria-hidden="true">
          {seq.lanes.map((l, i) => (
            <div key={l.id} className={`seq-lane ${l.kind}`} style={{ gridColumn: i + 1 }}>
              <strong>{l.label}</strong>
              <small>{C.lanes[l.kind]}</small>
            </div>
          ))}
        </div>
        <ol className="seq-steps" aria-label={C.diagram(name ?? "this flow")}>
          {seq.rows.map((r) => (
            <Step key={r.n} r={r} lanes={seq.lanes} now={r.n === current} />
          ))}
        </ol>
      </div>
      <h3 className="h seq-h">{C.errorsTitle}</h3>
      {seq.errors.length ? (
        <ul className="seq-errors">
          {seq.errors.map((e, i) => (
            <li key={i}>
              <span>{e.when}</span> <span aria-hidden="true">→</span> <strong>{e.then}</strong>
              {e.cite && <Cite at={e.cite} />}
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

export function Flows({ hash }: { hash: string }) {
  const list = useApi<Api.SpecListT>("/api/specs");
  const wanted = queryParam(hash, "repo");
  const flow = queryParam(hash, "flow");
  const q = queryParam(hash, "q");
  const stepParam = Number(queryParam(hash, "step"));
  const step = Number.isInteger(stepParam) && stepParam >= 0 ? stepParam : undefined;
  return (
    <div className="stack">
      <Panel title={C.title}>
        <p className="muted" style={{ marginTop: 0 }}>
          {C.intro}
        </p>
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
      </Panel>
      {list.state === "ready" && list.data.repos.length > 0 && (
        <RepoFlows
          repo={wanted ?? list.data.repos[0]!.repo}
          flow={flow}
          q={q}
          step={step}
          key={`${wanted}?${q}`}
        />
      )}
    </div>
  );
}
