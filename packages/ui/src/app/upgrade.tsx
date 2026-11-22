import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../api/client.js";
import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";
import { InstallCopy } from "./ways-on.js";
import { followJob, Propose, workChanged } from "./propose.js";
import { JobFailed } from "./job.js";

/**
 * Ninth UX walk: Home offers the upgrade this metarepo waits on (runtime.yaml at an older schema,
 * say, so decide can't be set), in the app: what each step does and a button that runs
 * `atticus upgrade` as a local job on the person's click. Before, Home only said "2 to look at".
 */

const U = COPY.upgrade;
const COMMAND = "atticus upgrade";

/** What a refused step's job result lets a person confirm: its counts and the list's plan. */
export interface StepConfirm {
  removals?: number;
  edits?: number;
  plan?: string;
}

export type UpgradeRun =
  | { state: "idle" }
  | { state: "running" }
  | {
      state: "done";
      lines: string[];
      /**
       * Beta.27 review, final round: what the run changed besides the stamp, from the job's
       * result (never the GET from before the run); left out, not known.
       */
      upgraded?: string[];
    }
  | {
      state: "failed";
      lines: string[];
      /**
       * The review of 5cc4ce87 (API 3.19.0): a step whose build waits only for its removals to be
       * confirmed: their count, and the plan of the list (the job result's `confirm`).
       */
      confirm?: { removals?: number; edits?: number; plan?: string };
    };

/** The offer from its state (tests render each). Nothing when nothing waits. */
export function UpgradeOfferView(p: {
  view: Api.UpgradeViewT;
  run: UpgradeRun;
  onRun: () => void;
  /** Confirm the removals a refused run listed (their count), as --allow-removals does. */
  onConfirm?: (confirm: StepConfirm) => void;
}) {
  const { view, run } = p;
  if (view.newer && view.stamp)
    return (
      <div className="state error" role="alert">
        {U.newer(view.stamp, view.atticus)}
      </div>
    );
  // Beta.28.2 (ADR 0197): a catalog a newer Atticus built: upgrade Atticus, not the metarepo.
  if (view.newerCatalog)
    return (
      <div className="state error" role="alert">
        <p style={{ margin: 0 }}>{U.newerCatalog}</p>
        <InstallCopy />
      </div>
    );
  if (!view.pending.length && run.state !== "done") return null;
  // Beta.27 review, final round: only the stamp changed, as the run's own result says it.
  const stampOnly = run.state === "done" && run.upgraded !== undefined && !run.upgraded.length;
  return (
    // Beta.27 review: the panel's words read left to right; .state centres an empty page's line.
    <section
      className="state upgrade-panel"
      aria-labelledby="home-upgrade"
      style={{ display: "grid", gap: 6, textAlign: "start" }}
    >
      <h2 id="home-upgrade" className="hud" style={{ margin: 0, fontSize: 11 }}>
        {U.title}
      </h2>
      {run.state !== "done" && (
        <>
          <p style={{ margin: 0 }}>{U.intro(view.pending.length)}</p>
          <ul style={{ margin: 0 }}>
            {view.pending.map((s) => (
              <li key={s.id}>{U.step(s.summary, s.files.length)}</li>
            ))}
          </ul>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn primary"
              disabled={run.state === "running"}
              aria-busy={run.state === "running"}
              onClick={p.onRun}
            >
              {run.state === "running" ? U.running : U.run}
            </button>
          </div>
          <details>
            <summary className="hud">{U.terminal}</summary>
            <div className="work-cmd">
              <code className="mono">{COMMAND}</code>
              <CopyButton text={COMMAND} label={COPY.decisions.copy(COMMAND)} />
            </div>
          </details>
        </>
      )}
      {(run.state === "done" || run.state === "failed") && (
        <div role={run.state === "done" ? "status" : "alert"}>
          <p style={{ margin: 0 }}>
            {run.state === "failed" ? U.failed : stampOnly ? U.doneStampOnly : U.done}
          </p>
          {run.lines.length > 0 && (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
              {run.lines.join("\n")}
            </pre>
          )}
          {run.state === "failed" &&
            run.confirm &&
            (run.confirm.removals !== undefined || run.confirm.edits !== undefined) &&
            p.onConfirm && <ConfirmStep confirm={run.confirm} onConfirm={p.onConfirm} />}
        </div>
      )}
      {/* Beta.27 review: "Propose the changed files for review" with the button that does it.
          Final round: the stamp alone too (scope upgrade carries it, ADR 0051), so everyone's
          Atticus sees the upgrade. */}
      {run.state === "done" && <Propose scope="upgrade" onDone={workChanged} />}
    </section>
  );
}

