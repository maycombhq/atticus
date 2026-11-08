import type { ReactNode } from "react";
import { useApi, useReloadOnFiles } from "../../api/client.js";
import { stepArgs, RunStep } from "../../app/runstep.js";
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

/** Raise hand-off in place: held while the gate's status says something blocks it. */
export function HandoffHere({ change }: { change: string }) {
  const status = useApi<{ blockers: unknown[] }>(
    `/api/changes/${encodeURIComponent(change)}/status`,
  );
  // Seventh UX walk: what blocks the gate is read again when its files change.
  useReloadOnFiles(status);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="muted" style={{ margin: 0 }}>
        {C.raiseHere}
      </p>
      <RaiseHandoff
        change={change}
        blockers={status.state === "ready" ? status.data.blockers.length : 0}
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
  if (p.kind === "handoff" || p.kind === "task" || p.kind === "release") return !!p.change;
  if (p.kind === "merge") return !!p.pr;
  return !!p.kind || stepArgs(p.command) !== undefined;
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
      return stepArgs(p.command) ? <RunStep command={p.command} /> : null;
  }
}
