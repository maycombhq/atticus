import { useState } from "react";
import { api } from "../api/client.js";
import { COPY } from "../copy.js";
import { ShowInConsole } from "./activity.js";
import { Note, useAction } from "../screens/know/common.js";
import {
  ApplyAll,
  ApplyAndPropose,
  followJob,
  stepLines,
  useResultsInPanel,
  workChanged,
} from "./propose.js";
// Home's pending list offers it too; it lives beside Apply and Propose.
export { ApplyAll };
import { RunStep, stepArgs } from "./runstep.js";
import { RunWithCopilot, useCopilotRuns, type StartAsk } from "./copilot-runs.js";
import { CopyButton } from "../screens/run/shared.js";

/**
 * ADR 0188: the app offers a button for every step in the daily path. A command a page shows is
 * read here; when the app can take that step itself, `appStep` says how and `AppStep` is its
 * button, and the page folds the command under "In a terminal" (RunNext.tsx's Command). The
 * server checks every step again; this only decides what the page shows.
 */

const T = COPY.appStep;

/** A local step the server runs as a job, or answers at once. */
export interface CallStep {
  kind: "call";
  method: "POST" | "PUT";
  path: string;
  body?: Record<string, unknown>;
  label: string;
  working: string;
  done: string;
  say?: string;
  /** The files it writes wait to be proposed (Home's Propose for review reads them again). */
  writes?: boolean;
}

export type AppStepT =
  /** An AI step: Run (Copilot or the server's model) or Prepare for the person's assistant. */
  | { kind: "ai"; args: string[] }
  /** `atticus verify <repo> [--write]`: Apply, then Propose for review. */
  | { kind: "apply"; repo: string }
  /** `atticus verify --all [--write]`. */
  | { kind: "apply-all" }
  /** `atticus task context <change> <task>`: copied for the person's assistant. */
  | { kind: "task-context"; change: string; task: string }
  | CallStep;

