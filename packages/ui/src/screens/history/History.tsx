import { useEffect, useState } from "react";
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
import { queryParam } from "../know/common.js";
import "../runs/runs.css";
import "./history.css";

/**
 * Prompt history (ADR 0110): what people asked their assistant in this metarepo and what it
 * answered, kept on this machine in .atticus/history/. Turns (a prompt and the response that
 * followed it) grouped by session, newest first, with a filter box and a change filter. Every
 * prompt and response is data: shown as text in a <pre>, never as markup. Read-only.
 */

const H = COPY.history;
type Turn = Api.HistoryTurn;
type Rec = Api.HistoryRecord;

const when = (at: string) => at.replace("T", " ").slice(0, 16);
/** A session's heading id: its surface and id, in the characters an id holds. */
const domId = (surface: string, session: string) =>
  `hs-${surface}-${session}`.replace(/[^A-Za-z0-9_-]/g, "-");

/** The address of the history: of one change or session, filtered by words. */
export function historyHref(o: { change?: string; session?: string; q?: string }): string {
  const q = new URLSearchParams();
  if (o.change) q.set("change", o.change);
  if (o.session) q.set("session", o.session);
  if (o.q) q.set("q", o.q);
  const s = q.toString();
  return `#/history${s ? `?${s}` : ""}`;
}

/** The turns of the change and session asked for, with every word of the filter. */
export function shownTurns(
  turns: readonly Turn[],
  o: { text: string; change?: string; session?: string },
): Turn[] {
  return turns.filter(
    (t) =>
      (!o.change || t.change === o.change) &&
      (!o.session || t.session === o.session) &&
      matchesWords(
        [
          t.prompt?.text,
          t.response?.text,
          t.prompt?.command,
          t.change,
          t.session,
          H.surfaces[t.surface],
        ],
        o.text,
      ),
  );
}

/** The turns by session, the session with the newest turn first; each newest first. */
export function bySession(
  turns: readonly Turn[],
): { session: string; surface: string; turns: Turn[] }[] {
  const out = new Map<string, { session: string; surface: string; turns: Turn[] }>();
  for (const t of turns) {
    const k = `${t.surface}\u0000${t.session}`;
    const s = out.get(k) ?? { session: t.session, surface: t.surface, turns: [] };
    s.turns.push(t);
    out.set(k, s);
  }
  return [...out.values()];
}

/** The changes the history is about, for the change filter. */
export function changesOf(turns: readonly Turn[]): string[] {
  return [...new Set(turns.flatMap((t) => (t.change ? [t.change] : [])))].sort();
}

/** A prompt or a response: its notes, and its text in its own scrolling box a keyboard reaches. */
function Said({ r, what }: { r: Rec; what: string }) {
  return (
    <div className="history-said">
      <h4 className="runs-h4">
        {what} <time dateTime={r.at}>{when(r.at)}</time>
      </h4>
      {r.truncated && <p className="history-note">{H.truncated(r.size)}</p>}
      {r.masked && <p className="history-note">{H.masked}</p>}
      <pre className="runs-text" tabIndex={0} role="region" aria-label={H.box(what, r.id)}>
        {r.text}
      </pre>
    </div>
  );
}

