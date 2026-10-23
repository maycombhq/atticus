import { useState, type ReactNode } from "react";
import { ApiError } from "../../api/client.js";
import { COPY } from "../../copy.js";
import "./run.css";

const TX = COPY.runShared;

/** Pieces the Release and Run screens share: actions that say what happened, copy buttons, chips. */

export function message(e: unknown): string {
  if (e instanceof ApiError) return e.problem.detail ?? e.problem.title;
  return e instanceof Error ? e.message : String(e);
}

export type Outcome = { ok: boolean; text: string; working?: boolean };

/**
 * The command line's "Re-run with --force" means nothing in the app: say what to do here
 * instead (tick the box, or the command to run in a terminal).
 */
export function forceHint(text: string, hint: string): string {
  return text.replace(/Re-run with --force to [^.]*\./, hint);
}

/** Rethrow a failure with the app's words for --force. */
export const withForceHint = (hint: string) => (e: unknown) => {
  throw new Error(forceHint(message(e), hint));
};

/** One button that runs an action and shows its outcome in words, never a silent failure. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Outcome | undefined>();
  const run = async (f: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => {
    setBusy(true);
    // Say at once that it started: some steps take a while, and a still page reads as a dead click.
    setNote({ ok: true, text: COPY.app.working, working: true });
    try {
      const r = await f();
      setNote({ ok: true, text: typeof ok === "string" ? ok : ok(r) });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, run, clear: () => setNote(undefined) };
}

export function Note({ note }: { note?: Outcome }) {
  if (!note) return null;
  return (
    <p
      role={note.ok ? "status" : "alert"}
      aria-busy={note.working ? true : undefined}
      className={`run-note ${note.working ? "working" : note.ok ? "ok" : "bad"}`}
    >
      {note.text}
    </p>
  );
}

/** Copy text to the clipboard and say so, or say to select it when the browser refuses. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<"copied" | "failed" | undefined>();
  return (
    <button
      type="button"
      className="btn run-copy"
      aria-label={label}
      onClick={() => {
        if (!navigator.clipboard) setDone("failed");
        else
          navigator.clipboard.writeText(text).then(
            () => setDone("copied"),
            () => setDone("failed"),
          );
        setTimeout(() => setDone(undefined), 2000);
      }}
    >
      {done === "copied" ? TX.copied : done === "failed" ? TX.selectAndCopy : TX.copy}
    </button>
  );
}

/** A labelled value in a small definition grid. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="run-facts">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt className="hud">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Buttons that pick one of a few views; `aria-pressed` says which is on. */
export function Choice<T extends string>(p: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={p.label} className="row run-choice">
      {p.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn ${p.value === o.value ? "on" : ""}`}
          aria-pressed={p.value === o.value}
          onClick={() => p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** How an outside system is reached, as a chip with words. */
export function AdapterChip({ type }: { type: string | null }) {
  if (!type) return <span className="chip dim">{TX.notSet}</span>;
  if (type === "manual") return <span className="chip warn">{TX.manual}</span>;
  if (type === "mock") return <span className="chip dim">{TX.mock}</span>;
  return <span className="chip done">{TX.connected(type.toUpperCase())}</span>;
}

export const SYSTEM_LABEL: Record<string, string> = {
  "work-tracker": TX.workTracker,
  "service-desk": TX.serviceDesk,
  "git-host": TX.gitHost,
  wiki: TX.wiki,
  notify: TX.notifications,
  design: TX.designTool,
};

export const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