/**
 * A refused step's list confirmed here, or with the command in a terminal: its removals over the
 * limits, the hand edits its build listed (B2 of the whole-release review of beta.30), or both.
 */
function ConfirmStep({
  confirm,
  onConfirm,
}: {
  confirm: StepConfirm;
  onConfirm: (c: StepConfirm) => void;
}) {
  const { removals, edits } = confirm;
  const command = `${COMMAND}${edits !== undefined ? ` --discard-edits ${edits}` : ""}${removals !== undefined ? ` --allow-removals ${removals}` : ""}`;
  return (
    <div className="stack" style={{ gap: 4, marginTop: 6 }}>
      {edits !== undefined && (
        <p className="work-say" style={{ margin: 0 }}>
          {U.confirmEditsHint}
        </p>
      )}
      {removals !== undefined && (
        <p className="work-say" style={{ margin: 0 }}>
          {U.confirmHint}
        </p>
      )}
      <div>
        <button type="button" className="btn primary" onClick={() => onConfirm(confirm)}>
          {edits !== undefined && removals !== undefined
            ? U.confirmBoth(edits, removals)
            : edits !== undefined
              ? U.confirmEdits(edits)
              : U.confirmRemovals(removals ?? 0)}
        </button>
      </div>
      <div className="work-cmd">
        <code className="mono">{command}</code>
        <CopyButton text={command} label={COPY.decisions.copy(command)} />
      </div>
    </div>
  );
}

/**
 * Home: the upgrade offer, read from GET /api/upgrade. ADR 0190: `only` (a step id's start, such
 * as `runtime-`) offers it where those steps matter (the AI page, for runtime.yaml), and only
 * when one of them waits; the check is upgrade's own, so the page and `--check` always agree.
 */
export function UpgradeOffer({
  only,
  part,
}: {
  only?: string;
  /**
   * Beta.23 review: a folded Home shows the alert that a newer Atticus upgraded the metarepo
   * (`newer`: it is about the person's own install) outside the fold, and the steps that wait
   * (`pending`) in it. Left out, both.
   */
  part?: "newer" | "pending";
} = {}) {
  const u = useApi<Api.UpgradeViewT>("/api/upgrade");
  useReloadOnFiles(u);
  const [run, setRun] = useState<UpgradeRun>({ state: "idle" });
  if (u.state !== "ready") return null;
  const newer = !!((u.data.newer && u.data.stamp) || u.data.newerCatalog);
  if ((part === "newer" && !newer) || (part === "pending" && newer)) return null;
  if (only && run.state === "idle" && !u.data.pending.some((s) => s.id.startsWith(only)))
    return null;
  const start = (confirm?: { allowRemovals?: number; discardEdits?: number; plan: string }) => {
    setRun({ state: "running" });
    followJob("/api/upgrade", confirm ?? {}).then(
      (r) => {
        const upgraded = r.result?.upgraded;
        setRun({
          state: "done",
          lines: r.lines,
          ...(Array.isArray(upgraded)
            ? { upgraded: upgraded.filter((x): x is string => typeof x === "string") }
            : {}),
        });
        u.reload();
        // Home's list of files to propose reads them again.
        workChanged();
      },
      (e: unknown) => {
        // A step whose build waits for its removals, its hand edits or both: the counts and the
        // plan that confirm exactly that list.
        const c = (e instanceof JobFailed ? e.result?.confirm : undefined) as
          { allowRemovals?: unknown; discardEdits?: unknown; plan?: unknown } | undefined;
        const num = (x: unknown) => (typeof x === "number" ? x : undefined);
        const confirm =
          c && typeof c === "object" && (num(c.allowRemovals) ?? num(c.discardEdits)) !== undefined
            ? {
                ...(num(c.allowRemovals) !== undefined ? { removals: num(c.allowRemovals)! } : {}),
                ...(num(c.discardEdits) !== undefined ? { edits: num(c.discardEdits)! } : {}),
                ...(typeof c.plan === "string" ? { plan: c.plan } : {}),
              }
            : undefined;
        setRun({
          state: "failed",
          lines:
            e instanceof JobFailed && e.lines.length
              ? e.lines
              : [e instanceof Error ? e.message : String(e)],
          ...(confirm ? { confirm } : {}),
        });
      },
    );
  };
  return (
    <UpgradeOfferView
      view={u.data}
      run={run}
      onRun={() => start()}
      onConfirm={(c) => {
        const plan = run.state === "failed" ? run.confirm?.plan : undefined;
        if (plan)
          start({
            ...(c.removals !== undefined ? { allowRemovals: c.removals } : {}),
            ...(c.edits !== undefined ? { discardEdits: c.edits } : {}),
            plan,
          });
      }}
    />
  );
}
