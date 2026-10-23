import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { resumedAttempt, type Run } from "@maycombhq/ai";
import { Api, changesDirOf, runsDirOf, runsRelOf } from "@maycombhq/core";

/**
 * The model runs under .runs/ (ADR 0106), read for the local API, `atticus runs` and the MCP tools:
 * what each run was asked (its prompt), what came back (its answer, wherever its runtime wrote it),
 * and the problems the checks handed back to it (the "checks on attempt N" a hand-back prompt
 * carries). Read-only.
 */

export const RUN_ID = /^run-[0-9a-z-]+$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** One block of data a prompt carries, by its origin. */
const dataBlocks = (prompt: string) =>
  [
    ...prompt.matchAll(/<atticus-data [^>]*origin="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/atticus-data>/g),
  ].map((m) => ({ origin: m[1]!, text: m[2]!.trimEnd() }));

/** The problems each earlier round handed back, with the answer that failed them. */
export function handedBack(prompt: string) {
  const blocks = dataBlocks(prompt);
  const out: Api.RunTranscript["handedBack"] = [];
  for (const b of blocks) {
    const m = /^checks on attempt (\d+)$/.exec(b.origin);
    if (!m) continue;
    const attempt = Number(m[1]);
    const problems = b.text
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    const previous = blocks.find((x) => x.origin === `attempt ${attempt}`)?.text;
    out.push({
      attempt,
      problems,
      ...(previous !== undefined ? { previousAnswer: previous } : {}),
    });
  }
  return out.sort((a, b) => a.attempt - b.attempt);
}

export interface Stored {
  run: Run & { request: Run["request"] & { outputIn?: "change" | "run" } };
  dir: string;
  prompt: string;
}

async function readStored(
  root: string,
  change: string,
  runId: string,
): Promise<Stored | undefined> {
  const dir = join(runsDirOf(root), change, runId);
  const text = await readFile(join(dir, "run.json"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const run = JSON.parse(text) as Stored["run"];
  const prompt =
    (await readFile(join(dir, "prompt.md"), "utf8").catch(() => undefined)) ??
    run.request.pack?.prompt ??
    "";
  return { run, dir, prompt };
}

/** The answer, where the runtime wrote it: in the run (a model runtime), its folder, or the change. */
export async function answerOf(root: string, s: Stored): Promise<string | undefined> {
  if (typeof s.run.output === "string") return s.run.output;
  const out = s.run.request.outputPath;
  if (!out) return undefined;
  const inRun = join(s.dir, basename(out));
  const inChange = resolve(changesDirOf(root), s.run.request.change, out);
  // A path that leaves the change folder is never read.
  const candidates = [inRun];
  if (s.run.request.outputIn !== "run" && !relative(changesDirOf(root), inChange).startsWith(".."))
    candidates.push(inChange);
  for (const f of candidates) {
    const t = await readFile(f, "utf8").catch(() => undefined);
    if (t !== undefined) return t;
  }
  return undefined;
}

export async function item(root: string, s: Stored): Promise<Api.RunListItem> {
  const r = s.run;
  const manifest = await readFile(join(s.dir, "context-manifest.json"), "utf8").catch(() => "");
  const attempt = r.request.pack?.manifest ? resumedAttempt(r).attempt : (r.attempt ?? 1);
  const back = handedBack(s.prompt);
  const answer = await answerOf(root, s);
  const agent = r.request.agent as unknown as string | { id: string };
  return {
    schemaVersion: 1,
    runId: r.runId,
    change: r.request.change,
    agent: typeof agent === "string" ? agent : agent.id,
    runtime: r.runtime,
    state: r.state,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.request.outputPath ? { output: r.request.outputPath } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    contextManifestSha256: sha(manifest),
    promptPath: `${runsRelOf(root)}/${r.request.change}/${r.runId}/prompt.md`,
    attempt,
    answered: answer !== undefined,
    handedBack: back.reduce((n, b) => n + b.problems.length, 0),
    ...(r.request.pack?.manifest ? { promptTokens: r.request.pack.manifest.totalTokens } : {}),
  } as Api.RunListItem;
}

export async function allRuns(root: string, change?: string): Promise<Stored[]> {
  const out: Stored[] = [];
  const changes = change ? [change] : await readdir(runsDirOf(root)).catch(() => [] as string[]);
  for (const c of changes) {
    // A change or step folder name is one segment: nothing that leaves .runs/.
    if (c.includes("/") || c.includes("\\") || c.includes("..") || c.includes(sep)) continue;
    for (const id of await readdir(join(runsDirOf(root), c)).catch(() => [] as string[])) {
      if (!RUN_ID.test(id)) continue;
      const s = await readStored(root, c, id);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Every run, newest first, as the list shows it. */
export async function listRuns(
  root: string,
  o: { change?: string; limit?: number } = {},
): Promise<Api.RunListItem[]> {
  const items = await Promise.all((await allRuns(root, o.change)).map((s) => item(root, s)));
  items.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
  return items.slice(0, o.limit ?? 200);
}

/** One run's prompt, answer, what was handed back to it and every round of its step; undefined when there is none. */
export async function runTranscript(
  root: string,
  runId: string,
): Promise<Api.RunTranscript | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const all = await allRuns(root);
  const s = all.find((x) => x.run.runId === runId);
  if (!s) return undefined;
  const agentOf = (x: Stored) => {
    const a = x.run.request.agent as unknown as string | { id: string };
    return typeof a === "string" ? a : a.id;
  };
  const same = all.filter(
    (x) => x.run.request.change === s.run.request.change && agentOf(x) === agentOf(s),
  );
  const rounds = await Promise.all(same.map((x) => item(root, x)));
  rounds.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
  const answer = await answerOf(root, s);
  return {
    run: await item(root, s),
    prompt: s.prompt,
    ...(answer !== undefined ? { answer } : {}),
    handedBack: handedBack(s.prompt),
    rounds: rounds.map((x) => ({
      runId: x.runId,
      attempt: x.attempt,
      state: x.state,
      startedAt: x.startedAt,
    })),
  };
}
