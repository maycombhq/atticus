import { useCallback, useEffect, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message, Note } from "../know/common.js";
import { markedWords, NeedRow } from "./Needs.js";
import { AiStep, groupItems } from "./shared.js";

/**
 * Needs across changes (ADR 0105): every open need of every open change, grouped by change and
 * then as needs.md groups them, each with its kind, who handles it, lead time, its item's tick,
 * and Done, Not needed and Reopen as on a change's page. It is composed from each change's own
 * needs call, so it says the same as the change's page; a change not yet looked at for needs
 * gives its step to copy, and one whose needs file can't be read says so.
 */

const T = COPY.across;
const N = COPY.knowledge.needs;

type Need = Api.NeedViewT;

/** One open change and its needs, or why they couldn't be read. */
export interface ChangeNeeds {
  change: string;
  title: string;
  needs?: Api.ChangeNeedsViewT;
  error?: string;
}

interface ChangeRef {
  id: string;
  title: string;
  state: string;
}

/** The changes still open: every one but the archived. */
export const openChanges = <C extends ChangeRef>(list: C[]): C[] =>
  list.filter((c) => c.state !== "archived");

/** A need's key across changes. */
export const needKey = (change: string, n: Need): string => `${change}|${n.item}|${n.for}`;

/**
 * What the view shows: the needs by change (open ones, every one with `all`, and those marked
 * on this page so far, so Reopen stays at hand), the open count, and the changes with no needs
 * yet or whose needs couldn't be read. The filter keeps needs that hold every word.
 */
