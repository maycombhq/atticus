import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note, queryParam } from "../know/common.js";
import { AiStep, kindLabel, Links, quoteOf, urlsOf, where } from "./shared.js";

/**
 * Search the wikis (ADR 0102): the plain search of every snapshot page runs here (no AI) and
 * shows the pages and sections that mention the phrase; the AI step that reads them, `atticus
 * knowledge find`, is given to copy. Each saved search lists its candidates, new or already
 * known; Keep makes one a verified knowledge item, as the kind the person picks.
 */

const K = COPY.knowledge;
const S = K.search;

const route = (q: string, find?: string) => {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (find) p.set("find", find);
  const s = p.toString();
  return `#/wiki-search${s ? `?${s}` : ""}`;
};

/** The plain search's result: sections by page, and the AI step to read them. */
export function SearchResult({ of }: { of: Loaded<Api.WikiSearchResultT> }) {
  return (
    <View of={of}>
      {(d) =>
        d.sources === 0 ? (
          <div className="state">{S.noSnapshot}</div>
        ) : d.matches.length === 0 ? (
          <div className="state">{S.none(d.phrase)}</div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }} aria-live="polite">
              {S.found(d.matches.length, d.pages.length)}
            </p>
            {d.pages.map((page) => (
              <section key={page} aria-label={page}>
                <h3 className="mono" style={{ fontSize: 12.5, margin: "4px 0" }}>
                  {page}
                </h3>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {d.matches
                    .filter((m) => `${m.source}/${m.page}` === page)
                    .map((m) => (
                      <li key={`${m.section}:${m.line}`}>
                        <span className="hud" style={{ fontSize: 10 }}>
                          {`${m.section || page} · ${m.line}`}
                        </span>
                        <div style={{ color: "var(--text-2)" }}>{m.excerpt}</div>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
            <AiStep command={d.command} slash={d.slash} why={S.next} />
          </div>
        )
      }
    </View>
  );
}

/** The saved searches, newest first, each a link to its candidates; the search shown stays. */
export function FindList(p: {
  of: Loaded<Api.SavedFindListT>;
  current?: string | undefined;
  q?: string;
}) {
  return (
    <View of={p.of} empty={(d) => d.finds.length === 0} emptyText={S.noSaved}>
      {(d) => (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {d.finds.map((f) => (
            <li key={f.slug} className="list-row">
              <a
                href={route(p.q ?? "", f.slug)}
                aria-current={f.slug === p.current ? "true" : undefined}
              >
                {f.phrase}
              </a>
              <span className="hud" style={{ fontSize: 10 }}>
                {S.candidates(f.candidates.length, f.candidates.filter((c) => c.kept).length)} ·{" "}
                {f.at.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </View>
  );
}

/** One candidate: new, known or kept, with Keep as one of the kinds its record can be. */
export function Candidate(p: {
  c: Api.FindCandidateViewT;
  onKeep?: (id: string, as: string) => void;
  busy?: boolean;
  /** The candidate being kept now, if any: only its button says so. */
  keeping?: string | undefined;
}) {
  const c = p.c;
  const [as, setAs] = useState<string>(c.kind);
  // Keep's form goes once the candidate is kept: the keyboard stays on the candidate.
  const row = useRef<HTMLLIElement>(null);
  const wasKept = useRef(!!c.kept);
  useEffect(() => {
    if (c.kept && !wasKept.current) row.current?.focus();
    wasKept.current = !!c.kept;
  }, [c.kept]);
  const at = where(c.record);
  const quote = quoteOf(c.record);
  return (
    <li ref={row} tabIndex={-1} className="list-row" style={{ display: "block" }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
        <span>
          <strong>{c.title}</strong>{" "}
          <span className="muted mono" style={{ fontSize: 11 }}>
            {kindLabel(c.kind)} · {c.id}
          </span>
        </span>
        <span className={`chip ${c.kept ? "done" : c.known ? "dim" : "ai"}`}>
          {c.kept ? S.kept(kindLabel(c.kept.as), c.kept.by) : c.known ? S.known(c.known) : S.fresh}
        </span>
      </div>
      {quote && (
        <blockquote
          style={{ margin: "4px 0", paddingLeft: 10, borderLeft: "2px solid var(--line-2)" }}
        >
          {quote}
        </blockquote>
      )}
      {at && (
        <p className="muted mono" style={{ margin: 0, fontSize: 11 }}>
          {at}
        </p>
      )}
      <Links urls={urlsOf(c.record)} />
      {!c.known && !c.kept && p.onKeep && (
        <form
          className="row"
          style={{ gap: 8, marginTop: 6 }}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            p.onKeep?.(c.id, as);
          }}
        >
          <label htmlFor={`keep-${c.id}`} className="hud" style={{ fontSize: 10 }}>
            {S.keepAs}
          </label>
          <select
            id={`keep-${c.id}`}
            className="field"
            value={as}
            onChange={(e) => setAs(e.target.value)}
          >
            {c.keepAs.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn primary"
            disabled={p.busy}
            aria-label={S.keepOf(c.title)}
          >
            {p.keeping === c.id ? S.keeping : S.keep}
          </button>
        </form>
      )}
    </li>
  );
}

export function FindDetail(p: {
  of: Loaded<Api.SavedFindViewT>;
  onKeep?: (id: string, as: string) => void;
  busy?: boolean;
  keeping?: string | undefined;
}) {
  return (
    <View of={p.of}>
      {(f) => (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted mono" style={{ margin: 0, fontSize: 11.5 }}>
            {f.file} · {f.at.slice(0, 10)}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {f.candidates.map((c) => (
              <Candidate key={c.id} c={c} onKeep={p.onKeep} busy={p.busy} keeping={p.keeping} />
            ))}
          </ul>
        </div>
      )}
    </View>
  );
}

export function WikiSearch({ hash }: { hash: string }) {
  const q = queryParam(hash, "q") ?? "";
  const find = queryParam(hash, "find");
  const [text, setText] = useState(q);
  // The box says what is searched: a link or the palette can change the address under it.
  useEffect(() => setText(q), [q]);
  const result = useApi<Api.WikiSearchResultT>(
    q ? `/api/knowledge/search?q=${encodeURIComponent(q)}` : undefined,
  );
  const finds = useApi<Api.SavedFindListT>("/api/knowledge/finds");
  const one = useApi<Api.SavedFindViewT>(
    find ? `/api/knowledge/finds/${encodeURIComponent(find)}` : undefined,
  );
  const [keeping, setKeeping] = useState<string | undefined>();
  const busy = keeping !== undefined;
  const [note, setNote] = useState<{ ok: boolean; text: string; working?: boolean } | undefined>();
  // A note is about the saved search it was made on.
  useEffect(() => setNote(undefined), [find]);
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      finds.reload();
      one.reload();
    }
  });
  const [blank, setBlank] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // An empty search says what it needs instead of a button that silently does nothing.
    if (!text.trim()) {
      setBlank(true);
      return;
    }
    setBlank(false);
    const next = route(text.trim(), find);
    // The same words again: search again, rather than a click that changes nothing.
    if (location.hash === next) result.reload();
    else location.hash = next;
  };
  const onKeep = (id: string, as: string) => {
    if (!find) return;
    setKeeping(id);
    setNote({ ok: true, text: COPY.app.working, working: true });
    api<unknown>(`/api/knowledge/finds/${encodeURIComponent(find)}/keep`, {
      method: "POST",
      body: { item: id, as },
    })
      .then(() => {
        setNote({ ok: true, text: S.keptNote(id, kindLabel(as)) });
        one.reload();
        finds.reload();
      })
      .catch((x: unknown) => setNote({ ok: false, text: message(x) }))
      .finally(() => setKeeping(undefined));
  };
  return (
    <div className="bento">
      <Panel title={K.nav.search} span="span 7">
        <p className="work-say" style={{ marginTop: 0 }}>
          {S.intro}
        </p>
        <form role="search" className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={submit}>
          <label htmlFor="wiki-q" className="sr">
            {S.label}
          </label>
          <input
            id="wiki-q"
            className="field"
            style={{ flex: 1 }}
            value={text}
            placeholder={S.placeholder}
            aria-describedby={blank ? "wiki-q-blank" : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setBlank(false);
            }}
          />
          <button type="submit" className="btn primary">
            {S.go}
          </button>
        </form>
        {blank && (
          <p id="wiki-q-blank" role="alert" className="run-note bad" style={{ marginTop: -4 }}>
            {S.needText}
          </p>
        )}
        <p role="status" className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
          {result.refreshing ? S.searching : ""}
        </p>
        {q && <SearchResult of={result} />}
      </Panel>
      <div className="column" style={{ gridColumn: "span 5" }}>
        <Panel title={S.savedTitle}>
          <FindList of={finds} current={find} q={q} />
        </Panel>
        {find && (
          <Panel title={one.state === "ready" ? one.data.phrase : find} labelledBy="find-detail">
            <FindDetail of={one} onKeep={onKeep} busy={busy} keeping={keeping} />
            <Note note={note} />
          </Panel>
        )}
      </div>
    </div>
  );
}
