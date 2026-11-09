import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Table } from "../know/common.js";
import { ConflictList } from "../knowledge/shared.js";
import { Command } from "./RunNext.js";
import { Propose } from "../../app/propose.js";
import "./work.css";

/**
 * Change › Knowledge: the org knowledge that applies to the change (ADR 0124, Part 5), from its
 * `knowledge.yaml`. Each item with why the stages picked it; Confirm and Exclude write the file
 * through the local API (`atticus change knowledge --confirm|--exclude` does the same), and the
 * git command that commits it is shown after, since the app runs no git. An excluded item stays
 * out of every later stage's selection. The near-misses can be confirmed too.
 */

const K = COPY.changeKnowledge;
const R = COPY.runNext;

type Applies = Api.ChangeKnowledgeViewT;
type Status = "confirmed" | "excluded";
type Item = { id: string; kind: string; status?: string; title?: string; stages?: string[] };

/** What a person knows it by (B2): its title, else its id. */
const nameOf = (i: { id: string; title?: string; passage?: Passage }) =>
  i.title ?? passageName(i.passage) ?? i.id;
const kindWord = (k: string) => K.kinds[k] ?? k;

type Passage = NonNullable<Api.ChangeKnowledgeViewT["items"][number]["passage"]>;

/** A readable name for an item with no title: its section's heading, else its page's name. */
export function passageName(p: Passage | undefined): string | undefined {
  if (!p) return undefined;
  const last = p.heading.split(" › ").at(-1)?.trim();
  return (
    last ||
    p.page
      .split("/")
      .at(-1)
      ?.replace(/\.(md|markdown)$/i, "")
      .replace(/[-_]+/g, " ")
  );
}

/**
 * The title a person reads (ADR 0191: never a file path as the main label), what it says opened
 * in place (the section's text with its page, or the item's quote), and the id behind Details.
 */
function Name({
  item,
}: {
  item: {
    id: string;
    kind: string;
    title?: string;
    source?: string;
    authority?: string;
    passage?: Passage;
  };
}) {
  const P = COPY.roleWork.passage;
  const title = item.title ?? passageName(item.passage) ?? item.id;
  return (
    <>
      <span>{title}</span> <span className="muted">{kindWord(item.kind)}</span>
      {/* ADR 0132: the source of its page, and how much that source's word counts. */}
      {item.source && (
        <>
          <br />
          <span className="muted">{K.fromSource(item.source, item.authority)}</span>
        </>
      )}
      {item.passage ? (
        <details>
          <summary>{P.open}</summary>
          <div className="stack" style={{ gap: 4, marginTop: 4 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {P.from(item.passage.heading || item.passage.page, item.passage.source)}
            </span>
            {item.passage.quote ? (
              <blockquote
                style={{ margin: 0, paddingLeft: 10, borderLeft: "2px solid var(--line-2)" }}
              >
                <span className="hud" style={{ fontSize: 10 }}>
                  {P.quote}
                </span>
                <p style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{item.passage.quote}</p>
              </blockquote>
            ) : (
              <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5 }}>
                {item.passage.text}
              </p>
            )}
          </div>
        </details>
      ) : null}
      <details>
        <summary className="muted" style={{ fontSize: 11.5 }}>
          {P.details}
        </summary>
        <code className="mono muted">{item.id}</code>
        {item.passage && (
          <>
            <br />
            <code className="mono muted">
              {item.passage.path}:{item.passage.line}
            </code>
          </>
        )}
      </details>
    </>
  );
}

/** What a write said: under way, done with the commit command, or why it failed. */
export type Written =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; id: string; status: Status; result: Api.SetChangeKnowledgeResultT }
  | { state: "error"; text: string };

function Buttons(p: { item: Item; busy: boolean; onSet: (id: string, status: Status) => void }) {
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn"
        disabled={p.busy || p.item.status === "confirmed"}
        aria-label={K.confirmItem(nameOf(p.item))}
        onClick={() => p.onSet(p.item.id, "confirmed")}
      >
        {K.confirm}
      </button>
      <button
        type="button"
        className="btn"
        disabled={p.busy || p.item.status === "excluded"}
        aria-label={K.excludeItem(nameOf(p.item))}
        onClick={() => p.onSet(p.item.id, "excluded")}
      >
        {K.exclude}
      </button>
    </span>
  );
}

