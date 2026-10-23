import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Api, runsRelOf } from "@maycombhq/core";
import { badRequest, conflict, notFound, type Router, type ServerContext } from "@maycombhq/server";
import { parse } from "yaml";
import { orgPackDirOf } from "@maycombhq/core";
import { isHandoffStep } from "./handoff-flag.js";
import { listRuns, runTranscript } from "./runs-view.js";

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
  const text = await readFile(join(orgPackDirOf(root), "runtime.yaml"), "utf8").catch(
    () => undefined,
  );
  if (!text) return null;
  let y: { adapters?: { model?: { type?: unknown } }; modes?: { allowed?: unknown } } | undefined;
  try {
    y = parse(text) as typeof y;
  } catch {
    return null;
  }
  const type = y?.adapters?.model?.type;
  if (typeof type !== "string" || type === "mock") return null;
  const allowed = y?.modes?.allowed;
  if (Array.isArray(allowed) && !allowed.includes("model")) return null;
  return type;
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
  return r
    .add("POST", "/api/runs", async ({ body }) => {
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
      const option = words.find((a) => a.startsWith("-"));
      if (option)
        throw badRequest(`${option} would be read as an option; give the step's arguments only.`);
      const model = await serverModel(root);
      if (!model)
        throw conflict(
          "This server's runtime.yaml configures no model, so it can't run an AI step. Run it in your assistant (its slash command), or from VS Code with Copilot.",
        );
      const job = ctx.jobs.start("step", async (c) => {
        c.progress(0, 1, `Running atticus ${words.join(" ")} with ${model}`);
        // The run the step made: the newest one that wasn't there before it.
        const before = new Set((await listRuns(root, { limit: 100000 })).map((x) => x.runId));
        const res = await runStep([...words, "--mode", "model"]);
        const made = (await listRuns(root, { limit: 100000 })).find((x) => !before.has(x.runId));
        c.progress(1, 1, res.code === 0 ? "Done" : "Stopped");
        ctx.events.publish({ type: "file.changed", path: runsRelOf(root) });
        return {
          result: {
            code: res.code,
            lines: [...res.out, ...res.err],
            ...(made ? { runId: made.runId } : {}),
          },
          errors: res.code === 0 ? [] : res.err,
        };
      });
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
    });
}
