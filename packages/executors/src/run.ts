import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  ExecutorsFile,
  loadOrgPack,
  secretKeys,
  type ExecutorConfig,
  type ManualStep,
  type Procedure,
  type RunProgress,
  type RunResult,
  type StepApproval,
  type StepRun,
  orgPackDirOf,
} from "@maycombhq/core";
import { checkResult, fileStepStore, recordStep, type StepStore } from "@maycombhq/adapters";
import { TransportError, clientFor, isLocalUrl, type ExecutorClient } from "./transports.js";

/**
 * Running a manual step with a person's executor (ADR 0033). The safety rules are not
 * configurable: the org pack must allowlist the executor for the step's procedure; a write
 * step needs the person's approval of exactly these inputs (their sha-256), per run; "fill but
 * don't submit" only where the executor says it can; nothing that looks like a credential goes
 * in or comes back; a failed or timed-out run leaves the manual step open for the person; and
 * a run is not retried without a new approval unless the executor confirms the idempotency key
 * was never used. Outputs are checked against the step's schema and recorded exactly as if the
 * person had entered them, attributed to the approver and the executor.
 */

export const EXECUTORS_FILE = ".atticus/executors.yaml";

export class ExecutorError extends Error {
  constructor(
    readonly code: "not-found" | "refused" | "invalid",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}

/** The person's executors (`.atticus/executors.yaml`, never committed), or none. */
export async function loadExecutors(
  root: string,
  file = join(root, EXECUTORS_FILE),
): Promise<{ executors: ExecutorConfig[]; problems: string[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { executors: [], problems: [] };
  }
  try {
    const r = ExecutorsFile.safeParse(parse(text));
    if (r.success) return { executors: r.data.executors, problems: [] };
    return {
      executors: [],
      problems: r.error.issues.map((i) => `${EXECUTORS_FILE}: ${i.path.join(".")}: ${i.message}`),
    };
  } catch (e) {
    return {
      executors: [],
      problems: [`${EXECUTORS_FILE}: invalid YAML: ${(e as Error).message.split("\n")[0]}`],
    };
  }
}

/** Canonical JSON (sorted keys) of a step's inputs, and its sha-256: what an approval covers. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export const inputsSha256 = (inputs: unknown) =>
  createHash("sha256").update(canonicalJson(inputs), "utf8").digest("hex");

/** The same write always gets the same key: the step and exactly its inputs. */
export const idempotencyKey = (step: Pick<ManualStep, "id" | "inputs">) =>
  createHash("sha256")
    .update(`${step.id}\n${canonicalJson(step.inputs)}`, "utf8")
    .digest("hex")
    .slice(0, 32);

/** Problems with a value against a step's JSON Schema (empty when it fits). */
export function schemaProblems(
  schema: Record<string, unknown>,
  value: unknown,
  what: string,
): string[] {
  let s: z.ZodType;
  try {
    s = z.fromJSONSchema(schema as never) as z.ZodType;
  } catch {
    const required = (schema.required as string[] | undefined) ?? [];
    return required
      .filter((k) => (value as Record<string, unknown>)?.[k] === undefined)
      .map((k) => `${what}: ${k} is required`);
  }
  const r = s.safeParse(value);
  return r.success
    ? []
    : r.error.issues.map(
        (i) => `${what}${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`,
      );
}

export interface RunStepOptions {
  /** The executor's name in .atticus/executors.yaml. */
  executor: string;
  /** The person's approval of this run; required for a write step, with the inputs' sha-256. */
  approval?: StepApproval;
  fillOnly?: boolean;
  store?: StepStore;
  /** Executors and procedures, when the caller has them (tests); else read from the metarepo. */
  executors?: ExecutorConfig[];
  procedures?: Procedure[];
  client?: ExecutorClient;
  now?: () => string;
  onProgress?: (p: RunProgress) => void;
}

export interface RunStepResult {
  step: ManualStep;
  run: StepRun;
  status: StepRun["status"];
  outputs?: Record<string, unknown>;
  message: string;
  /** True when the step is still open and the person does it themselves. */
  fallback: boolean;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** What the step needs before Atticus calls anything: refusals name the rule. */
export function preflight(
  step: ManualStep,
  procedure: Procedure | undefined,
  executor: ExecutorConfig | undefined,
  o: { name: string; approval?: StepApproval; fillOnly?: boolean },
): { stepDef: Procedure["steps"][number]; problems: string[] } | { refused: string } {
  if (step.state !== "open") return { refused: `Step ${step.id} is already ${step.state}.` };
  if (!step.procedure || !step.procedureStep)
    return {
      refused: `Step ${step.id} names no procedure, so no executor can run it; do it yourself.`,
    };
  if (!procedure) return { refused: `The org pack has no procedure ${step.procedure}.` };
  const stepDef = procedure.steps.find((s) => s.id === step.procedureStep);
  if (!stepDef) return { refused: `Procedure ${procedure.id} has no step ${step.procedureStep}.` };
  if (procedure.status === "retired") return { refused: `Procedure ${procedure.id} is retired.` };
  if (!procedure.executors.allowed.includes(o.name))
    return {
      refused: `Executors are off unless the org pack allows them: process/procedures/${procedure.id}.yaml doesn't list ${o.name} under executors.allowed.`,
    };
  if (!executor) return { refused: `${o.name} isn't in ${EXECUTORS_FILE}.` };
  if (executor.transport === "http" && !isLocalUrl(executor.url!)) {
    const host = new URL(executor.url!).hostname;
    if (!procedure.executors.remoteHosts.includes(host))
      return {
        refused: `${o.name} is at ${host}, not on this machine; the org pack doesn't allow that host for ${procedure.id}.`,
      };
  }
  const declared = executor.procedures.length + executor.stepKinds.length > 0;
  if (
    declared &&
    !executor.procedures.includes(procedure.id) &&
    !executor.procedures.includes(`${procedure.id}/${stepDef.id}`) &&
    !executor.stepKinds.includes(stepDef.kind)
  )
    return { refused: `${o.name} doesn't say it can run ${procedure.id}/${stepDef.id}.` };
  if (o.fillOnly && !executor.fillOnly)
    return { refused: `${o.name} can't fill a form without submitting it.` };
  const sha = inputsSha256(step.inputs);
  if (stepDef.writes) {
    if (!o.approval)
      return {
        refused: `Step ${step.id} writes to ${step.system}: approve this run with its exact inputs (sha-256 ${sha}).`,
      };
    if (o.approval.inputsSha256 !== sha)
      return {
        refused: `The approval doesn't cover these inputs: it is for ${o.approval.inputsSha256 ?? "no inputs"}, the step's inputs are ${sha}. Approve again.`,
      };
    if (o.approval.ref !== step.id)
      return { refused: `The approval is for ${o.approval.ref}, not step ${step.id}.` };
  }
  const secrets = secretKeys(step.inputs);
  if (secrets.length)
    return {
      refused: `The inputs hold what looks like a credential (${secrets.join(", ")}); executors never get credentials.`,
    };
  return { stepDef, problems: schemaProblems(stepDef.inputs, step.inputs, "inputs") };
}

/**
 * Run one manual step with an executor. Returns how the run ended; the step is saved with the
 * run, and closed only when the executor finished and its outputs passed the checks.
 */
export async function runStep(
  root: string,
  stepId: string,
  o: RunStepOptions,
): Promise<RunStepResult> {
  const store = o.store ?? fileStepStore(root);
  let step = await store.get(stepId);
  if (!step) throw new ExecutorError("not-found", `There is no step ${stepId}.`);
  const procedures = o.procedures ?? (await loadOrgPack(join(orgPackDirOf(root)))).procedures;
  // A step made before its procedure was approved: name the procedure now, by template and kind.
  if (!step.procedure && step.state === "open") {
    const s = step;
    const found = procedures.find(
      (p) =>
        p.status !== "retired" &&
        (p.template ? p.template === s.inputs.template : p.system === s.system) &&
        p.steps.some((x) => x.kind === s.action),
    );
    if (found)
      step = await store.save({
        ...s,
        procedure: found.id,
        procedureStep: found.steps.find((x) => x.kind === s.action)!.id,
      });
  }
  const executors = o.executors ?? (await loadExecutors(root)).executors;
  const procedure = procedures.find((p) => p.id === step.procedure);
  const executor = executors.find((e) => e.name === o.executor);
  const pre = preflight(step, procedure, executor, {
    name: o.executor,
    ...(o.approval ? { approval: o.approval } : {}),
    ...(o.fillOnly ? { fillOnly: true } : {}),
  });
  if ("refused" in pre) throw new ExecutorError("refused", pre.refused);
  if (pre.problems.length)
    throw new ExecutorError(
      "invalid",
      `Step ${step.id}'s inputs don't fit procedure ${procedure!.id}.`,
      pre.problems,
    );

  const now = o.now ?? nowIso;
  const key = idempotencyKey(step);
  const client = o.client ?? clientFor(executor!);
  const approval: StepApproval = o.approval ?? { by: step.createdBy, at: now(), ref: step.id };

  // No retry without a new approval, unless the executor says the key was never used.
  const earlier = step.runs.filter((r) => r.idempotencyKey === key && r.status !== "refused");
  const last = earlier.at(-1);
  if (last && pre.stepDef.writes && last.approval.at >= approval.at) {
    // An executor that can't answer counts as "it may have been used".
    const unused = await client.check(key).then(
      (a) => a?.used === false,
      () => false,
    );
    if (!unused)
      throw new ExecutorError(
        "refused",
        `Step ${step.id} already ran with ${last.executor} (${last.status}); it may have gone through. Check the outside system, then approve a new run.`,
      );
  }

  const runId = `${step.id}-${step.runs.length + 1}`;
  const mode = o.fillOnly ? "fill-only" : "submit";
  const base: Omit<StepRun, "status"> = {
    runId,
    executor: o.executor,
    at: now(),
    approval,
    mode,
    idempotencyKey: key,
  };
  let result: RunResult | undefined;
  let status: StepRun["status"];
  let message: string;
  try {
    result = await client.run(
      {
        schemaVersion: 1,
        type: "run",
        runId,
        procedure: procedure!.id,
        step: pre.stepDef.id,
        inputs: step.inputs,
        ...(step.change ? { change: step.change } : {}),
        manualStep: step.id,
        idempotencyKey: key,
        mode,
        ...(pre.stepDef.writes ? { approval } : {}),
      },
      o.onProgress,
    );
    status = result.status;
    message = result.message ?? "";
  } catch (e) {
    if (e instanceof TransportError) {
      status =
        e.kind === "timed-out" ? "timed-out" : e.kind === "unreachable" ? "unreachable" : "failed";
      message = e.message;
    } else if (e instanceof z.ZodError) {
      status = "failed";
      message = `${o.executor} answered something that isn't a valid result: ${e.issues.map((i) => i.message).join("; ")}`;
    } else throw e;
  }

  let outputs: Record<string, unknown> | undefined;
  if (result && status === "done") {
    outputs = result.outputs;
    const problems = [
      ...schemaProblems(pre.stepDef.outputs, outputs, "outputs"),
      ...checkResult(
        step,
        Object.fromEntries(
          Object.entries(outputs).filter(([k]) => step.result.some((f) => f.name === k)),
        ),
      ).problems,
    ];
    if (problems.length) {
      status = "failed";
      message = `${o.executor}'s outputs don't fit the step: ${problems.join("; ")}`;
    }
  }
  const run: StepRun = { ...base, status, finishedAt: now(), ...(message ? { message } : {}) };
  const saved = await store.save({ ...step, runs: [...step.runs, run] });
  if (status === "done" && outputs) {
    const closed = await recordStep(store, step.id, {
      by: approval.by,
      at: now(),
      values: Object.fromEntries(
        Object.entries(outputs).filter(([k]) => step.result.some((f) => f.name === k)),
      ),
      via: "executor",
      executor: o.executor,
      evidence: result?.evidence ?? [],
      note: `Done by ${o.executor}, approved by ${approval.by}.`,
    });
    return {
      step: closed,
      run,
      status,
      outputs,
      message: `${o.executor} did step ${step.id}.`,
      fallback: false,
    };
  }
  const why =
    status === "needs-person"
      ? `${o.executor} stopped and a person finishes step ${step.id}${message ? `: ${message.replace(/[.]+$/, "")}` : ""}.`
      : `${o.executor} didn't finish step ${step.id} (${status}${message ? `: ${message}` : ""}). The step stays open: do it yourself, or approve a new run.`;
  return {
    step: saved,
    run,
    status,
    ...(outputs ? { outputs } : {}),
    message: why,
    fallback: true,
  };
}
