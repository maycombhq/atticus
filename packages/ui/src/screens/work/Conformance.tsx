import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam } from "../know/common.js";
import type { ChangeRow } from "./next.js";
import { Command } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";

/**
 * Code against design (ADR 0114): the newest check of each repo's branch against the change's
 * target flows. Every call, table, column, migration and endpoint found, missing, still there
 * or not in the design, with the file and line it cites and its finding's state. It reads the
 * stored check; checking again is a command a person runs.
 */

const C = COPY.conformance;

const cite = (c: Api.ConformItemT["at"][number]) =>
  `${c.repo ? `${c.repo}:` : ""}${c.path}${c.line ? `:${c.line}` : ""}`;

/** One repo's check: the counts, every item with its citation, and what a scan can't show. */
function RepoResult({ r }: { r: Api.ConformRepoResultT }) {
  const bad = r.counts.missing + r.counts.stillThere + r.counts.unexpected > 0;
  const head = `conf-${r.repo}`;
  return (
    <section aria-labelledby={head} className="est-band">
      <h3 id={head} className="hud">
        {C.repo(r.repo, r.ref)}
      </h3>
      <p className="muted" style={{ margin: "0 0 4px" }}>
        {C.commits(r.commit, r.base)}
        {r.task ? `. ${C.task(r.task)}` : ""}
      </p>
      <p className="est-big">{bad ? C.counts(r.counts) : C.allGood}</p>
      <table className="run-table">
        <caption className="sr">{C.itemsCaption(r.repo)}</caption>
        <thead>
          <tr>
            <th scope="col">{C.col.status}</th>
            <th scope="col">{C.col.what}</th>
            <th scope="col">{C.col.step}</th>
            <th scope="col">{C.col.task}</th>
            <th scope="col">{C.col.at}</th>
            <th scope="col">{C.col.finding}</th>
          </tr>
        </thead>
        <tbody>
          {r.items.map((i, n) => (
            <tr
              key={`${i.status}.${i.check}.${i.flow ?? ""}.${i.item ?? ""}.${i.record ?? ""}.${n}`}
            >
              <td>
                {i.status === "found" ? C.status[i.status] : <strong>{C.status[i.status]}</strong>}
              </td>
              <td>{i.what}</td>
              <td className="mono">{i.flow ? C.step(i.flow, i.item) : C.noStep}</td>
              <td className="mono">{i.task ?? ""}</td>
              <td className="mono">{i.at.map(cite).join(", ")}</td>
              <td className="mono">{i.finding ? `${i.finding.id} (${i.finding.state})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.unchecked.length > 0 && (
        <>
          <h4 className="hud">{C.unchecked}</h4>
          <p className="muted">{C.uncheckedIntro}</p>
          <ul>
            {r.unchecked.map((u) => (
              <li key={`${u.flow}.${u.item ?? "trigger"}`}>
                <span className="mono">{C.step(u.flow, u.item)}</span> ({u.kind}): {u.why}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.problems.length > 0 && (
        <div role="note" className="cd-problems">
          <h4 className="hud">{C.problems}</h4>
          <ul>
            {r.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A change's newest checks. */
export function ConformanceView({ c }: { c: Api.ChangeConformanceT }) {
  if (!c.flows)
    return (
      <>
        <p>{C.noTargets(c.change)}</p>
        <Command text={`atticus change architecture ${c.change}`} label={COPY.runNext.copy} />
      </>
    );
  if (!c.results.length)
    return (
      <>
        <p>{C.notChecked(c.change)}</p>
        <Command text={`atticus change conform ${c.change}`} label={COPY.runNext.copy} />
      </>
    );
  return (
    <>
      {c.results.map((r) => (
        <RepoResult key={r.repo} r={r} />
      ))}
      <p>{C.gate(c.round)}</p>
      <p className="hud" style={{ margin: "8px 0 4px" }}>
        {C.run}
      </p>
      <Command text={`atticus change conform ${c.change}`} label={COPY.runNext.copy} />
      {c.problems.length > 0 && (
        <div role="note" className="cd-problems">
          <h3 className="hud">{C.problems}</h3>
          <ul>
            {c.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** #/conformance?change=<id>: the picker, then the change's newest checks. */
export function Conformance({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const asked = queryParam(hash, "change");
  const current = asked ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  const conf = useApi<Api.ChangeConformanceT>(
    current ? `/api/changes/${encodeURIComponent(current)}/conformance` : undefined,
  );
  useLiveEvents(() => conf.reload());
  return (
    <Panel title={C.title}>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {C.intro}
      </p>
      <View of={list} empty={(l) => l.length === 0} emptyText={C.none}>
        {(l) => (
          <>
            <ChangePicker list={l} current={current} screen="conformance" />
            {current && <View of={conf}>{(c) => <ConformanceView c={c} />}</View>}
          </>
        )}
      </View>
    </Panel>
  );
}
