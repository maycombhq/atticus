import type { ReactNode } from "react";
import { useApi, useReloadOnFiles } from "../../api/client.js";
import { AppStepFor, appStep } from "../../app/app-step.js";
import { ExternalLink } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { RaiseHandoff } from "../know/Phase.js";
import { isManualLink, ManualPr } from "../know/task-pr.js";
import { NewChange } from "./NewChange.js";
import type { StepKind } from "./next.js";

/**
 * Seventh UX walk: a step's in-app action, shown before its command. Run next and At a glance
 * were terminal-first everywhere (Home said "Run the command in a terminal" for `atticus change
 * new` beside a New change button). Each known kind of step has the control or the page that does
 * it here; the command stays copyable under "Or in a terminal".
 */

const R = COPY.runNext;
const C = COPY.cockpit;

const changeHref = (screen: string, change: string | undefined) =>
  `#/${screen}${change ? `?change=${encodeURIComponent(change)}` : ""}`;

/**
 * Raise hand-off in place: held while the gate's status loads or says something blocks it, and
 * then it says what (eighth UX walk: Raise was enabled for a moment, then disabled with no reason,
 * under "Raise it here").
 */
export function HandoffHere({ change }: { change: string }) {
  const status = useApi<{ blockers: { message: string }[] }>(
    `/api/changes/${encodeURIComponent(change)}/status`,
  );
  // Seventh UX walk: what blocks the gate is read again when its files change.
  useReloadOnFiles(status);
  const blockers = status.state === "ready" ? status.data.blockers : [];
  return (
    <div className="stack" style={{ gap: 4 }}>
      {status.state === "loading" ? (
        <p className="muted" role="status" style={{ margin: 0 }}>
          {C.raiseChecking}
        </p>
      ) : blockers.length > 0 ? (
        <div className="stack" style={{ gap: 2 }}>
          <p className="muted" style={{ margin: 0 }}>
            {C.raiseHeld(blockers.length)}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {blockers.map((b, i) => (
              <li key={`${i}:${b.message}`}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {C.raiseHere}
        </p>
      )}
      <RaiseHandoff
        change={change}
        blockers={blockers.length}
        held={status.state === "loading"}
        onDone={status.reload}
      />
    </div>
  );
}

/** Whether the app has an action for the step, so its command goes under Or in a terminal. */
export function hasAction(p: {
  kind?: StepKind | undefined;
  command: string;
  change?: string | undefined;
  pr?: string | undefined;
}) {
  if (
    p.kind === "handoff" ||
    p.kind === "task" ||
    p.kind === "release" ||
    p.kind === "findings" ||
    p.kind === "gap"
  )
    return !!p.change;
  if (p.kind === "merge") return !!p.pr;
  // ADR 0188: any step the app takes itself (an AI step, Apply, a sync...).
  return !!p.kind || appStep(p.command) !== undefined;
}

/** The step's in-app action, or nothing when the app has none for it. */
export function StepAction(p: {
  kind?: StepKind | undefined;
  command: string;
  change?: string | undefined;
  pr?: string | undefined;
}): ReactNode {
  const link = (href: string, label: string) => (
    <p style={{ margin: 0 }}>
      <a className="btn primary" href={href}>
        {label}
      </a>
    </p>
  );
  switch (p.kind) {
    case "new-change":
      return <NewChange />;
    case "handoff":
      return p.change ? <HandoffHere change={p.change} /> : null;
    case "task":
      return p.change ? (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>
            {R.taskOnBoard}
          </p>
          {link(changeHref("tasks", p.change), R.openTaskBoard)}
        </div>
      ) : null;
    case "brief":
      return link(changeHref("brief", p.change), R.writeBrief);
    case "answer":
      return link(changeHref("questions", p.change), R.answerOnQuestions);
    case "release":
      return p.change ? link(`#/release/${encodeURIComponent(p.change)}`, R.openRelease) : null;
    case "findings":
      // Eighth UX walk: blocking findings hold the hand-off; each is resolved on the change's page.
      return p.change ? (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>
            {R.resolveFindingsSay}
          </p>
          {link(`#/changes/${encodeURIComponent(p.change)}`, R.resolveFindings)}
        </div>
      ) : null;
    case "gap":
      // Ninth UX walk: a knowledge gap is answered on the change's page (Apply fix, Ask, Not relevant).
      return p.change ? (
        <div className="stack" style={{ gap: 4 }}>
          <p className="muted" style={{ margin: 0 }}>
            {R.answerGapSay}
          </p>
          {link(`#/changes/${encodeURIComponent(p.change)}`, R.answerGap)}
        </div>
      ) : null;
    case "merge":
      // A manual Git host's PR isn't open until a person opens it: never its manual:// link.
      if (!p.pr) return null;
      return isManualLink(p.pr) ? (
        <p style={{ margin: 0 }}>
          <ManualPr />
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          <ExternalLink href={p.pr}>{R.openPr}</ExternalLink>
        </p>
      );
    default:
      return <AppStepFor command={p.command} />;
  }
}
