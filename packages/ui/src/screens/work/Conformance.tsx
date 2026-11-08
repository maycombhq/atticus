import type { Api } from "@maycombhq/core";
import { useApi, isFileChange, useLiveEvents } from "../../api/client.js";
import { followJob } from "../../app/propose.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, queryParam, useAction } from "../know/common.js";
import type { ChangeRow } from "./next.js";
import { Command } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";

/**
 * Code against design (ADR 0114): the newest check of each repo's branch against the change's
 * target flows. Every call, table, column, migration and endpoint found, missing, still there
 * or not in the design, with the file and line it cites and its finding's state. It reads the
 * stored check; a person checks again with a click (a local job on the server, eighth UX walk)
 * or the command.
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

/** Check the code again: the same check as the command, run by the server on the click. */
function CheckAgain({ change }: { change: string }) {
  const check = useAction();
  return (
    <div className="stack" style={{ gap: 4, margin: "8px 0 4px" }}>
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={check.busy}
          onClick={() =>
            void check.run(
              () => followJob(`/api/changes/${encodeURIComponent(change)}/conformance`, {}),
              C.checked,
            )
          }
        >
          {check.busy ? C.checking : C.run}
        </button>
      </div>
      <Note note={check.note} />
      <p className="muted" style={{ margin: "4px 0 0" }}>
        {C.orTerminal}
      </p>
      <Command text={`atticus change conform ${change}`} label={COPY.runNext.copy} />
    </div>
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
        <CheckAgain change={c.change} />
      </>
    );
  return (
    <>
      {c.results.map((r) => (
        <RepoResult key={r.repo} r={r} />
      ))}
      <p>{C.gate(c.round)}</p>
      <CheckAgain change={c.change} />
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
  useLiveEvents((e) => {
    if (isFileChange(e)) conf.reload();
  });
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
