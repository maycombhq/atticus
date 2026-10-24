import { useEffect, useId, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError } from "../api/client.js";
import { hostBridge, type StepEnd } from "../api/bridge.js";
import { COPY } from "../copy.js";
import "../screens/runs/runs.css";

/**
 * Running an AI step from the app (ADR 0106). In a VS Code panel the extension runs it with
 * Copilot (the bridge's run-step message); in a browser whose server has a model (runtime.yaml's
 * adapters.model) the server runs it as a job; otherwise the step stays a command to copy, as
 * before. The command and slash command stay beside the button either way.
 */

const T = COPY.runStep;

/**
 * The AI steps, as `atticus <group> <command>`: the hand-off steps the server and the extension
 * accept (packages/cli's handoff-flag). The server checks again; this only decides whether a
 * page shows the button.
 */
const AI_STEPS = new Set([
  "scan survey",
  "scan verify",
  "spec draft",
  "knowledge scan",
  "change feature",
  "change architecture",
  "change draft",
  "plan stories",
  "change needs",
  "knowledge find",
  "knowledge ask",
]);

/** A command line's words, with "double" or 'single' quoted words kept whole. */
function words(text: string): string[] | undefined {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2] !== undefined) out.push(m[2]);
    else if (/["']/.test(m[3]!)) return undefined;
    else out.push(m[3]!);
  }
  return out;
}

/**
 * The command words and arguments of an AI step the app can start, from the command it shows;
 * undefined for any other command, one with an option (the server refuses an argument that
 * starts with "-") or one with a <placeholder> to fill in.
 */
export function stepArgs(command: string): string[] | undefined {
  const w = words(command.trim());
  if (!w || w[0] !== "atticus" || w.length < 3) return undefined;
  const args = w.slice(1);
  // `atticus critic <change>` is one too: its AI lenses, one at a time (ADR 0106 addendum).
  const critic = args[0] === "critic" && args[1] !== "stats";
  if (!critic && !AI_STEPS.has(`${args[0]} ${args[1]}`)) return undefined;
  if (args.some((a) => a.startsWith("-") || /[<>]/.test(a) || a.trim() === "")) return undefined;
  return args;
}

export type RunChoice = { kind: "copilot" } | { kind: "model"; model: string } | { kind: "copy" };

/** Copilot in a VS Code panel; the server's model in a browser that has one; else the copy. */
export function runChoice(o: {
  panel: boolean;
  serverModel: string | null | undefined;
}): RunChoice {
  if (o.panel) return { kind: "copilot" };
  if (typeof o.serverModel === "string" && o.serverModel)
    return { kind: "model", model: o.serverModel };
  return { kind: "copy" };
}

let model: Promise<string | null> | undefined;

/** The model this server can run a step with, asked once per page; undefined until it answers. */
export function useServerModel(ask: boolean): string | null | undefined {
  const [m, setM] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    model ??= api<Api.RunList>("/api/runs?limit=1").then(
      (r) => r.serverModel ?? null,
      () => {
        // Ask again on the next page that shows a step.
        model = undefined;
        return null;
      },
    );
    void model.then((x) => {
      if (live) setM(x);
    });
    return () => {
      live = false;
    };
  }, [ask]);
  return m;
}

/** A job as /api/jobs/{jobId} gives it (Api.Job). */
interface JobView {
  state: string;
  progress?: { done: number; total: number; message: string };
  startedAt: string;
  errors: string[];
  result?: Record<string, unknown>;
}

type Call = <R>(path: string, o?: { method?: string; body?: unknown }) => Promise<R>;

const ENDED = new Set(["done", "failed", "cancelled"]);

/**
 * Start an AI step on the server (POST /api/runs) and follow its job to the end: each new
 * progress message to onLine, then the end with the step's lines and the run it made. A refusal
 * (409 without a model, 400 for a step it won't start) is thrown as the server's problem.
 */
export async function runOnServer(
  args: string[],
  o: {
    call: Call;
    wait: (ms: number) => Promise<void>;
    onLine: (line: string) => void;
    /** Told the job's id once it started, so the page can cancel it (ADR 0119). */
    onJob?: (jobId: string) => void;
  },
): Promise<StepEnd> {
  const started = await o.call<{ jobId: string; model: string }>("/api/runs", {
    method: "POST",
    body: { args },
  });
  o.onJob?.(started.jobId);
  o.onLine(T.started(started.model));
  let last = "";
  for (;;) {
    const job = await o.call<JobView>(`/api/jobs/${encodeURIComponent(started.jobId)}`);
    const said = job.progress?.message ?? "";
    if (said && said !== last) o.onLine(said);
    last = said;
    if (ENDED.has(job.state)) {
      const result = (job.result ?? {}) as { code?: unknown; lines?: unknown; runId?: unknown };
      const lines = Array.isArray(result.lines)
        ? result.lines.filter((l): l is string => typeof l === "string")
        : job.errors;
      const state =
        job.state === "done"
          ? result.code === 0 || result.code === undefined
            ? "done"
            : "stopped"
          : job.state;
      // The server names the run the step made; an older server doesn't, so then the newest run
      // that started after the job.
      const runId =
        typeof result.runId === "string"
          ? result.runId
          : await o
              .call<Api.RunList>("/api/runs?limit=1")
              .then((r) => r.runs.find((x) => x.startedAt >= job.startedAt)?.runId)
              .catch(() => undefined);
      return { state, lines, ...(runId ? { runId } : {}) };
    }
    await o.wait(700);
  }
}

