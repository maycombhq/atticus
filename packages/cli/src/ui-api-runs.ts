import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Api, runsRelOf } from "@maycombhq/core";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { parse } from "yaml";
import { orgPackDirOf } from "@maycombhq/core";
import { isHandoffStep } from "./handoff-flag.js";
import { appLines, FORCE_STEPS, mapRepoOf } from "./handoff-resume.js";
import { trackedLocal } from "./ui-api-activity.js";
import { requireConfirmedModel } from "./model-address.js";
import { listRuns, runTranscript } from "./runs-view.js";
import { syncNextOf } from "./sync-next.js";

/**
 * ADR 0106: the model runs, read from .runs/ only. What each run was asked (its prompt), what came
 * back (its answer, wherever its runtime wrote it), and the problems the checks handed back to it
 * (the "checks on attempt N" a hand-back prompt carries). Read-only: starting a run and marking
 * one done are the other routes'.
 */

/**
 * The model this server can call: runtime.yaml's adapters.model, when the modes it allows include
 * the model runtime. None at an organisation whose only model is Copilot, which only VS Code reaches.
 */
async function serverModel(root: string): Promise<string | null> {
  return (await configuredModel(root))?.type ?? null;
}

/**
 * The configured model and, when its settings give it (adapters.model.settings.maxInput), the
 * tokens its prompt may take: every step the server starts fits it (ADR 0112).
 */
async function configuredModel(root: string): Promise<{ type: string; maxInput?: number } | null> {
  const text = await readFile(join(orgPackDirOf(root), "runtime.yaml"), "utf8").catch(
    () => undefined,
  );
  if (!text) return null;
  let y:
    | {
        adapters?: { model?: { type?: unknown; settings?: { maxInput?: unknown } } };
        modes?: { allowed?: unknown };
      }
    | undefined;
  try {
    y = parse(text) as typeof y;
  } catch {
    return null;
  }
  const type = y?.adapters?.model?.type;
  if (typeof type !== "string" || type === "mock") return null;
  const allowed = y?.modes?.allowed;
  if (Array.isArray(allowed) && !allowed.includes("model")) return null;
  const max = y?.adapters?.model?.settings?.maxInput;
  return typeof max === "number" && Number.isInteger(max) && max >= 1000
    ? { type, maxInput: max }
    : { type };
}

/** Run `atticus <args>`: the command line's own code, in this process. */
export type StepRunner = (
  args: string[],
) => Promise<{ code: number; out: string[]; err: string[] }>;