function TurnView({ t }: { t: Turn }) {
  const command = t.prompt?.command ?? t.response?.command;
  return (
    <li className="history-turn">
      {(t.change || command) && (
        <p className="history-tags">
          {t.change && (
            <>
              <span className="hud">{H.about}</span>{" "}
              <a href={historyHref({ change: t.change })}>{t.change}</a>
            </>
          )}
          {command && (
            <>
              {" "}
              <span className="hud">{H.command}</span> <code className="mono">{command}</code>
            </>
          )}
        </p>
      )}
      <div className="runs-pair">
        {t.prompt ? <Said r={t.prompt} what={H.prompt} /> : <div />}
        {t.response ? (
          <Said r={t.response} what={H.response} />
        ) : (
          <div className="history-said">
            <h4 className="runs-h4">{H.response}</h4>
            <p className="muted" style={{ margin: 0 }}>
              {H.noResponse}
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

function Recording({ r }: { r: Api.HistoryRecording }) {
  return (
    <p className="work-say" style={{ margin: 0 }}>
      {r.on ? H.recordingOn : r.offBy === "org-pack" ? H.offOrgPack : H.offLocal}
    </p>
  );
}

/** The history: whether it records, the filters, and the turns by session; its states. */
export function HistoryView(p: {
  of: Loaded<Api.HistoryList> & { reload?: () => void };
  text: string;
  onText?: (v: string) => void;
  change?: string;
  onChange?: (change: string) => void;
  session?: string;
}) {
  return (
    <View
      of={p.of}
      empty={(d) => d.total === 0}
      emptyContent={
        p.of.state === "ready" ? (
          <div className="stack" style={{ gap: 8 }}>
            <Recording r={p.of.data.recording} />
            <div className="state">{H.empty}</div>
            <p className="muted" style={{ margin: 0 }}>
              {H.what}
            </p>
          </div>
        ) : null
      }
    >
      {(d) => {
        const shown = shownTurns(d.turns, {
          text: p.text,
          ...(p.change ? { change: p.change } : {}),
          ...(p.session ? { session: p.session } : {}),
        });
        const filtered = !!p.text.trim() || !!p.change || !!p.session;
        return (
          <div className="stack" style={{ gap: 10 }}>
            <Recording r={d.recording} />
            <p className="muted" style={{ margin: 0 }}>
              {H.what}
            </p>
            {p.session && (
              <p className="work-say" style={{ margin: 0 }}>
                {H.onlySession(p.session)}{" "}
                <a href={historyHref(p.change ? { change: p.change } : {})}>{H.showAll}</a>
              </p>
            )}
            <div className="row history-filters" role="search">
              <FilterBox id="history-find" value={p.text} onChange={(v) => p.onText?.(v)} grow />
              <div className="stack" style={{ gap: 4 }}>
                <label htmlFor="history-change" className="hud" style={{ fontSize: 10 }}>
                  {H.change}
                </label>
                <select
                  id="history-change"
                  className="field"
                  value={p.change ?? ""}
                  onChange={(e) => p.onChange?.(e.target.value)}
                >
                  <option value="">{H.everyChange}</option>
                  {changesOf(d.turns).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <FilterCount shown={shown.length} total={d.turns.length} active={filtered} />
            {shown.length === 0 ? (
              <FilterEmpty
                what={filteredWhat({
                  text: p.text,
                  ...(p.change ? { change: p.change } : {}),
                })}
                onClear={() => {
                  p.onText?.("");
                  p.onChange?.("");
                }}
                focus="history-find"
              />
            ) : (
              bySession(shown).map((s) => (
                <section
                  key={`${s.surface}:${s.session}`}
                  className="history-session"
                  aria-labelledby={domId(s.surface, s.session)}
                >
                  <h3 id={domId(s.surface, s.session)} className="history-h">
                    <a href={historyHref({ session: s.session })}>{H.session(s.session)}</a>{" "}
                    <span className="muted">
                      {H.surfaces[s.surface] ?? s.surface}, {H.turns(s.turns.length)}
                    </span>
                  </h3>
                  <ol className="history-turns">
                    {s.turns.map((t) => (
                      <TurnView key={t.prompt?.id ?? t.response?.id} t={t} />
                    ))}
                  </ol>
                </section>
              ))
            )}
            {d.total > d.turns.length && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {H.newest(d.turns.length, d.total)}
              </p>
            )}
          </div>
        );
      }}
    </View>
  );
}

/** The Prompt history screen: #/history, ?change= for one change, ?session= for one, ?q= to filter. */
export function History({ hash }: { hash: string }) {
  const change = queryParam(hash, "change");
  const session = queryParam(hash, "session");
  const q = queryParam(hash, "q");
  const [text, setText] = useState(q ?? "");
  useEffect(() => setText(q ?? ""), [q]);
  const list = useApi<Api.HistoryList>("/api/history?limit=1000");
  useLiveEvents((e) => {
    if (e.type === "file.changed") list.reload();
  });
  return (
    <div className="bento">
      <Panel title={H.title} span="1 / -1">
        <p className="work-say" style={{ marginTop: 0 }}>
          {H.intro}
        </p>
        <HistoryView
          of={list}
          text={text}
          onText={setText}
          {...(change ? { change } : {})}
          {...(session ? { session } : {})}
          onChange={(c) => {
            location.hash = historyHref({
              ...(c ? { change: c } : {}),
              ...(session ? { session } : {}),
            });
          }}
        />
      </Panel>
    </div>
  );
}