export type RunState =
  | { phase: "idle"; lines: string[] }
  | { phase: "running"; lines: string[] }
  | { phase: "ended"; lines: string[]; end: StepEnd }
  | { phase: "error"; lines: string[]; error: string };

const why = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.problem.title)
    : e instanceof Error
      ? e.message
      : String(e);

/** The extension refused the step or couldn't start it: no run, and its first line says why. */
const NOT_RUN = new Set(["refused", "not-started"]);

/** How a step ended, in words. */
export function endText(end: StepEnd): string {
  if (NOT_RUN.has(end.state)) return T.refused(end.lines[0] ?? end.state);
  return T.ends[end.state] ?? T.ended(end.state);
}

/**
 * The Run button and what it shows: the lines as they come, then the end or the refusal. While a
 * step runs on the server, Cancel stops it (ADR 0119); Copilot's own chat has its own stop.
 */
export function RunStepView(p: {
  choice: RunChoice;
  state: RunState;
  onRun?: () => void;
  onCancel?: () => void;
  stopping?: boolean;
}) {
  const id = useId();
  if (p.choice.kind === "copy") return null;
  const label = p.choice.kind === "copilot" ? T.withCopilot : T.withModel(p.choice.model);
  const hint = p.choice.kind === "copilot" ? T.hintCopilot : T.hintModel(p.choice.model);
  const running = p.state.phase === "running";
  const s = p.state;
  return (
    <div className="runstep stack">
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn primary"
          disabled={running}
          aria-describedby={`${id}-why`}
          onClick={p.onRun}
        >
          {running ? T.running : label}
        </button>
        {running && p.onCancel && (
          <button
            type="button"
            className="btn"
            disabled={p.stopping}
            title={T.cancelHint}
            onClick={p.onCancel}
          >
            {p.stopping ? T.cancelling : T.cancel}
          </button>
        )}
        <span id={`${id}-why`} className="muted" style={{ fontSize: 12 }}>
          {running ? T.busy : hint}
        </span>
      </div>
      <div aria-live="polite" className="runstep-live">
        {s.lines.length > 0 && (
          <ul className="runstep-lines mono" aria-label={T.progress}>
            {s.lines.map((l, i) => (
              <li key={`${i}:${l}`}>{l}</li>
            ))}
          </ul>
        )}
        {s.phase === "ended" && (
          <div className="stack" style={{ gap: 4 }}>
            <p className="runstep-end">{endText(s.end)}</p>
            {!NOT_RUN.has(s.end.state) && s.end.lines.length > 0 && (
              <pre className="runstep-out" tabIndex={0} role="region" aria-label={T.output}>
                {s.end.lines.join("\n")}
              </pre>
            )}
            {!NOT_RUN.has(s.end.state) && (
              <a href={s.end.runId ? `#/runs?run=${encodeURIComponent(s.end.runId)}` : "#/runs"}>
                {s.end.runId ? T.openRun : T.openRuns}
              </a>
            )}
          </div>
        )}
      </div>
      {s.phase === "error" && (
        <p role="alert" className="run-note bad">
          {T.cantStart(s.error)}
        </p>
      )}
    </div>
  );
}

/**
 * The Run button for a command the app shows, when it is an AI step and a model can be reached
 * from here; nothing otherwise, so the page keeps only the command to copy.
 */
export function RunStep({ command }: { command: string }) {
  const args = stepArgs(command);
  const bridge = hostBridge();
  const serverModel = useServerModel(!!args && !bridge);
  const [state, set] = useState<RunState>({ phase: "idle", lines: [] });
  const [jobId, setJobId] = useState<string | undefined>();
  const [stopping, setStopping] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  if (!args) return null;
  const choice = runChoice({ panel: !!bridge, serverModel });
  const onLine = (l: string) => {
    if (live.current) set((s) => ({ phase: "running", lines: [...s.lines, l] }));
  };
  const onRun = () => {
    set({ phase: "running", lines: [] });
    setJobId(undefined);
    setStopping(false);
    const run = bridge
      ? bridge.runStep(args, onLine)
      : runOnServer(args, {
          call: (path, o) => api(path, o ?? {}),
          wait: (ms) => new Promise((r) => setTimeout(r, ms)),
          onLine,
          onJob: (j) => {
            if (live.current) setJobId(j);
          },
        });
    run.then(
      (end) => {
        if (live.current) set((s) => ({ phase: "ended", lines: s.lines, end }));
      },
      (e: unknown) => {
        if (live.current) set((s) => ({ phase: "error", lines: s.lines, error: why(e) }));
      },
    );
  };
  const onCancel = jobId
    ? () => {
        setStopping(true);
        // A job that already ended answers 409; its end still arrives through the poll.
        void api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: "POST",
          body: {},
        }).catch(() => undefined);
      }
    : undefined;
  return (
    <RunStepView
      choice={choice}
      state={state}
      onRun={onRun}
      {...(onCancel ? { onCancel } : {})}
      stopping={stopping}
    />
  );
}