export function needsAcross(
  rows: ChangeNeeds[],
  o: { all: boolean; text: string; kept?: ReadonlySet<string> },
): {
  groups: { change: string; title: string; needs: Need[] }[];
  open: number;
  notYet: { change: string; title: string; command: string; slash: string }[];
  errors: { change: string; title: string; error: string }[];
} {
  const words = o.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (r: ChangeNeeds, n: Need) => {
    if (!words.length) return true;
    const hay = `${r.change} ${r.title} ${JSON.stringify(n)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const groups: { change: string; title: string; needs: Need[] }[] = [];
  let open = 0;
  for (const r of rows) {
    if (!r.needs?.present) continue;
    open += r.needs.needs.filter((n) => n.status === "open").length;
    const needs = r.needs.needs.filter(
      (n) => (o.all || n.status === "open" || o.kept?.has(needKey(r.change, n))) && hit(r, n),
    );
    if (needs.length) groups.push({ change: r.change, title: r.title, needs });
  }
  return {
    groups,
    open,
    notYet: rows
      .filter((r) => r.needs && !r.needs.present)
      .map((r) => ({
        change: r.change,
        title: r.title,
        command: r.needs!.command,
        slash: r.needs!.slash,
      })),
    errors: rows
      .filter((r) => r.error !== undefined)
      .map((r) => ({ change: r.change, title: r.title, error: r.error! })),
  };
}

const idOf = (change: string) => `needs-across-${change.replace(/[^a-z0-9-]/gi, "-")}`;

/** The needs across changes, in every state; pure, so tests render it. */
export function NeedsAcrossView(p: {
  of: Loaded<ChangeNeeds[]>;
  all: boolean;
  text: string;
  kept?: ReadonlySet<string>;
  onMark?: (change: string, n: Need, body: Record<string, unknown>) => void;
  busy?: boolean;
}) {
  return (
    <View of={p.of} empty={(d) => d.length === 0} emptyText={T.needsNoChanges}>
      {(rows) => {
        const d = needsAcross(rows, p);
        return (
          <div className="stack" style={{ gap: 10 }}>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {T.needsCount(d.open, rows.length)}
            </p>
            {d.errors.map((e) => (
              <p
                key={e.change}
                role="alert"
                style={{ margin: 0, color: "var(--magenta-text)", fontSize: 12.5 }}
              >
                {T.needsCantRead(e.change, e.error)}
              </p>
            ))}
            {d.groups.length === 0 && (
              <div className="state">
                {p.text.trim() ? T.nothingMatches(p.text.trim()) : T.needsNone}
              </div>
            )}
            {d.groups.map((g) => (
              <section key={g.change} aria-labelledby={idOf(g.change)}>
                <h3 id={idOf(g.change)} className="h" style={{ fontSize: 14, margin: "6px 0" }}>
                  <a href={`#/changes/${encodeURIComponent(g.change)}`}>{g.title}</a>{" "}
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {g.change}
                  </span>
                </h3>
                {groupItems(g.needs, N.groups).map((k) => (
                  <div key={k.title}>
                    <h4 className="hud" style={{ fontSize: 11, margin: "6px 0" }}>
                      {k.title}
                    </h4>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {k.items.map((n) => (
                        <NeedRow
                          key={needKey(g.change, n)}
                          n={n}
                          scope={g.change}
                          busy={p.busy}
                          onMark={p.onMark ? (x, body) => p.onMark!(g.change, x, body) : undefined}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
            {d.notYet.length > 0 && (
              <details>
                <summary>{T.needsNotYet(d.notYet.length)}</summary>
                <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }} className="stack">
                  {d.notYet.map((c) => (
                    <li key={c.change}>
                      <a href={`#/changes/${encodeURIComponent(c.change)}`}>{c.title}</a>
                      <AiStep command={c.command} slash={c.slash} why={N.none(c.change)} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      }}
    </View>
  );
}

/**
 * Every open change's needs, from each change's needs call. Loading until the changes are
 * read; an error when they can't be; a change whose needs can't be read is one row's error.
 */
export function useNeedsAcross(
  changes: Loaded<ChangeRef[]> & { reload?: () => void },
): Loaded<ChangeNeeds[]> & { reload: () => void } {
  const [s, set] = useState<Loaded<ChangeNeeds[]>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  // Try again after a failed list of changes reads the list again too.
  const again = changes.state === "error" ? changes.reload : undefined;
  const reload = useCallback(() => {
    again?.();
    setTick((t) => t + 1);
  }, [again]);
  const key =
    changes.state === "ready"
      ? JSON.stringify(openChanges(changes.data).map((c) => [c.id, c.title]))
      : undefined;
  const error = changes.state === "error" ? changes.error : undefined;
  const notYet = changes.state === "error" && changes.notYet;
  useEffect(() => {
    if (error !== undefined) {
      set({ state: "error", error, ...(notYet ? { notYet: true } : {}) });
      return;
    }
    if (key === undefined) return;
    const ctl = new AbortController();
    const refs = JSON.parse(key) as [string, string][];
    void Promise.all(
      refs.map(([change, title]) =>
        api<Api.ChangeNeedsViewT>(`/api/changes/${encodeURIComponent(change)}/needs`, {
          signal: ctl.signal,
        }).then(
          (needs): ChangeNeeds => ({ change, title, needs }),
          (e: unknown): ChangeNeeds => ({
            change,
            title,
            error: message(e),
          }),
        ),
      ),
    ).then((data) => {
      if (!ctl.signal.aborted) set({ state: "ready", data });
    });
    return () => ctl.abort();
  }, [key, error, notYet, tick]);
  return { ...s, reload };
}

/** The view as the cross-change page mounts it: loads, marks and follows the files. */
export function NeedsAcross({ text }: { text: string }) {
  const changes = useApi<ChangeRef[]>("/api/changes");
  const rows = useNeedsAcross(changes);
  const [all, setAll] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; working?: boolean } | undefined>();
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      changes.reload();
      rows.reload();
    }
  });
  const onMark = (change: string, n: Need, body: Record<string, unknown>) => {
    setBusy(true);
    setKept((k) => new Set([...k, needKey(change, n)]));
    setNote({ ok: true, text: COPY.app.working, working: true });
    api<Api.MarkedNeedT>(
      `/api/changes/${encodeURIComponent(change)}/needs/${encodeURIComponent(n.item)}`,
      { method: "POST", body },
    )
      .then((r) => setNote({ ok: true, text: N.marked(r.need.title, markedWords(r.need.status)) }))
      .catch((e: unknown) => setNote({ ok: false, text: message(e) }))
      .finally(() => {
        setBusy(false);
        rows.reload();
      });
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="work-say" style={{ margin: 0 }}>
        {T.needsIntro}
      </p>
      <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        {T.needsShowAll}
      </label>
      <Note note={note} />
      <NeedsAcrossView of={rows} all={all} text={text} kept={kept} onMark={onMark} busy={busy} />
    </div>
  );
}
