import { z } from "zod";
import { IsoDateTime, RecordId } from "./common.js";

/**
 * Contract C4, version 1: manual steps and step executors (ADRs 0032 and 0033).
 *
 * A **manual step** is what a manual adapter produces instead of a write it can't make: what
 * to do, where, every field ready to copy, and what to record back. It is stored as canonical
 * YAML in the change folder (`openspec/changes/<change>/steps/<id>.yaml`), or in `steps/` at
 * the metarepo root when no change owns it, and it is the audit trail of the write.
 *
 * An **executor** is a person's own automation (a script, RPA, a browser agent, an MCP
 * server) that can do a step for them. Atticus calls it through one small protocol, over
 * three transports: `http` (a service at 127.0.0.1), `command` (JSON on stdin, JSON lines on
 * stdout) and `mcp` (tools over stdio JSON-RPC). The person declares where their executors
 * run in `.atticus/executors.yaml` (local, never committed); the org pack decides which may
 * run which procedure (C6 `process/procedures/*.yaml`, `executors.allowed`).
 *
 * Safety rules, not configurable: executors are off unless allowlisted; every write run has
 * a person's approval of the exact inputs (their sha-256); credentials are never passed to an
 * executor or stored from one, so no input or output key may look like a secret.
 *
 * A contract file at version 1. Changing it needs an ADR and a version bump with a migration.
 */
export const EXECUTOR_SCHEMA_VERSION = 1 as const;
const V = z.literal(EXECUTOR_SCHEMA_VERSION);

/** The outside systems a manual adapter stands in for (the model has none: hand-off mode is that). */
export const MANUAL_SYSTEMS = [
  "work-tracker",
  "service-desk",
  "git-host",
  "wiki",
  "notify",
  "design",
] as const;
export const ManualSystem = z.enum(MANUAL_SYSTEMS);
export type ManualSystem = z.infer<typeof ManualSystem>;

/** Keys that look like secrets. Executors never get or give credentials. */
export const SECRET_KEY_PATTERN =
  /(token|password|passwd|secret|api[-_]?key|private[-_]?key|credential|cookie|session[-_]?id)/i;

