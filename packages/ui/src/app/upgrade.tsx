import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { useApi, useReloadOnFiles } from "../api/client.js";
import { COPY } from "../copy.js";
import { CopyButton } from "../screens/run/shared.js";
import { followJob, Propose, workChanged } from "./propose.js";

/**
 * Ninth UX walk: Home offers the upgrade this metarepo waits on (runtime.yaml at an older schema,
 * say, so decide can't be set), in the app: what each step does and a button that runs
 * `atticus upgrade` as a local job on the person's click. Before, Home only said "2 to look at".
 */

const U = COPY.upgrade;
const COMMAND = "atticus upgrade";

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
  | { state: "failed"; lines: string[] };

/** The offer from its state (tests render each). Nothing when nothing waits. */
export function UpgradeOfferView(p: {
  view: Api.UpgradeViewT;
  run: UpgradeRun;
  onRun: () => void;
}) {
  const { view, run } = p;
  if (view.newer && view.stamp)
    return (
      <div className="state error" role="alert">
        {U.newer(view.stamp, view.atticus)}
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
  const newer = !!(u.data.newer && u.data.stamp);
  if ((part === "newer" && !newer) || (part === "pending" && newer)) return null;
  if (only && run.state === "idle" && !u.data.pending.some((s) => s.id.startsWith(only)))
    return null;
  return (
    <UpgradeOfferView
      view={u.data}
      run={run}
      onRun={() => {
        setRun({ state: "running" });
        followJob("/api/upgrade", {}).then(
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
          (e: unknown) =>
            setRun({ state: "failed", lines: [e instanceof Error ? e.message : String(e)] }),
        );
      }}
    />
  );
}
