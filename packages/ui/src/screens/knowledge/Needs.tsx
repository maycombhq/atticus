import { useEffect, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { escapeCloses, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note } from "../know/common.js";
import { AiStep, groupItems, kindLabel, Links, pageText } from "./shared.js";

/**
 * What a change needs from the organisation (ADR 0102), on the change's page: its needs.yaml
 * grouped as needs.md is, each with lead time, who handles it, its catalogue item, links,
 * steps and why (the change's own words, with file and line), the tick when a person verified
 * its item and "not yet verified" otherwise. Done, Not needed and Reopen run `atticus needs
 * done|skip|reopen` as the signed-in person. Before `atticus change needs` has run, the panel
 * gives that step to copy.
 */

const N = COPY.knowledge.needs;
const R = COPY.knowledge.review;

type Need = Api.NeedViewT;

/** The item's review on a need: the tick, check again, rejected, or not yet verified. */
export function needTick(n: Need): { text: string; ok: boolean; rejected?: true } {
  const r = n.review;
  if (r?.state === "verified" || r?.state === "corrected")
    return { text: R.verified(r.by, r.at.slice(0, 10)), ok: true };
  if (r?.state === "stale") return { text: R.stale(r.by), ok: false };
  // Its item was rejected: say so, so the person doesn't raise a request no one stands behind.
  if (r?.state === "rejected")
    return { text: R.rejected(r.by, r.at.slice(0, 10)), ok: false, rejected: true };
  return { text: R.none, ok: false };
}

/** What a need is once marked, in the words the note uses. */
export function markedWords(status: string): string {
  if (status === "open") return N.openAgain;
  if (status === "not-needed") return N.markSkip.toLowerCase();
  return status;
}

/** The body for marking a need, or what to fix first. */
export function markBody(
  status: "done" | "not-needed" | "open",
  note: string,
  target: string,
): { body: Record<string, unknown> } | { error: string } {
  if (status === "not-needed" && !note.trim()) return { error: N.needWhy };
  return {
    body: {
      status,
      for: target,
      ...(status !== "open" && note.trim() ? { note: note.trim() } : {}),
    },
  };
}

function Facts({ n }: { n: Need }) {
  const rows: [string, string][] = [];
  if (n.leadTime) rows.push([N.leadTime, n.leadTime]);
  if (n.handledBy) rows.push([N.handledBy, n.handledBy]);
  if (n.catalogueItem) rows.push([N.catalogueItem, n.catalogueItem]);
  if (n.inputs.length) rows.push([N.inputs, n.inputs.join(", ")]);
  if (!rows.length) return null;
  return (
    <dl className="run-facts" style={{ margin: "4px 0" }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function NeedRow(p: {
  n: Need;
  onMark?: (n: Need, body: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  const n = p.n;
  const [open, setOpen] = useState<"done" | "not-needed" | undefined>();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const tick = needTick(n);
  const base = `need-${n.item}-${n.for}`.replace(/[^a-z0-9-]/gi, "-");
  // The keyboard follows the form: into its box when it opens; back to the need once it is
  // saved, or to the button that opened it when Cancel or Escape closes it.
  const title = useRef<HTMLAnchorElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);
  const skipBtn = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const back = useRef<"title" | "done" | "not-needed">("title");
  useEffect(() => {
    if (open) box.current?.focus();
    else if (wasOpen.current) {
      const to = { title, done: doneBtn, "not-needed": skipBtn }[back.current];
      (to.current ?? title.current)?.focus();
    }
    wasOpen.current = !!open;
  }, [open]);
  const cancel = () => {
    back.current = open ?? "title";
    setErr(undefined);
    setOpen(undefined);
  };
  const save = (status: "done" | "not-needed" | "open") => {
    const b = markBody(status, note, n.for);
    if ("error" in b) {
      setErr(b.error);
      box.current?.focus();
      return;
    }
    setErr(undefined);
    back.current = "title";
    setOpen(undefined);
    setNote("");
    // Reopen has no form: its button goes while the call runs, so the keyboard waits on the need.
    if (!open) title.current?.focus();
    p.onMark?.(n, b.body);
  };
  return (
    <li className="list-row" style={{ display: "block" }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
        <span>
          <a
            ref={title}
            id={`${base}-t`}
            href={`#/knowledge?item=${encodeURIComponent(n.item)}`}
            style={n.status === "not-needed" ? { textDecoration: "line-through" } : undefined}
          >
            <strong>{n.title}</strong>
          </a>{" "}
          <span className="muted" style={{ fontSize: 12 }}>
            ({N.for(n.for)}) · {kindLabel(n.kind)}
          </span>
        </span>
        <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className={`chip ${tick.ok ? "done" : tick.rejected ? "blocking" : "warn"}`}>
            {tick.text}
          </span>
          <span className={`chip ${n.status === "open" ? "ai" : "dim"}`}>
            {n.status === "open"
              ? N.open
              : n.status === "done"
                ? N.done(n.by ?? "", n.note)
                : N.notNeeded(n.by ?? "", n.note ?? "")}
          </span>
        </span>
      </div>
      <Facts n={n} />
      <p style={{ margin: "4px 0" }}>
        <span className="hud" style={{ fontSize: 10 }}>
          {N.why}:
        </span>{" "}
        {n.why}
        {n.because && (
          <>
            {" "}
            <q>{n.because.quote}</q>{" "}
            <span className="muted mono" style={{ fontSize: 11 }}>
              {`${n.because.file}${n.because.line ? `:${n.because.line}` : ""}`}
            </span>
          </>
        )}
      </p>
      {n.when && (
        <p className="muted" style={{ margin: "2px 0", fontSize: 12 }}>
          {N.when(n.when)}
        </p>
      )}
      {n.rules.length > 0 && (
        <div>
          <span className="hud" style={{ fontSize: 10 }}>
            {N.rules}
          </span>
          <ul style={{ margin: "2px 0", paddingLeft: 18 }}>
            {n.rules.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {n.steps.length > 0 && (
        <div>
          <span className="hud" style={{ fontSize: 10 }}>
            {N.steps}
          </span>
          <ol style={{ margin: "2px 0", paddingLeft: 20 }}>
            {n.steps.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </div>
      )}
      {n.urls.length > 0 && (
        <div>
          <span className="hud" style={{ fontSize: 10 }}>
            {N.links}
          </span>
          <Links urls={n.urls} />
        </div>
      )}
      <p className="muted mono" style={{ margin: "2px 0", fontSize: 11 }}>
        {n.from === "stories" ? N.fromStories : ""}
        {n.page ? `${n.from === "stories" ? " · " : ""}${N.from(pageText(n.page))}` : ""}
      </p>
      {p.onMark && !open && (
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          {n.status === "open" ? (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={p.busy}
                ref={doneBtn}
                aria-label={N.markDoneOf(n.title)}
                onClick={() => setOpen("done")}
              >
                {N.markDone}
              </button>
              <button
                type="button"
                className="btn"
                disabled={p.busy}
                ref={skipBtn}
                aria-label={N.markSkipOf(n.title)}
                onClick={() => setOpen("not-needed")}
              >
                {N.markSkip}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={p.busy}
              aria-label={N.reopenOf(n.title)}
              onClick={() => save("open")}
            >
              {N.reopen}
            </button>
          )}
        </div>
      )}
      {open && (
        <form
          className="stack"
          style={{ gap: 6, marginTop: 6 }}
          onKeyDown={escapeCloses(cancel)}
          onSubmit={(e) => {
            e.preventDefault();
            save(open);
          }}
        >
          <label htmlFor={`${base}-note`} className="hud" style={{ fontSize: 10 }}>
            {open === "done" ? N.doneNote : N.skipNote}
          </label>
          <input
            ref={box}
            id={`${base}-note`}
            className="field"
            aria-describedby={err ? `${base}-err` : undefined}
            aria-invalid={err ? true : undefined}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn primary" disabled={p.busy}>
              {N.save}
            </button>
            <button type="button" className="btn" onClick={cancel}>
              {N.cancel}
            </button>
          </div>
          {err && (
            <p
              id={`${base}-err`}
              role="alert"
              style={{ margin: 0, color: "var(--magenta-text)", fontSize: 12.5 }}
            >
              {err}
            </p>
          )}
        </form>
      )}
    </li>
  );
}

/** The needs, grouped as needs.md is; the step to find them when there are none yet. */
export function NeedsView(p: {
  of: Loaded<Api.ChangeNeedsViewT>;
  onMark?: (n: Need, body: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  return (
    <View of={p.of}>
      {(d) =>
        !d.present ? (
          <AiStep command={d.command} slash={d.slash} why={N.none(d.change)} />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p className="hud" style={{ fontSize: 10, margin: 0 }}>
              {d.file} · {N.openCount(d.needs.filter((n) => n.status === "open").length)}
            </p>
            {d.needs.length === 0 && <div className="state">{N.empty}</div>}
            {groupItems(d.needs, N.groups).map((g) => (
              <section key={g.title} aria-label={g.title}>
                <h3 className="hud" style={{ fontSize: 11, margin: "6px 0" }}>
                  {g.title}
                </h3>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {g.items.map((n) => (
                    <NeedRow key={`${n.item}|${n.for}`} n={n} onMark={p.onMark} busy={p.busy} />
                  ))}
                </ul>
              </section>
            ))}
            {d.considered.length > 0 && (
              <details>
                <summary>{N.considered}</summary>
                <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                  {d.considered.map((c) => (
                    <li key={c.item}>
                      <span className="mono">{c.item}</span>: {c.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )
      }
    </View>
  );
}

/** The panel a change's page mounts: loads needs.yaml and marks needs. */
export function NeedsPanel({ change, span }: { change: string; span?: string }) {
  const needs = useApi<Api.ChangeNeedsViewT>(`/api/changes/${encodeURIComponent(change)}/needs`);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; working?: boolean } | undefined>();
  useLiveEvents((e) => {
    if (e.type === "file.changed") needs.reload();
  });
  const onMark = (n: Need, body: Record<string, unknown>) => {
    setBusy(true);
    setNote({ ok: true, text: COPY.app.working, working: true });
    api<Api.MarkedNeedT>(
      `/api/changes/${encodeURIComponent(change)}/needs/${encodeURIComponent(n.item)}`,
      { method: "POST", body },
    )
      .then((r) =>
        setNote({
          ok: true,
          text: N.marked(r.need.title, markedWords(r.need.status)),
        }),
      )
      .catch((e: unknown) => setNote({ ok: false, text: message(e) }))
      .finally(() => {
        setBusy(false);
        needs.reload();
      });
  };
  return (
    <section
      className="panel"
      aria-labelledby={`needs-${change}`}
      style={{ gridColumn: span ?? "1 / -1" }}
    >
      <h2 id={`needs-${change}`} className="h" style={{ marginBottom: 6 }}>
        {N.title}
      </h2>
      <p className="work-say" style={{ marginTop: 0 }}>
        {N.intro}
      </p>
      <NeedsView of={needs} onMark={onMark} busy={busy} />
      <Note note={note} />
    </section>
  );
}