export function uiModelRunRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { runStep?: StepRunner } = {},
): Router {
  const root = ctx.root;
  const runStep: StepRunner =
    deps.runStep ??
    (async (args) => {
      const { main } = await import("./main.js");
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...args, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out, err };
    });
  return (
    r
      // UX review: in a browser with no model, the step is prepared for the person's own
      // assistant (`--handoff`): the run's page shows its prompt, and Done checks the answer.
      .add("POST", "/api/runs/handoff", async ({ body }) => {
        const words = stepWords(body);
        const { prepareStep } = await import("./handoff-resume.js");
        const { code, prepared } = await prepareStep(root, runStep, words);
        ctx.events.publish({ type: "file.changed", path: runsRelOf(root) });
        // A step with nothing left to hand off (its stage is done) ran and made no run: what it
        // said is the answer. A run that still waits is named, to open (fourth UX walk).
        // Review of beta.23 (ADR 0188): a read of a repo with no base clone here carries the
        // app's next step, Sync the repos for it.
        if (!prepared.runId && code !== 0) {
          const next = syncNextOf(prepared.lines);
          throw new HttpError(
            422,
            "The step wasn't prepared",
            prepared.lines.join("\n") || "The step prepared no run.",
            next ? { next } : {},
          );
        }
        return { status: 201, body: prepared };
      })
      .add("POST", "/api/runs", async ({ body }) => {
        const words = stepWords(body);
        const configured = await configuredModel(root);
        const model = configured?.type;
        if (!model)
          throw conflict(
            "This server's runtime.yaml configures no model, so it can't run an AI step. Run it in your assistant (its slash command), or from VS Code with Copilot.",
          );
        // Review round 50 (ADR 0186 addendum): the key goes only where the person confirmed.
        await requireConfirmedModel(root, "model");
        // Round 41: one AI step at a time (as a Copilot run checks): two at once would each take
        // the other's run as the one it made. Checked and started in one tick.
        const busy = ctx.jobs.runningOf("step");
        if (busy)
          throw conflict(
            `An AI step is running on this server (${busy.id}): wait for it to finish, or cancel it.`,
          );
        // Beta.27 re-review: its run-log title is the command's, by the command line's own title
        // rules (the words a request sent never reach the record as they were).
        const { commandTitleInputsOf } = await import("./main.js");
        const log = { command: commandTitleInputsOf([...words, "--mode", "model"]) };
        const job = ctx.jobs.start(
          "step",
          async (c) => {
            c.progress(0, 1, `Running atticus ${words.join(" ")} with ${model}`);
            // The run the step made: the newest one that wasn't there before it.
            const before = new Set((await listRuns(root, { limit: 100000 })).map((x) => x.runId));
            const res = await runStep([
              ...words,
              "--mode",
              "model",
              ...(configured?.maxInput ? ["--max-tokens", String(configured.maxInput)] : []),
            ]);
            const made = (await listRuns(root, { limit: 100000 })).find(
              (x) => !before.has(x.runId),
            );
            let code = res.code;
            const raw = [...res.out, ...res.err];
            const errs = [...res.err];
            // Review of beta.23 (ADR 0188 §4): a read of a repo that kept every fact is put on
            // the map, as its Done does after a hand-off: verify --write, as a local job (the
            // Console shows it; Apply, Propose and Bring in wait). A read that kept a rejected
            // fact ended non-zero and writes nothing to the catalog.
            const repo = mapRepoOf(words);
            let applied: string | undefined;
            if (code === 0 && repo) {
              c.progress(0, 1, `Applying to ${repo}`);
              const v = await trackedLocal(
                ctx,
                `Applying to ${repo}`,
                () => runStep(["verify", repo, "--write"]),
                { ids: [repo] },
              );
              raw.push(...v.out, ...v.err);
              errs.push(...v.err);
              code = v.code;
              if (v.code === 0) applied = repo;
              ctx.events.publish({ type: "file.changed", path: "." });
            }
            c.progress(1, 1, code === 0 ? "Done" : "Stopped");
            ctx.events.publish({ type: "file.changed", path: runsRelOf(root) });
            const lines = appLines(raw);
            const next = code === 0 ? undefined : syncNextOf(raw);
            return {
              result: {
                code,
                lines,
                ...(made ? { runId: made.runId } : {}),
                ...(applied ? { applied } : {}),
                ...(next ? { next } : {}),
              },
              errors: code === 0 ? [] : errs.length ? appLines(errs) : [],
            };
          },
          { title: `atticus ${words.join(" ")}`, log },
        );
        return { status: 202, body: { jobId: job.id, model } };
      })
      .add("GET", "/api/runs", async ({ query }) => {
        const change = query.get("change") ?? undefined;
        const limitText = query.get("limit");
        const limit = limitText === null ? 200 : Number(limitText);
        if (!Number.isInteger(limit) || limit < 1)
          throw badRequest("limit is a whole number of 1 or more.");
        const runs = await listRuns(root, { ...(change ? { change } : {}), limit });
        return {
          status: 200,
          body: { runs, serverModel: await serverModel(root) } satisfies Api.RunList,
        };
      })
      .add("GET", "/api/runs/{runId}/transcript", async ({ params }) => {
        const t = await runTranscript(root, params.runId!);
        if (!t) throw notFound(`There is no run ${params.runId}.`);
        return { status: 200, body: t };
      })
  );
}

/** The step's command words from a request body, refused unless an AI step with no options. */
function stepWords(body: unknown): string[] {
  const args = (body as { args?: unknown } | undefined)?.args;
  if (
    !Array.isArray(args) ||
    args.length < 2 ||
    !args.every((a) => typeof a === "string" && a.trim() !== "")
  )
    throw badRequest(
      'args is the step\'s command words and arguments, for example ["scan", "survey", "forge-ledger"].',
    );
  const words = args as string[];
  if (!isHandoffStep(words[0], words[1]))
    throw badRequest(
      `atticus ${words.slice(0, 2).join(" ")} isn't an AI step; the app starts only those.`,
    );
  // ADR 0188: Draft the stories again passes `--force`, on plan stories only, once.
  const force = FORCE_STEPS.has(`${words[0]} ${words[1]}`);
  const option = withoutSource(words)
    .filter((a, i, all) => !(force && a === "--force" && all.indexOf(a) === i))
    .find((a) => a.startsWith("-"));
  if (option)
    throw badRequest(`${option} would be read as an option; give the step's arguments only.`);
  return words;
}

/**
 * Round 36 (UX review): the steps that read the wikis take one option from the app, `--source
 * <wiki>`, so a wiki's own card can read just that wiki. The words without it; any other dash
 * word, a second --source or one without a value is left in, for the check above to refuse.
 */
const SOURCE_STEPS = new Set(["knowledge scan", "knowledge find"]);
function withoutSource(words: string[]): string[] {
  if (!SOURCE_STEPS.has(`${words[0]} ${words[1]}`)) return words;
  const at = words.indexOf("--source");
  const value = words[at + 1];
  if (at < 0 || !value || value.startsWith("-")) return words;
  return [...words.slice(0, at), ...words.slice(at + 2)];
}
