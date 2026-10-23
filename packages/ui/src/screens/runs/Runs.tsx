import { useEffect, useState, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import {
  FilterBox,
  FilterCount,
  FilterEmpty,
  filteredWhat,
  matchesWords,
} from "../../app/filter.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, Table } from "../know/common.js";
import { Facts } from "../run/shared.js";
import "./runs.css";

/**
 * Model runs (ADR 0106): what Atticus asked a model and what came back, for every AI step under
 * .runs/, newest first; one run's prompt and answer side by side, and per earlier round the
 * problems the checks handed back with the answer that failed them. Prompts and answers are
 * data: they are shown as text in <pre>, never as markup. Read-only.
 */

const R = COPY.runs;

type Item = Api.RunListItem;

/** A link from an AI step's page to its runs in Model runs. */
export function RunsLink(p: { change?: string; q?: string; label?: string }) {
  const label = p.label ?? (p.change ? R.forChange(p.change) : R.all);
  return (
    <a
      className="runs-link"
      href={runsHref({ ...(p.change ? { change: p.change } : {}), ...(p.q ? { q: p.q } : {}) })}
    >
      {label}
    </a>
  );
}

/** The address of the runs: of one change or step, filtered by words, or one run. */
export function runsHref(o: { change?: string; q?: string; run?: string }): string {
  const q = new URLSearchParams();
  if (o.change) q.set("change", o.change);
  if (o.q) q.set("q", o.q);
  if (o.run) q.set("run", o.run);
  const s = q.toString();
  return `#/runs${s ? `?${s}` : ""}`;
}

export const stateText = (s: string) => R.states[s] ?? s;
const when = (at: string) => at.replace("T", " ").slice(0, 16);

/** The runs whose step, agent, run id, state or runtime has every word of the filter. */
export function shownRuns(runs: Item[], text: string): Item[] {
  return runs.filter((r) =>
    matchesWords([r.change, r.agent, r.runId, r.state, stateText(r.state), r.runtime], text),
  );
}

/** The list, with the filter box, and its loading, error and empty states. */
export function RunsTable(p: {
  of: Loaded<Api.RunList> & { reload?: () => void };
  text: string;
  onText?: (v: string) => void;
  onClear?: () => void;
  change?: string;
  current?: string;
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {p.change && (
        <p className="work-say" style={{ margin: 0 }}>
          {R.onlyFor(p.change)} <a href="#/runs">{R.showAll}</a>
        </p>
      )}
      <View
        of={p.of}
        empty={(d) => d.runs.length === 0}
        emptyContent={<div className="state">{p.change ? R.emptyFor(p.change) : R.empty}</div>}
      >
        {(d) => {
          const shown = shownRuns(d.runs, p.text);
          return (
            <>
              <div role="search">
                <FilterBox id="runs-find" value={p.text} onChange={(v) => p.onText?.(v)} />
              </div>
              <FilterCount shown={shown.length} total={d.runs.length} active={!!p.text.trim()} />
              {shown.length === 0 ? (
                <FilterEmpty
                  what={filteredWhat({ text: p.text })}
                  onClear={() => p.onClear?.()}
                  focus="runs-find"
                />
              ) : (
                <Table
                  caption={R.caption}
                  rows={shown}
                  rowKey={(r) => r.runId}
                  cols={[
                    {
                      label: R.cols.step,
                      cell: (r) => (
                        <a
                          href={runsHref({ run: r.runId })}
                          aria-current={r.runId === p.current ? "page" : undefined}
                        >
                          {r.change}
                          <span className="mono runs-id">{r.runId}</span>
                        </a>
                      ),
                    },
                    { label: R.cols.agent, cell: (r) => r.agent, mono: true },
                    { label: R.cols.round, cell: (r) => r.attempt },
                    {
                      label: R.cols.state,
                      cell: (r) => (
                        <span className={`chip ${CHIP[r.state] ?? "dim"}`}>
                          {stateText(r.state)}
                        </span>
                      ),
                    },
                    { label: R.cols.answered, cell: (r) => (r.answered ? R.yes : R.notYet) },
                    { label: R.cols.handedBack, cell: (r) => R.problems(r.handedBack) },
                    {
                      label: R.cols.when,
                      cell: (r) => <time dateTime={r.startedAt}>{when(r.startedAt)}</time>,
                      mono: true,
                    },
                  ]}
                />
              )}
            </>
          );
        }}
      </View>
    </div>
  );
}

const CHIP: Record<string, string> = {
  validated: "done",
  produced: "warn",
  waiting: "warn",
  failed: "blocking",
};

/** Text from a prompt or an answer: in a <pre>, in its own scrolling box a keyboard reaches. */
function TextBox({ text, label }: { text: string; label: string }) {
  return (
    <pre className="runs-text" tabIndex={0} role="region" aria-label={R.textBox(label)}>
      {text}
    </pre>
  );
}

/** One run: its facts, the prompt beside the answer, what was handed back, its step's rounds. */
export function RunDetail(p: { of: Loaded<Api.RunTranscript> & { reload?: () => void } }) {
  return (
    <View of={p.of}>
      {(t) => (
        <div className="stack" style={{ gap: 14 }}>
          <Facts
            rows={[
              [R.facts.agent, <span className="mono">{t.run.agent}</span>],
              [R.facts.runtime, t.run.runtime],
              [R.facts.state, stateText(t.run.state)],
              [R.facts.started, <time dateTime={t.run.startedAt}>{when(t.run.startedAt)}</time>],
              ...(t.run.finishedAt
                ? ([
                    [
                      R.facts.finished,
                      <time dateTime={t.run.finishedAt}>{when(t.run.finishedAt)}</time>,
                    ],
                  ] as [string, ReactNode][])
                : []),
              ...(t.run.promptTokens !== undefined
                ? ([[R.facts.size, R.tokens(t.run.promptTokens)]] as [string, ReactNode][])
                : []),
              ...(t.run.promptPath
                ? ([[R.facts.file, <code className="mono">{t.run.promptPath}</code>]] as [
                    string,
                    ReactNode,
                  ][])
                : []),
            ]}
          />
          {t.rounds.length > 1 && (
            <nav aria-label={R.rounds}>
              <h3 className="hud runs-h">{R.rounds}</h3>
              <ol className="runs-rounds">
                {t.rounds.map((r) => (
                  <li key={r.runId}>
                    <a
                      href={runsHref({ run: r.runId })}
                      aria-current={r.runId === t.run.runId ? "page" : undefined}
                    >
                      {R.round(r.attempt)}
                    </a>{" "}
                    <span className="muted">{stateText(r.state)}</span>
                    {r.runId === t.run.runId && <span className="muted"> {R.thisRound}</span>}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div className="runs-pair">
            <section aria-labelledby="run-prompt">
              <h3 id="run-prompt" className="hud runs-h">
                {R.prompt}
              </h3>
              <TextBox text={t.prompt} label={R.prompt} />
            </section>
            <section aria-labelledby="run-answer">
              <h3 id="run-answer" className="hud runs-h">
                {R.answer}
              </h3>
              {t.answer !== undefined ? (
                <TextBox text={t.answer} label={R.answer} />
              ) : (
                <div className="state">{R.noAnswer}</div>
              )}
            </section>
          </div>
          {t.tools && (
            <section aria-labelledby="run-tools">
              <h3 id="run-tools" className="hud runs-h">
                {R.tools.title}
              </h3>
              <p className="muted" style={{ margin: 0 }}>
                {R.tools.offered(t.tools.offered.join(", "), t.tools.calls.length)}
              </p>
              {t.tools.stopped && (
                <p className="muted" role="note">
                  {R.tools.stopped(t.tools.stopped)}
                </p>
              )}
              {t.tools.calls.map((c, i) => (
                <section key={`${i}:${c.name}`} aria-labelledby={`run-tool-${i}`}>
                  <h4 id={`run-tool-${i}`} className="runs-h4">
                    {R.tools.call(c.round, c.name, c.tokens, c.error === true)}
                  </h4>
                  <pre className="runs-line">{JSON.stringify(c.input)}</pre>
                  <TextBox text={c.output} label={R.tools.returned(c.name)} />
                </section>
              ))}
            </section>
          )}
          <section aria-labelledby="run-back">
            <h3 id="run-back" className="hud runs-h">
              {R.handedBack}
            </h3>
            {t.handedBack.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {R.noneHandedBack}
              </p>
            ) : (
              t.handedBack.map((b) => (
                <div key={b.attempt} className="runs-pair">
                  <section aria-labelledby={`run-back-${b.attempt}`}>
                    <h4 id={`run-back-${b.attempt}`} className="runs-h4">
                      {R.roundProblems(b.attempt)}
                    </h4>
                    <ul className="runs-problems">
                      {b.problems.map((x, i) => (
                        <li key={`${i}:${x}`}>
                          <pre className="runs-line">{x}</pre>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section aria-labelledby={`run-failed-${b.attempt}`}>
                    <h4 id={`run-failed-${b.attempt}`} className="runs-h4">
                      {R.failedAnswer(b.attempt)}
                    </h4>
                    {b.previousAnswer !== undefined ? (
                      <TextBox text={b.previousAnswer} label={R.failedAnswer(b.attempt)} />
                    ) : (
                      <p className="muted">{R.noFailedAnswer}</p>
                    )}
                  </section>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </View>
  );
}

/** The Model runs screen: #/runs, ?change= for one change or step, ?q= to filter, ?run= for one. */
export function Runs({ hash }: { hash: string }) {
  const change = queryParam(hash, "change");
  const current = queryParam(hash, "run");
  const [text, setText] = useState(queryParam(hash, "q") ?? "");
  const q = queryParam(hash, "q");
  useEffect(() => setText(q ?? ""), [q]);
  const list = useApi<Api.RunList>(
    `/api/runs${change ? `?change=${encodeURIComponent(change)}` : ""}`,
  );
  const one = useApi<Api.RunTranscript>(
    current ? `/api/runs/${encodeURIComponent(current)}/transcript` : undefined,
  );
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      list.reload();
      if (current) one.reload();
    }
  });
  const shownOne =
    one.state === "ready" && one.data.run.runId === current ? one : ({ state: "loading" } as const);
  return (
    <div className="bento">
      {current && (
        <Panel
          title={
            shownOne.state === "ready"
              ? R.runTitle(shownOne.data.run.change, shownOne.data.run.attempt)
              : R.title
          }
          span="1 / -1"
          labelledBy="run-detail"
        >
          <p style={{ margin: "0 0 10px" }}>
            <a href={runsHref(change ? { change } : {})}>{R.back}</a>
          </p>
          {one.state === "error" ? (
            <RunDetail of={{ ...one, error: one.error || R.missing(current) }} />
          ) : (
            <RunDetail of={shownOne} />
          )}
        </Panel>
      )}
      <Panel title={current ? R.listTitle : R.title} span="1 / -1">
        <p className="work-say" style={{ marginTop: 0 }}>
          {R.intro}
        </p>
        <RunsTable
          of={list}
          text={text}
          onText={setText}
          onClear={() => setText("")}
          {...(change ? { change } : {})}
          {...(current ? { current } : {})}
        />
        {!current && list.state === "ready" && list.data.runs.length > 0 && (
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            {R.pick}
          </p>
        )}
      </Panel>
    </div>
  );
}
