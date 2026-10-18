import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { ExecutorsFile, RunResult, type ExecutorConfig, type RunRequest } from "@maycombhq/core";
import { clientFor, inputsSha256, loadExecutors, type ExecutorClient } from "@maycombhq/executors";
import { Results, type ConformanceReport } from "./report.js";

/**
 * Conformance of a step executor to the C4 executor protocol (ADR 0033), over its own
 * transport, with the reference cases: it answers a ping; it says a fresh idempotency key is
 * unused; it runs an approved write and returns a result for the same run id; afterwards the
 * key reads as used; the same write sent again doesn't produce a different result; and when it
 * says it can fill without submitting, a fill-only run leaves the step to a person and the key
 * unused. The reference case is the reference executor's request (procedure firewall-rule,
 * step submit-request) unless the executor names its own procedures.
 */

export interface ExecutorOptions {
  /** Which executor in the file (by name); default: the only one, or the first. */
  executor?: string;
  /** For tests and embedding: the config itself, and a client factory. */
  config?: ExecutorConfig;
  client?: (cfg: ExecutorConfig) => ExecutorClient;
}

const AT = "2026-01-01T00:00:00Z";

async function configOf(
  target: string,
  o: ExecutorOptions,
): Promise<{ cfg?: ExecutorConfig; problem?: string }> {
  if (o.config) return { cfg: o.config };
  let executors: ExecutorConfig[];
  if (/\.ya?ml$/.test(target)) {
    try {
      const r = ExecutorsFile.safeParse(parse(await readFile(target, "utf8")));
      if (!r.success)
        return {
          problem: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      executors = r.data.executors;
    } catch (e) {
      return { problem: `Can't read ${target}: ${(e as Error).message.split("\n")[0]}` };
    }
  } else {
    const loaded = await loadExecutors(target);
    if (loaded.problems.length > 0) return { problem: loaded.problems.join("; ") };
    executors = loaded.executors;
  }
  const cfg = o.executor ? executors.find((e) => e.name === o.executor) : executors[0];
  return cfg
    ? { cfg }
    : { problem: o.executor ? `No executor named ${o.executor}.` : "No executors configured." };
}

export async function checkExecutor(
  target: string,
  o: ExecutorOptions = {},
): Promise<ConformanceReport> {
  const res = new Results();
  const { cfg, problem } = await configOf(target, o);
  if (!cfg) {
    res.fail("executor.config", problem ?? "No executor.");
    return res.report("executor", target);
  }
  res.pass("executor.config", `Executor ${cfg.name} over ${cfg.transport}.`);
  const client = (o.client ?? clientFor)(cfg);
  const nonce = `${cfg.name}-${process.pid}-${Math.floor(Math.random() * 1e9)}`;

  let pong;
  try {
    pong = await client.ping();
    res.pass("executor.ping", `Answers a ping: ${pong.name} ${pong.version}.`);
  } catch (e) {
    res.fail("executor.ping", `Doesn't answer a ping: ${(e as Error).message}`);
    return res.report("executor", target);
  }
  // An MCP executor lists tool names, which can't be split into procedure and step reliably.
  const named = [
    ...cfg.procedures,
    ...pong.procedures.filter((p) => cfg.transport !== "mcp" || p.includes("/")),
  ];
  const first = (named[0] ?? "firewall-rule/submit-request").split("/");
  const procedure = first[0]!;
  const step = first[1] ?? pong.stepKinds[0] ?? cfg.stepKinds[0] ?? "submit-request";
  const inputs = { summary: "Conformance reference case", reference: `conformance-${nonce}` };
  const key = `conf-${nonce}`.slice(0, 64);
  const request = (k: string, mode: "submit" | "fill-only" = "submit"): RunRequest => ({
    schemaVersion: 1,
    type: "run",
    runId: `run-${k}-${mode}`,
    procedure,
    step,
    inputs,
    idempotencyKey: k,
    mode,
    approval: {
      by: "conformance",
      at: AT,
      ref: "conformance-reference-case",
      inputsSha256: inputsSha256(inputs),
    },
  });

  const used = async (k: string, want: boolean, check: string, when: string) => {
    try {
      const a = await client.check(k);
      if (!a) res.fail(check, `Doesn't answer idempotency checks (${when}).`);
      else if (a.idempotencyKey !== k)
        res.fail(check, `Answered for key ${a.idempotencyKey}, not ${k}.`);
      else if (a.used !== want)
        res.fail(check, `Says a key ${when} is ${a.used ? "used" : "unused"}.`);
      else res.pass(check, `Says a key ${when} is ${want ? "used" : "unused"}.`);
    } catch (e) {
      res.fail(check, `Idempotency check failed (${when}): ${(e as Error).message}`);
    }
  };

  await used(key, false, "executor.idempotency-fresh", "never sent");

  const run = async (req: RunRequest) => {
    const progress: string[] = [];
    const result = await client.run(req, (p) => progress.push(p.message));
    return { result: RunResult.parse(result), progress };
  };
  let done: RunResult | undefined;
  try {
    const { result, progress } = await run(request(key));
    if (result.runId !== request(key).runId)
      res.fail("executor.run", `Answered for run ${result.runId}, not ${request(key).runId}.`);
    else
      res.pass(
        "executor.run",
        `Ran the reference case: ${result.status}${result.message ? ` (${result.message})` : ""}.`,
      );
    if (progress.length > 0)
      res.pass(
        "executor.progress",
        `Reported progress (${progress.length} message${progress.length === 1 ? "" : "s"}).`,
      );
    else res.warn("executor.progress", "Reported no progress before its result.");
    if (result.status === "done") done = result;
    else
      res.warn(
        "executor.run",
        "The reference case didn't finish as done, so the idempotency checks after a run are skipped.",
      );
  } catch (e) {
    res.fail("executor.run", `The reference run failed: ${(e as Error).message}`);
  }

  if (done) {
    await used(key, true, "executor.idempotency-used", "already run");
    try {
      const { result } = await run({ ...request(key), runId: `run-${key}-again` });
      if (
        result.status === "done" &&
        JSON.stringify(result.outputs) !== JSON.stringify(done.outputs)
      )
        res.fail(
          "executor.duplicate",
          "The same write sent twice gave a different result: it ran twice.",
        );
      else
        res.pass(
          "executor.duplicate",
          result.status === "done"
            ? "The same write sent twice gave the same result."
            : `The same write sent twice was refused (${result.status}).`,
        );
    } catch (e) {
      res.pass(
        "executor.duplicate",
        `The same write sent twice was refused: ${(e as Error).message}`,
      );
    }
  }

  if (pong.fillOnly || cfg.fillOnly) {
    const k = `${key}-fill`.slice(0, 64);
    try {
      const { result } = await run(request(k, "fill-only"));
      if (result.status !== "needs-person")
        res.fail("executor.fill-only", `A fill-only run ended ${result.status}, not needs-person.`);
      else res.pass("executor.fill-only", "A fill-only run leaves the step to a person.");
      await used(k, false, "executor.fill-only", "only filled in");
    } catch (e) {
      res.fail("executor.fill-only", `A fill-only run failed: ${(e as Error).message}`);
    }
  }
  return res.report("executor", target);
}
