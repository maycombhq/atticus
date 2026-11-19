import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { ApiError } from "../api/client.js";
import { COPY } from "../copy.js";
import { JobFailed } from "./job.js";

/**
 * The confirm of a step that changes the catalog, and undo's own: moved here from Catalog builds
 * so an error's Undo (ways-on.tsx) shows the same dialog without importing the page.
 */
const B = COPY.catalogBuild;
const W = COPY.waysOn;

/** Why a job or a call stopped, in its own words. */
export function whyStopped(e: unknown): string {
  // A person's Stop: said in words, never as the job's state ("cancelled").
  if (e instanceof JobFailed && e.stopped) return COPY.app.jobRun.youStopped;
  if (e instanceof JobFailed) return e.lines.join(" ") || e.message;
  if (e instanceof ApiError) return e.problem.detail ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * A step that changes files, asked first in a dialog that lists exactly what it changes. With
 * `count`, the person types the count shown to confirm (ADR 0195 point 4: a confirmation names
 * the count it was shown). Esc and Cancel close it; Tab stays inside; the focus goes back.
 */
export function ConfirmDialog(p: {
  title: string;
  intro: string;
  children: ReactNode;
  confirm: string;
  /** The confirm button's words while it runs (default: Building…). */
  working?: string;
  /** The count to type, for removals and discards. */
  count?: number;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const introId = useId();
  const countId = useId();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    // The review (S4): with no count to type, the focus starts on Cancel, so Enter never confirms
    // an undo or a prune the person hasn't read.
    box.current?.querySelector<HTMLElement>("[data-first-focus]")?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  const ok = p.count === undefined || typed.trim() === String(p.count);
  const go = async () => {
    if (!ok) {
      setError(B.countWrong(p.count!));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await p.onConfirm();
    } catch (e) {
      setError(B.failed(whyStopped(e)));
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
    if (e.key === "Tab" && box.current) {
      const f = [
        ...box.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [tabindex='0']",
        ),
      ];
      if (!f.length) return;
      const a = f[0]!;
      const z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    }
  };
  return (
    <div className="run-dialog-back">
      <div
        ref={box}
        className="run-dialog panel cb-dialog cb"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        onKeyDown={onKey}
      >
        <h2 id={titleId} className="h" style={{ marginTop: 0, fontSize: 16 }}>
          {p.title}
        </h2>
        <p id={introId}>{p.intro}</p>
        <div tabIndex={0} className="stack cb-dialog-list" style={{ gap: 6 }} aria-label={p.title}>
          {p.children}
        </div>
        {p.count !== undefined && (
          <div className="stack" style={{ gap: 4, marginTop: 10 }}>
            <label htmlFor={countId}>{B.typeCount(p.count)}</label>
            <input
              id={countId}
              ref={input}
              data-first-focus
              className="field cb-count"
              style={{ width: "10em", maxWidth: "100%" }}
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              aria-describedby={`${countId}-hint`}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void go();
              }}
            />
            <span id={`${countId}-hint`} className="work-say">
              {B.countHint}
            </span>
          </div>
        )}
        {error && (
          <p className="state error" role="alert">
            {error}
          </p>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button
            ref={cancel}
            {...(p.count === undefined ? { "data-first-focus": true } : {})}
            type="button"
            className="btn"
            onClick={p.onClose}
            disabled={busy}
          >
            {B.cancel}
          </button>
          <button
            ref={yes}
            type="button"
            className="btn primary"
            disabled={busy || !ok}
            aria-busy={busy}
            onClick={() => void go()}
          >
            {busy ? (p.working ?? B.building) : p.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The renames of the builds an undo takes back (newest first) as one net rename per repo, oldest
 * to newest: a → b then b → c is a → c, and a → b then b → a is none (as the CLI's netRenames).
 */
export function netRenames(commandsNewestFirst: readonly string[]): { from: string; to: string }[] {
  const chain: { from: string; to: string }[] = [];
  for (const command of [...commandsNewestFirst].reverse()) {
    const m = /^atticus repo rename (\S+) (\S+)(?: |$)/.exec(command);
    if (!m) continue;
    const from = m[1]!;
    const to = m[2]!;
    const was = chain.find((r) => r.to === from);
    if (was) was.to = to;
    else chain.push({ from, to });
  }
  return chain.filter((r) => r.from !== r.to);
}

/**
 * The undo's confirm: the builds it takes back and every file it puts back. A rename's build
 * (its copy's command, `atticus repo rename <old> <new>`) is undone, not the rename: the
 * manifest still names the new id (ADR 0195 point 7), so the confirm says how to rename back.
 */
export function UndoConfirm(p: {
  plan: NonNullable<Api.CatalogUndoViewT["plan"]>;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** An error's Undo (ADR 0202 point 3): which build, its question and its yes, in its words. */
  title?: string | undefined;
  ask?: string | undefined;
  confirm?: string | undefined;
}) {
  const renames = netRenames(p.plan.takesBack.map((t) => t.command));
  return (
    <ConfirmDialog
      title={p.title ?? B.undoPlanTitle(p.plan.n)}
      intro={B.undoPlanIntro(p.plan.takesBack.map((t) => `${t.n} (${t.command})`).join(", "))}
      confirm={p.confirm ?? B.confirmUndo(p.plan.files.length)}
      {...(p.title ? { working: W.undoing } : {})}
      onConfirm={p.onConfirm}
      onClose={p.onClose}
    >
      {renames.map((r) => (
        <p key={`${r.from}>${r.to}`} className="work-why" role="note">
          {B.undoRename(r.from, r.to)}
        </p>
      ))}
      <ul className="cb-list mono" aria-label={B.undoPlanCaption}>
        {p.plan.files.map((f) => (
          <li key={f.path}>
            {f.to === "absent" ? B.remove : B.restore} {f.path}
          </li>
        ))}
      </ul>
      {p.ask && <p className="li-delete-ask">{p.ask}</p>}
    </ConfirmDialog>
  );
}