/** A command line's words; undefined when it quotes anything (no step here does). */
function words(text: string): string[] | undefined {
  const w = text.trim().split(/\s+/);
  return w.some((x) => /["'<>…]/.test(x)) ? undefined : w;
}

const plain = (w: string | undefined) => !!w && !w.startsWith("-");

/** How the app takes the step a command names, or undefined when it has no button for it. */
export function appStep(command: string): AppStepT | undefined {
  const ai = stepArgs(command);
  if (ai) return { kind: "ai", args: ai };
  const w = words(command);
  if (!w || w[0] !== "atticus") return undefined;
  const [, a, b, c, d, ...rest] = w;
  const only = (n: number) => w.length === n;
  // verify <repo> [--write]: Apply checks the facts and writes them (ADR 0183).
  if (a === "verify" && plain(b) && (only(3) || (only(4) && c === "--write")))
    return { kind: "apply", repo: b! };
  if (a === "verify" && b === "--all" && (only(3) || (only(4) && c === "--write")))
    return { kind: "apply-all" };
  // Add to the picture's read of one repo (`map --all --repos <repo>`) is the read of that repo.
  if (a === "map" && b === "--all" && c === "--repos" && plain(d) && !d!.includes(",") && only(5))
    return { kind: "ai", args: ["map", d!] };
  if (a === "workspace" && b === "sync" && (only(3) || (only(4) && plain(c))))
    return {
      kind: "call",
      method: "POST",
      path: "/api/workspace/sync",
      body: c ? { repos: [c] } : {},
      label: T.sync,
      working: T.syncing,
      done: T.synced,
    };
  if (a === "sources" && b === "sync" && only(3))
    return {
      kind: "call",
      method: "POST",
      path: "/api/knowledge/sources/sync",
      label: T.sourcesSync,
      working: T.sourcesSyncing,
      done: T.sourcesSynced,
    };
  if ((a === "estate" && b === "join" && only(3)) || (a === "join" && only(2)))
    return {
      kind: "call",
      method: "POST",
      path: "/api/estate/join",
      label: T.join,
      working: T.joining,
      done: T.joined,
      writes: true,
    };
  if (a === "workspace" && b === "prune" && (only(3) || (only(4) && plain(c))))
    return {
      kind: "call",
      method: "POST",
      path: "/api/workspace/prune",
      body: c ? { change: c } : {},
      label: T.prune,
      working: T.pruning,
      done: T.pruned,
      say: T.pruneSay,
    };
  if (a === "task" && b === "context" && plain(c) && plain(d) && rest.length === 0)
    return { kind: "task-context", change: c!, task: d! };
  if (a === "history" && (b === "on" || b === "off") && only(3))
    return {
      kind: "call",
      method: "PUT",
      path: "/api/history/recording",
      body: { on: b === "on" },
      label: b === "on" ? T.historyOn : T.historyOff,
      working: T.historyWorking,
      done: b === "on" ? T.historyNowOn : T.historyNowOff,
    };
  return undefined;
}

export { inAppWords } from "./app-words.js";

/** The button for a step `appStep` read. `scope`: what Propose for review takes after Apply. */
export function AppStep({
  step,
  scope = "work",
}: {
  step: AppStepT;
  scope?: "work" | "corrections" | "answers";
}) {
  switch (step.kind) {
    case "ai":
      return <RunStep args={step.args} />;
    case "apply":
      return <ApplyAndPropose scope={scope} repo={step.repo} />;
    case "apply-all":
      return <ApplyAll />;
    case "task-context":
      return <TaskContext change={step.change} task={step.task} />;
    case "call":
      return <CallButton step={step} />;
  }
}

/** The button for a command, or nothing when the app has none for it. */
export function AppStepFor({
  command,
  scope,
}: {
  command: string;
  scope?: "work" | "corrections" | "answers";
}) {
  const step = appStep(command);
  return step ? <AppStep step={step} {...(scope ? { scope } : {})} /> : null;
}

/** A local step: the server's job followed to its end (or its answer), and what it printed. */
export function CallButton({ step }: { step: CallStep }) {
  const act = useAction();
  const [lines, setLines] = useState<string[]>();
  const [jobId, setJobId] = useState<string | undefined>();
  // Beta.28: in a narrow panel the lines are folded, and the Console has them in full.
  const inPanel = useResultsInPanel();
  return (
    <div className="stack" style={{ gap: 6 }}>
      {step.say && (
        <p className="work-say" style={{ margin: 0 }}>
          {step.say}
        </p>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              try {
                if (step.method === "POST") {
                  const r = await followJob(step.path, step.body ?? {}, undefined, setJobId);
                  setLines(r.lines);
                } else {
                  await api(step.path, { method: step.method, body: step.body ?? {} });
                }
              } catch (e) {
                setLines(undefined);
                throw e;
              } finally {
                if (step.writes) workChanged();
              }
            }, step.done)
          }
        >
          {act.busy ? step.working : step.label}
        </button>
        {inPanel && <ShowInConsole id={jobId} />}
      </div>
      <Note note={act.note} />
      {lines && lines.length > 0 && stepLines(lines, inPanel)}
    </div>
  );
}

/** `atticus task context <change> <task> --markdown`, copied for the person's assistant. */
export function TaskContext({ change, task }: { change: string; task: string }) {
  const act = useAction();
  const [text, setText] = useState<string>();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              async () => {
                const r = await api<{ markdown: string }>(
                  `/api/changes/${encodeURIComponent(change)}/tasks/${encodeURIComponent(task)}/context`,
                );
                setText(r.markdown);
                if (!navigator.clipboard) return false;
                return navigator.clipboard.writeText(r.markdown).then(
                  () => true,
                  () => false,
                );
              },
              (copied) => (copied ? T.taskContextCopied : T.taskContextFailed),
            )
          }
        >
          {act.busy ? T.taskContextWorking : T.taskContext}
        </button>
      </div>
      <Note note={act.note} />
      {text !== undefined && (
        <details>
          <summary>{T.taskContext}</summary>
          <pre
            className="mono"
            tabIndex={0}
            role="region"
            aria-label={T.taskContext}
            style={{
              whiteSpace: "pre-wrap",
              margin: 0,
              fontSize: 11.5,
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {text}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * ADR 0188: a page with nothing to draw because no repo is read yet says so, and offers the
 * page where a repo is read (Map › Trust, with its Read buttons), never a command to type.
 */
export function CatalogEmpty({ text }: { text: string }) {
  return (
    <div className="state stack" style={{ gap: 8 }}>
      <p style={{ margin: 0 }}>{text}</p>
      <p style={{ margin: 0 }}>
        <a className="btn primary" href="#/trust">
          {T.openTrust}
        </a>
      </p>
    </div>
  );
}

/**
 * Read a repo with the person's assistant (ADR 0124): Copilot, unattended, where runtime.yaml
 * allows copilot-acp (ADR 0173); else the read as a step (Run with the server's model or in VS
 * Code, or Read with my assistant, whose Done puts it on the map).
 */
export function ReadRepo({
  repo,
  again,
  ask,
}: {
  repo: string;
  again?: boolean;
  /** What Copilot is asked, when not the read of this one repo (the stale part, say). */
  ask?: StartAsk;
}) {
  const c = useCopilotRuns();
  if (c?.allowed)
    return (
      <RunWithCopilot
        ask={ask ?? { kind: "repos", repos: [repo], ...(again ? { force: true } : {}) }}
        label={
          again && !ask ? COPY.copilotRuns.start.again(repo) : COPY.copilotRuns.start.repos(repo)
        }
      />
    );
  return <RunStep args={["map", repo]} />;
}

/**
 * ADR 0188: what a canvas edit (a declared link, a box added, an owner, a pairing, an Undo)
 * says once it is written: Apply redraws the map (`verify`), then Propose for review; the
 * commands a terminal would type are folded under "In a terminal".
 */
export function WrittenNext(p: {
  said: string;
  verify: string;
  commit?: string | undefined;
  scope?: "work" | "corrections";
}) {
  const step = appStep(p.verify);
  const lines = [p.verify, p.commit].filter((c): c is string => !!c);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="ev-say" role="status">
        {p.said}
      </p>
      {step && <AppStep step={step} scope={p.scope ?? "corrections"} />}
      <details className="work-terminal">
        <summary>{T.inTerminal}</summary>
        {lines.map((c) => (
          <div key={c} className="work-cmd">
            <code className="mono" style={{ whiteSpace: "pre-wrap" }}>
              {c}
            </code>
            <CopyButton text={c} label={`${T.inTerminal}: ${c}`} />
          </div>
        ))}
      </details>
    </div>
  );
}