function WrittenNote({ w, named }: { w: Written; named: (id: string) => string }) {
  if (w.state === "idle") return null;
  if (w.state === "working")
    return (
      <p role="status" aria-busy="true" className="work-say">
        {K.working}
      </p>
    );
  if (w.state === "error")
    return (
      <p role="alert" className="state error" style={{ margin: "8px 0 0" }}>
        {w.text}
      </p>
    );
  return (
    <div role="status" style={{ marginTop: 8 }}>
      <p className="work-say">
        {K.set(named(w.id), K.statuses[w.status]!.toLowerCase(), w.result.file)}
      </p>
      {/* ADR 0188: Propose for review; the git commands are folded under In a terminal. */}
      <Propose scope="work" />
      <details className="work-terminal">
        <summary>{COPY.appStep.inTerminal}</summary>
        <Command text={w.result.commit} label={K.copyCommit} noRun />
      </details>
    </div>
  );
}

/** The panel from loaded data, so tests can render every state. */
export function ChangeKnowledgeView(p: {
  change: string;
  of: Loaded<Applies> & { reload?: () => void };
  written?: Written;
  onSet?: (id: string, status: Status) => void;
}) {
  const w = p.written ?? { state: "idle" };
  const named = (id: string) => {
    const d = p.of.state === "ready" ? p.of.data : undefined;
    const x = [...(d?.items ?? []), ...(d?.nearMisses ?? [])].find((i) => i.id === id);
    return x ? nameOf(x) : id;
  };
  const busy = w.state === "working";
  const set = p.onSet ?? (() => undefined);
  return (
    <Panel title={K.title} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {K.intro}
      </p>
      <View
        of={p.of}
        empty={(v) => !v.present}
        emptyContent={
          <div className="state">
            <p style={{ margin: "0 0 8px" }}>{K.none}</p>
            <p className="work-say">{R.terminal}</p>
            <Command text={K.featureCommand(p.change)} label={R.copy} />
          </div>
        }
      >
        {(v) => (
          <>
            {v.items.length > 0 ? (
              <Table
                caption={K.caption}
                rows={v.items}
                rowKey={(i) => i.id}
                cols={[
                  {
                    label: K.item,
                    cell: (i) => <Name item={i} />,
                  },
                  {
                    label: K.why,
                    // Why in plain words (the API's reason), never the search's own account;
                    // B-task-knowledge: the tasks whose own selection picked it.
                    cell: (i) =>
                      [
                        i.reason,
                        i.stages.join(", ") || (i.tasks?.length ? "" : K.noStages),
                        i.tasks?.length ? K.tasks(i.tasks) : "",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                  },
                  {
                    label: K.status,
                    cell: (i) => (
                      <span
                        className={`chip ${i.status === "confirmed" ? "done" : i.status === "excluded" ? "dim" : "warn"}`}
                      >
                        {K.statuses[i.status]}
                      </span>
                    ),
                  },
                  {
                    label: K.actions,
                    cell: (i) => <Buttons item={i} busy={busy} onSet={set} />,
                  },
                ]}
              />
            ) : (
              <div className="state">{K.none}</div>
            )}
            {v.nearMisses.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>{K.nearMisses(v.nearMisses.length)}</summary>
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                  {v.nearMisses.map((n) => (
                    <li key={n.id} className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span>
                        <Name item={n} />{" "}
                        <span className="muted">· {K.nearMissStage(n.stage)}</span>
                      </span>
                      <Buttons item={n} busy={busy} onSet={set} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {v.conflicts?.length ? (
              <section aria-label={COPY.knowledgeConflicts.title} style={{ marginTop: 12 }}>
                <h3 style={{ margin: "0 0 4px" }}>{COPY.knowledgeConflicts.title}</h3>
                <p className="work-why" style={{ marginTop: 0 }}>
                  {COPY.knowledgeConflicts.intro}
                </p>
                <ConflictList conflicts={v.conflicts} />
              </section>
            ) : null}
            <WrittenNote w={w} named={named} />
          </>
        )}
      </View>
    </Panel>
  );
}

export function ChangeKnowledgePanel({ change }: { change: string }) {
  const path = `/api/changes/${encodeURIComponent(change)}/knowledge`;
  const view = useApi<Applies>(path);
  useReloadOnFiles(view);
  const [written, setWritten] = useState<Written>({ state: "idle" });
  const onSet = (id: string, status: Status) => {
    setWritten({ state: "working" });
    api<Api.SetChangeKnowledgeResultT>(`${path}/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { status },
    })
      .then((result) => {
        setWritten({ state: "done", id, status, result });
        view.reload();
      })
      .catch((e: unknown) => setWritten({ state: "error", text: message(e) }));
  };
  return <ChangeKnowledgeView change={change} of={view} written={written} onSet={onSet} />;
}
