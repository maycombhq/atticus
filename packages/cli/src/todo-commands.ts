import {
  StepError,
  exportStep,
  fileStepStore,
  recordStep,
  type ExportFormat,
} from "@maycombhq/adapters";
import type { ExecutorConfig, ManualStep } from "@maycombhq/core";
import {
  ExecutorError,
  executorsCheck as check,
  inputsSha256,
  runStep,
  type ExecutorClient,
} from "@maycombhq/executors";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus todo / todo show / todo done / todo run / executors check: the manual steps a
 * person does in systems Atticus can't reach (ADR 0032), and the executors that can do them
 * for that person (ADR 0033). Exit codes: 0 ok, 1 problems (or something left to do), 2 usage.
 */

export interface TodoDeps {
  now?: () => Date;
  executors?: ExecutorConfig[];
  client?: ExecutorClient;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function fail(io: Output, e: unknown): number {
  if (
    e instanceof StepError ||
    e instanceof ExecutorError ||
    (e instanceof Error && e.name === "StepFileError")
  ) {
    io.err(e.message);
    for (const p of (e as { problems?: string[] }).problems ?? []) io.err(`  ${p}`);
    return (e as { code?: string }).code === "invalid" ? 2 : 1;
  }
  throw e;
}

/** A step id, or `<change>/<id>`. */
async function findStep(root: string, ref: string): Promise<ManualStep | undefined> {
  const [change, id] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
  const store = fileStepStore(root);
  const all = await store.list(change ? { change } : {});
  return all.find((s) => s.id === id);
}

/** atticus todo [--change <id>] [--all] [--json]: every open manual step, across changes. */
export async function todoList(
  root: string,
  o: { json?: boolean; change?: string; all?: boolean },
  io: Output,
): Promise<number> {
  let steps: ManualStep[];
  try {
    steps = await fileStepStore(root).list(o.change ? { change: o.change } : {});
  } catch (e) {
    return fail(io, e);
  }
  const shown = o.all ? steps : steps.filter((s) => s.state === "open");
  const blocked = (s: ManualStep) =>
    s.dependsOn.filter((d) => steps.find((x) => x.id === d)?.state === "open");
  if (o.json) {
    io.out(
      JSON.stringify(
        shown.map((s) => ({
          id: s.id,
          change: s.change,
          system: s.system,
          action: s.action,
          state: s.state,
          title: s.title,
          where: s.where,
          waitsFor: blocked(s),
          record: s.result.map((f) => ({
            name: f.name,
            label: f.label,
            format: f.format,
            required: f.required,
          })),
          ...(s.procedure ? { procedure: s.procedure } : {}),
          ...(s.reason ? { reason: s.reason } : {}),
          createdAt: s.createdAt,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (shown.length === 0) {
    io.out(o.all ? "No manual steps yet." : "Nothing to do: every manual step is done.");
    return 0;
  }
  io.out(`${shown.length} ${o.all ? "manual" : "open"} step${shown.length === 1 ? "" : "s"}:`);
  for (const line of table(
    ["STEP", "CHANGE", "STATE", "WHAT"],
    shown.map((s) => {
      const w = blocked(s);
      return [
        s.id,
        s.change ?? "-",
        s.state,
        `${s.title}${w.length ? ` (after ${w.join(", ")})` : ""}`,
      ];
    }),
  ))
    io.out(line);
  io.out(
    "Show a step with atticus todo show <step>; record it with atticus todo done <step> --result name=value.",
  );
  return 0;
}

/** atticus todo show <step> [--export text|csv|import] */
export async function todoShow(
  root: string,
  stepRef: string | undefined,
  o: { export?: string },
  io: Output,
): Promise<number> {
  if (!stepRef) {
    io.err("Usage: atticus todo show <step> [--export text|csv|import]");
    return 2;
  }
  const format = (o.export ?? "text") as ExportFormat;
  if (!["text", "csv", "import"].includes(format)) {
    io.err(`Unknown export ${o.export}. Use text, csv or import.`);
    return 2;
  }
  try {
    const s = await findStep(root, stepRef);
    if (!s) {
      io.err(`There is no step ${stepRef}.`);
      return 1;
    }
    for (const l of exportStep(s, format).text.replace(/\n$/, "").split("\n")) io.out(l);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** "--result id=4711 --result url=https://…" → { id: "4711", url: "https://…" } */
function results(
  raw: Record<string, string> | string[] | undefined,
): Record<string, string> | string {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const out: Record<string, string> = {};
  for (const r of raw) {
    const i = r.indexOf("=");
    if (i <= 0) return `--result takes name=value, not ${r}`;
    out[r.slice(0, i).trim()] = r.slice(i + 1).trim();
  }
  return out;
}

/** atticus todo done <step> --by <you> [--result name=value]… [--skip --note <why>] */
export async function todoDone(
  root: string,
  stepRef: string | undefined,
  o: { result?: Record<string, string> | string[]; by?: string; skip?: boolean; note?: string },
  io: Output,
  deps: TodoDeps = {},
): Promise<number> {
  if (!stepRef || !o.by) {
    io.err(
      "Usage: atticus todo done <step> [--by <you>] [--result name=value]… [--skip --note <why>]",
    );
    return 2;
  }
  const values = results(o.result);
  if (typeof values === "string") {
    io.err(values);
    return 2;
  }
  try {
    const s = await findStep(root, stepRef);
    if (!s) {
      io.err(`There is no step ${stepRef}.`);
      return 1;
    }
    const done = await recordStep(fileStepStore(root), s.id, {
      by: o.by,
      at: iso((deps.now ?? (() => new Date()))()),
      values,
      ...(o.skip ? { skip: true } : {}),
      ...(o.note ? { note: o.note } : {}),
    });
    io.out(
      done.state === "skipped"
        ? `Skipped step ${done.id}: ${o.note}`
        : `Recorded step ${done.id}${
            Object.keys(done.recorded?.values ?? {}).length
              ? `: ${Object.entries(done.recorded!.values)
                  .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                  .join(", ")}`
              : ""
          }.`,
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * atticus todo run <step> --with <executor> [--approve <you> --inputs <sha-256>] [--fill-only]
 * Without --approve it shows the exact inputs and their sha-256, which the approval must name.
 */
export async function todoRun(
  root: string,
  stepRef: string | undefined,
  o: { with?: string; approve?: string; inputs?: string; fillOnly?: boolean },
  io: Output,
  deps: TodoDeps = {},
): Promise<number> {
  if (!stepRef || !o.with) {
    io.err(
      "Usage: atticus todo run <step> --with <executor> [--approve <you> --inputs <sha-256>] [--fill-only]",
    );
    return 2;
  }
  try {
    const s = await findStep(root, stepRef);
    if (!s) {
      io.err(`There is no step ${stepRef}.`);
      return 1;
    }
    const sha = inputsSha256(s.inputs);
    if (!o.approve) {
      io.out(`Step ${s.id} would run with ${o.with} on these inputs:`);
      for (const [k, v] of Object.entries(s.inputs))
        io.out(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      io.out(
        `To approve exactly these inputs: atticus todo run ${s.id} --with ${o.with} --approve <you> --inputs ${sha}${o.fillOnly ? " --fill-only" : ""}`,
      );
      return 1;
    }
    const now = deps.now ?? (() => new Date());
    const r = await runStep(root, s.id, {
      executor: o.with,
      approval: {
        by: o.approve.replace(/^@/, ""),
        at: iso(now()),
        ref: s.id,
        ...(o.inputs ? { inputsSha256: o.inputs } : {}),
      },
      ...(o.fillOnly ? { fillOnly: true } : {}),
      ...(deps.executors ? { executors: deps.executors } : {}),
      ...(deps.client ? { client: deps.client } : {}),
      now: () => iso(now()),
      onProgress: (p) => io.out(`  ${p.message}`),
    });
    io.out(r.message);
    if (r.status === "done")
      for (const [k, v] of Object.entries(r.step.recorded?.values ?? {}))
        io.out(`  ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    return r.status === "done" ? 0 : 1;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus executors check [--json] */
export async function executorsCheck(
  root: string,
  o: { json?: boolean },
  io: Output,
  deps: TodoDeps = {},
): Promise<number> {
  const r = await check(root, {
    ...(deps.executors ? { executors: deps.executors } : {}),
    ...(deps.client ? { client: () => deps.client! } : {}),
  });
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return r.executors.every((e) => e.reachable) && r.problems.length === 0 ? 0 : 1;
  }
  for (const p of r.problems) io.err(p);
  if (r.executors.length === 0) {
    io.out(
      "No executors are configured. A person declares theirs in .atticus/executors.yaml; the org pack allows them per procedure.",
    );
    return r.problems.length ? 1 : 0;
  }
  for (const line of table(
    ["EXECUTOR", "TRANSPORT", "ANSWERS", "COVERS", "ALLOWED FOR"],
    r.executors.map((e) => [
      e.name,
      e.transport,
      e.reachable ? `yes${e.version ? ` (${e.version})` : ""}` : "no",
      e.covers.join(", ") || "-",
      e.allowedFor.join(", ") || "nothing (off)",
    ]),
  ))
    io.out(line);
  for (const e of r.executors.filter((x) => x.problem)) io.out(`  ${e.name}: ${e.problem}`);
  for (const m of r.missing)
    io.out(`  Procedure ${m.procedure} allows ${m.executor}, which isn't configured here.`);
  return r.executors.every((e) => e.reachable) && r.problems.length === 0 ? 0 : 1;
}