/** Every key path in a JSON value that looks like a secret. */
export function secretKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretKeys(v, `${prefix}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_PATTERN.test(k)) out.push(path);
    out.push(...secretKeys(v, path));
  }
  return out;
}

const JsonObject = z.record(z.string(), z.unknown());
const noSecrets = (o: Record<string, unknown>, ctx: z.RefinementCtx, path: string) => {
  for (const k of secretKeys(o))
    ctx.addIssue({
      code: "custom",
      path: [path],
      message: `${k} looks like a credential; executors never get or give credentials`,
    });
};

const Handle = z
  .string()
  .min(1)
  .max(100)
  .regex(/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/, "a handle such as pat or @forge/architects");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a sha-256 in hex");

// ------------------------------------------------------------------ manual steps

/** How a value a person records back is checked. */
export const ResultFormat = z.enum([
  "text",
  "url",
  "number",
  "integer",
  "date",
  "yes-no",
  /** A list of handles, comma separated when typed. */
  "handles",
  /** Text matching `pattern`. */
  "pattern",
  /** One of `choices`. */
  "choice",
]);
export type ResultFormat = z.infer<typeof ResultFormat>;

/** A field ready to copy into the outside system. */
export const StepField = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
  help: z.string().optional(),
});

/** Something the person records back once the step is done (the new id, the PR URL). */
export const ResultField = z
  .strictObject({
    /** The key the value is stored under, e.g. `id`, `url`, `approvers`. */
    name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "a camelCase key such as requestNumber"),
    label: z.string().min(1),
    format: ResultFormat,
    required: z.boolean().default(true),
    pattern: z.string().optional(),
    choices: z.array(z.string().min(1)).optional(),
    help: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.format === "pattern") {
      if (!f.pattern)
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "a pattern field needs one" });
      else
        try {
          new RegExp(f.pattern);
        } catch {
          ctx.addIssue({ code: "custom", path: ["pattern"], message: "not a valid pattern" });
        }
    }
    if (f.format === "choice" && !f.choices?.length)
      ctx.addIssue({ code: "custom", path: ["choices"], message: "a choice field needs choices" });
  });
export type ResultField = z.infer<typeof ResultField>;

export const StepEvidence = z.strictObject({
  kind: z.enum(["screenshot", "page", "log", "file", "link"]),
  /** A file path, page URL or log reference: never the content of a credential. */
  ref: z.string().min(1),
  at: IsoDateTime.optional(),
});

/** A person's approval of one write, with the sha-256 of the exact inputs when an executor runs it. */
export const StepApproval = z.strictObject({
  by: Handle,
  at: IsoDateTime,
  ref: z.string().min(1),
  inputsSha256: Sha256.optional(),
});
export type StepApproval = z.infer<typeof StepApproval>;

export const RunStatus = z.enum(["done", "failed", "needs-person"]);

/** One executor run on a step, kept for the audit trail and the retry rule. */
export const StepRun = z.strictObject({
  runId: z.string().min(1),
  executor: RecordId,
  at: IsoDateTime,
  finishedAt: IsoDateTime.optional(),
  approval: StepApproval,
  mode: z.enum(["submit", "fill-only"]),
  idempotencyKey: z.string().min(8),
  /** `timed-out` and `unreachable` are Atticus's own: the executor never answered. */
  status: z.enum(["done", "failed", "needs-person", "timed-out", "unreachable", "refused"]),
  message: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRun>;

export const RecordedResult = z.strictObject({
  at: IsoDateTime,
  /** The person who did it, or who approved the executor run that did. */
  by: Handle,
  values: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .default({}),
  via: z.enum(["person", "executor"]).default("person"),
  executor: RecordId.optional(),
  evidence: z.array(StepEvidence).default([]),
  /** Why a step was skipped, or anything the person adds. */
  note: z.string().optional(),
});

export const StepState = z.enum(["open", "done", "skipped"]);

export const ManualStep = z
  .strictObject({
    schemaVersion: V,
    id: RecordId,
    change: RecordId.optional(),
    system: ManualSystem,
    /** What kind of write this stands for: create-work-item, submit-request, open-pull-request, … */
    action: RecordId,
    /** Same key, same step: creating it again returns the existing one. */
    key: z.string().min(1),
    /** One sentence: what to do. */
    title: z.string().min(1),
    /** Where to do it: the system and the form, project or repo. */
    where: z.string().min(1),
    /** The org-pack procedure (C6) this step follows, and its step. */
    procedure: RecordId.optional(),
    procedureStep: RecordId.optional(),
    /** The procedure step's inputs, filled: what an executor gets. */
    inputs: JsonObject.default({}),
    fields: z.array(StepField).default([]),
    instructions: z.array(z.string().min(1)).default([]),
    result: z.array(ResultField).default([]),
    state: StepState.default("open"),
    /** Steps that must be done first (their recorded values may fill this one's fields). */
    dependsOn: z.array(RecordId).default([]),
    createdAt: IsoDateTime,
    createdBy: Handle,
    /** The approval behind the write this step stands in for. */
    approval: StepApproval.optional(),
    /** Why the step is manual: the adapter is manual, or a live one failed. */
    reason: z.string().optional(),
    recorded: RecordedResult.optional(),
    runs: z.array(StepRun).default([]),
  })
  .superRefine((s, ctx) => {
    noSecrets(s.inputs, ctx, "inputs");
    if (s.state !== "open" && !s.recorded)
      ctx.addIssue({
        code: "custom",
        path: ["recorded"],
        message: `a ${s.state} step records who and when`,
      });
    if (s.state === "done" && s.recorded)
      for (const f of s.result)
        if (f.required && s.recorded.values[f.name] === undefined)
          ctx.addIssue({
            code: "custom",
            path: ["recorded", "values", f.name],
            message: `${f.label} is required`,
          });
    if (s.state === "skipped" && !s.recorded?.note)
      ctx.addIssue({
        code: "custom",
        path: ["recorded", "note"],
        message: "say why it was skipped",
      });
    const names = new Set<string>();
    s.result.forEach((f, i) => {
      if (names.has(f.name))
        ctx.addIssue({ code: "custom", path: ["result", i], message: `duplicate ${f.name}` });
      names.add(f.name);
    });
  });
export type ManualStep = z.infer<typeof ManualStep>;
export type ManualStepInput = z.input<typeof ManualStep>;

// ------------------------------------------------------------------ executors

export const ExecutorTransport = z.enum(["http", "command", "mcp"]);
export type ExecutorTransport = z.infer<typeof ExecutorTransport>;

/** One executor as the person declares it in `.atticus/executors.yaml`. */
export const ExecutorConfig = z
  .strictObject({
    name: RecordId,
    transport: ExecutorTransport,
    /** http: the base URL, normally http://127.0.0.1:<port>. */
    url: z.url().optional(),
    /** command and mcp: the program and its arguments. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** What it can run: procedure ids, or `<procedure>/<step>`. Empty: ask it (ping). */
    procedures: z.array(z.string().min(1)).default([]),
    /** Step kinds it can run whatever the procedure (e.g. submit-request). */
    stepKinds: z.array(RecordId).default([]),
    /** Whether it can fill a form without submitting it. */
    fillOnly: z.boolean().default(false),
    timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
    /** mcp: tool names by `<procedure>/<step>`; default `<procedure>_<step>`. */
    tools: z.record(z.string(), z.string().min(1)).default({}),
  })
  .superRefine((e, ctx) => {
    if (e.transport === "http" && !e.url)
      ctx.addIssue({ code: "custom", path: ["url"], message: "an http executor needs its url" });
    if (e.transport !== "http" && !e.command)
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: `a ${e.transport} executor needs its command`,
      });
  });
export type ExecutorConfig = z.infer<typeof ExecutorConfig>;

export const ExecutorsFile = z
  .strictObject({ schemaVersion: V, executors: z.array(ExecutorConfig).default([]) })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.executors.forEach((e, i) => {
      if (seen.has(e.name))
        ctx.addIssue({ code: "custom", path: ["executors", i], message: `duplicate ${e.name}` });
      seen.add(e.name);
    });
  });
export type ExecutorsFile = z.infer<typeof ExecutorsFile>;

/** Atticus → executor: run one step of a procedure. */
export const RunRequest = z
  .strictObject({
    schemaVersion: V,
    type: z.literal("run"),
    runId: z.string().min(1),
    procedure: RecordId,
    step: RecordId,
    inputs: JsonObject,
    change: RecordId.optional(),
    task: z.string().min(1).optional(),
    /** The manual step this run stands in for. */
    manualStep: RecordId.optional(),
    /** The same write always carries the same key, so the executor can refuse a duplicate. */
    idempotencyKey: z.string().min(8),
    mode: z.enum(["submit", "fill-only"]).default("submit"),
    /** Required for write steps, with the sha-256 of exactly these inputs. */
    approval: StepApproval.optional(),
  })
  .superRefine((r, ctx) => noSecrets(r.inputs, ctx, "inputs"));
export type RunRequest = z.infer<typeof RunRequest>;

/** Executor → Atticus, any number of times before the result. */
export const RunProgress = z.strictObject({
  type: z.literal("progress"),
  runId: z.string().min(1),
  message: z.string().min(1),
  percent: z.number().min(0).max(100).optional(),
  at: IsoDateTime.optional(),
});
export type RunProgress = z.infer<typeof RunProgress>;

/** Executor → Atticus, once: what happened. */
export const RunResult = z
  .strictObject({
    type: z.literal("result"),
    runId: z.string().min(1),
    status: RunStatus,
    outputs: JsonObject.default({}),
    evidence: z.array(StepEvidence).default([]),
    message: z.string().optional(),
    startedAt: IsoDateTime.optional(),
    finishedAt: IsoDateTime.optional(),
  })
  .superRefine((r, ctx) => noSecrets(r.outputs, ctx, "outputs"));
export type RunResult = z.infer<typeof RunResult>;

/** Atticus → executor: are you there, and what can you run? */
export const PingRequest = z.strictObject({ type: z.literal("ping") });
export const PingResponse = z.strictObject({
  type: z.literal("pong"),
  name: z.string().min(1),
  version: z.string().min(1),
  procedures: z.array(z.string().min(1)).default([]),
  stepKinds: z.array(z.string().min(1)).default([]),
  fillOnly: z.boolean().default(false),
});
export type PingResponse = z.infer<typeof PingResponse>;

/** Atticus → executor: was this idempotency key used? Only a "no" allows a retry without new approval. */
export const IdempotencyCheck = z.strictObject({
  type: z.literal("check"),
  idempotencyKey: z.string().min(8),
});
export const IdempotencyAnswer = z.strictObject({
  type: z.literal("checked"),
  idempotencyKey: z.string().min(8),
  used: z.boolean(),
});
export type IdempotencyAnswer = z.infer<typeof IdempotencyAnswer>;

/** JSON Schema for the C4 step and executor files and messages. */
export function executorJsonSchemas(): Record<string, object> {
  const files: Record<string, z.ZodType> = {
    ManualStep,
    ExecutorsFile,
    RunRequest,
    RunProgress,
    RunResult,
    PingResponse,
    IdempotencyAnswer,
  };
  const out: Record<string, object> = {};
  for (const [name, schema] of Object.entries(files))
    out[name] = {
      $id: `https://maycombhq.github.io/atticus/schema/executors/v1/${name}.json`,
      title: name,
      ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    };
  return out;
}
