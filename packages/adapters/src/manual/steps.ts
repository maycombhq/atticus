import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import {
  changesDirOf,
  ManualStep,
  toCanonicalYaml,
  type ManualStepInput,
  type ResultField,
  type StepApproval,
} from "@maycombhq/core";

/**
 * Where manual steps live (ADR 0032). A step is the record of a write Atticus couldn't make:
 * it is created once per key (creating it again returns the existing step), done by a person
 * in the real system, and closed by recording the result, which is checked against the
 * step's result fields. Files are canonical YAML in the change folder,
 * `openspec/changes/<change>/steps/<id>.yaml`, or `steps/<id>.yaml` at the metarepo root
 * when no change owns the step.
 */

export type NewStep = Omit<
  ManualStepInput,
  "schemaVersion" | "id" | "createdAt" | "state" | "recorded" | "runs"
> & {
  /** A readable id stem; the store makes it unique. */
  slug: string;
  createdAt?: string;
};

export interface StepFilter {
  change?: string;
  state?: ManualStep["state"];
  system?: ManualStep["system"];
  action?: string;
}

export interface StepStore {
  /** Create the step, or return the existing one with the same key. */
  create(step: NewStep): Promise<ManualStep>;
  get(id: string): Promise<ManualStep | undefined>;
  byKey(key: string): Promise<ManualStep | undefined>;
  list(filter?: StepFilter): Promise<ManualStep[]>;
  /** Replace a step (validated). */
  save(step: ManualStep): Promise<ManualStep>;
}

const LEADING = [
  "schemaVersion",
  "id",
  "change",
  "system",
  "action",
  "state",
  "title",
  "where",
  "key",
  "name",
  "label",
  "value",
  "format",
];

export function serializeStep(step: ManualStep): string {
  return toCanonicalYaml(ManualStep.parse(step), LEADING);
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "") || "step";

export const shortHash = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function matches(s: ManualStep, f: StepFilter = {}): boolean {
  return (
    (!f.change || s.change === f.change) &&
    (!f.state || s.state === f.state) &&
    (!f.system || s.system === f.system) &&
    (!f.action || s.action === f.action)
  );
}

const byCreated = (a: ManualStep, b: ManualStep) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;

function build(step: NewStep, id: string): ManualStep {
  const { slug: _slug, createdAt, ...rest } = step;
  return ManualStep.parse({
    schemaVersion: 1,
    ...rest,
    id,
    createdAt: createdAt ?? nowIso(),
    state: "open",
    runs: [],
  });
}

function uniqueId(slug: string, taken: Set<string>): string {
  const base = slugify(slug);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** An in-memory store, for tests and dry runs. */
export function memoryStepStore(seed: ManualStep[] = []): StepStore {
  const steps = new Map(seed.map((s) => [s.id, ManualStep.parse(s)]));
  return {
    async create(step) {
      const found = [...steps.values()].find((s) => s.key === step.key);
      if (found) return structuredClone(found);
      const s = build(step, uniqueId(step.slug, new Set(steps.keys())));
      steps.set(s.id, s);
      return structuredClone(s);
    },
    async get(id) {
      const s = steps.get(id);
      return s ? structuredClone(s) : undefined;
    },
    async byKey(key) {
      const s = [...steps.values()].find((x) => x.key === key);
      return s ? structuredClone(s) : undefined;
    },
    async list(filter) {
      return [...steps.values()]
        .filter((s) => matches(s, filter))
        .sort(byCreated)
        .map((s) => structuredClone(s));
    },
    async save(step) {
      const s = ManualStep.parse(step);
      steps.set(s.id, s);
      return structuredClone(s);
    },
  };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export class StepFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "StepFileError";
  }
}

/**
 * Steps as files in the metarepo. Ids are unique across the whole metarepo, so a person can
 * name a step by its id alone (`atticus todo done <id>`).
 */
export function fileStepStore(root: string): StepStore & { pathOf(step: ManualStep): string } {
  const dirFor = (change?: string) =>
    change ? join(changesDirOf(root), change, "steps") : join(root, "steps");
  const pathOf = (s: ManualStep) => join(dirFor(s.change), `${s.id}.yaml`);

  async function folders(): Promise<string[]> {
    const out = [join(root, "steps")];
    try {
      for (const d of await readdir(changesDirOf(root), { withFileTypes: true }))
        if (d.isDirectory() && d.name !== "archive")
          out.push(join(changesDirOf(root), d.name, "steps"));
    } catch {
      // no changes yet
    }
    return out;
  }

  // Parsed files by path, reread only when the file's size or time changes (a person may edit
  // a step by hand, or another command may record one).
  const cache = new Map<string, { mtimeMs: number; size: number; step: ManualStep }>();

  async function readAll(): Promise<ManualStep[]> {
    const out: ManualStep[] = [];
    for (const dir of await folders()) {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        const path = join(dir, n);
        const st = await stat(path);
        const hit = cache.get(path);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          out.push(structuredClone(hit.step));
          continue;
        }
        let data: unknown;
        try {
          data = parse(await readFile(path, "utf8"));
        } catch (e) {
          throw new StepFileError(`${path}: invalid YAML: ${(e as Error).message}`, path);
        }
        const r = ManualStep.safeParse(data);
        if (!r.success)
          throw new StepFileError(
            `${path}: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ")}`,
            path,
          );
        cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, step: r.data });
        out.push(structuredClone(r.data));
      }
    }
    return out.sort(byCreated);
  }

  return {
    pathOf,
    async create(step) {
      const all = await readAll();
      const found = all.find((s) => s.key === step.key);
      if (found) return found;
      const s = build(step, uniqueId(step.slug, new Set(all.map((x) => x.id))));
      await writeAtomic(pathOf(s), serializeStep(s));
      cache.delete(pathOf(s));
      return s;
    },
    async get(id) {
      return (await readAll()).find((s) => s.id === id);
    },
    async byKey(key) {
      return (await readAll()).find((s) => s.key === key);
    },
    async list(filter) {
      return (await readAll()).filter((s) => matches(s, filter));
    },
    async save(step) {
      const s = ManualStep.parse(step);
      await writeAtomic(pathOf(s), serializeStep(s));
      cache.delete(pathOf(s));
      return s;
    },
  };
}

// ------------------------------------------------------------------ recording results

export type RecordedValue = string | number | boolean | string[];

const HANDLE = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Check one value a person typed (or an executor returned) against its result field. */
export function checkValue(
  field: ResultField,
  raw: unknown,
): { ok: true; value: RecordedValue } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem: `${field.label}: ${problem}` });
  if (field.format === "handles") {
    const list = Array.isArray(raw)
      ? raw.map(String)
      : String(raw ?? "")
          .split(/[\s,;]+/)
          .filter(Boolean);
    const wrong = list.filter((h) => !HANDLE.test(h));
    if (wrong.length) return bad(`${wrong.join(", ")} isn't a handle such as pat`);
    return { ok: true, value: list.map((h) => h.replace(/^@/, "")) };
  }
  if (typeof raw === "boolean" && field.format === "yes-no") return { ok: true, value: raw };
  if (typeof raw === "number" && (field.format === "number" || field.format === "integer")) {
    if (field.format === "integer" && !Number.isInteger(raw)) return bad("a whole number");
    return { ok: true, value: raw };
  }
  const s = String(raw ?? "").trim();
  if (!s) return bad("empty");
  switch (field.format) {
    case "text":
      return { ok: true, value: s };
    case "url":
      try {
        const u = new URL(s);
        if (u.protocol !== "https:" && u.protocol !== "http:") return bad("an http(s) link");
        return { ok: true, value: s };
      } catch {
        return bad(`${s} isn't a link`);
      }
    case "number":
    case "integer": {
      const n = Number(s);
      if (!Number.isFinite(n)) return bad(`${s} isn't a number`);
      if (field.format === "integer" && !Number.isInteger(n))
        return bad(`${s} isn't a whole number`);
      return { ok: true, value: n };
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
        return bad(`${s} isn't a date such as 2026-10-21`);
      return { ok: true, value: s };
    case "yes-no": {
      const k = s.toLowerCase();
      if (["yes", "y", "true"].includes(k)) return { ok: true, value: true };
      if (["no", "n", "false"].includes(k)) return { ok: true, value: false };
      return bad("yes or no");
    }
    case "pattern":
      return new RegExp(`^(?:${field.pattern})$`).test(s)
        ? { ok: true, value: s }
        : bad(`${s} doesn't look right (expected ${field.help ?? field.pattern})`);
    case "choice":
      return field.choices?.includes(s)
        ? { ok: true, value: s }
        : bad(`one of ${field.choices?.join(", ")}`);
  }
}

/** Check every value against the step's result fields. Unknown keys are refused. */
export function checkResult(
  step: Pick<ManualStep, "result">,
  values: Record<string, unknown>,
): { values: Record<string, RecordedValue>; problems: string[] } {
  const out: Record<string, RecordedValue> = {};
  const problems: string[] = [];
  const known = new Set(step.result.map((f) => f.name));
  for (const k of Object.keys(values))
    if (!known.has(k))
      problems.push(
        `${k} isn't asked for here${known.size ? ` (record ${[...known].join(", ")})` : ""}`,
      );
  for (const f of step.result) {
    const raw = values[f.name];
    if (raw === undefined || raw === "") {
      if (f.required) problems.push(`${f.label}: required`);
      continue;
    }
    const r = checkValue(f, raw);
    if (r.ok) out[f.name] = r.value;
    else problems.push(r.problem);
  }
  return { values: out, problems };
}

export class StepError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "refused",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "StepError";
  }
}

/**
 * Close a step with what the person (or an executor, for the person who approved it) did:
 * values are checked against the step's result fields, steps it depends on must be closed.
 */
export async function recordStep(
  store: StepStore,
  id: string,
  o: {
    by: string;
    at?: string;
    values?: Record<string, unknown>;
    via?: "person" | "executor";
    executor?: string;
    evidence?: NonNullable<ManualStep["recorded"]>["evidence"];
    note?: string;
    skip?: boolean;
  },
): Promise<ManualStep> {
  const step = await store.get(id);
  if (!step) throw new StepError("not-found", `There is no step ${id}.`);
  if (step.state !== "open") throw new StepError("refused", `Step ${id} is already ${step.state}.`);
  if (o.skip) {
    if (!o.note?.trim()) throw new StepError("invalid", `Say why step ${id} is skipped.`);
    return store.save({
      ...step,
      state: "skipped",
      recorded: {
        at: o.at ?? nowIso(),
        by: o.by.replace(/^@/, ""),
        values: {},
        via: "person",
        evidence: [],
        note: o.note,
      },
    });
  }
  for (const d of step.dependsOn) {
    const dep = await store.get(d);
    if (dep && dep.state === "open")
      throw new StepError("refused", `Do step ${d} first: step ${id} depends on it.`);
  }
  const r = checkResult(step, o.values ?? {});
  if (r.problems.length)
    throw new StepError("invalid", `The result for step ${id} isn't valid.`, r.problems);
  return store.save({
    ...step,
    state: "done",
    recorded: {
      at: o.at ?? nowIso(),
      by: o.by.replace(/^@/, ""),
      values: r.values,
      via: o.via ?? "person",
      ...(o.executor ? { executor: o.executor } : {}),
      evidence: o.evidence ?? [],
      ...(o.note ? { note: o.note } : {}),
    },
  });
}

/** The approval as a step stores it. */
export const stepApproval = (a: { by: string; at: string; ref: string }): StepApproval => ({
  by: a.by.replace(/^@/, ""),
  at: a.at,
  ref: a.ref,
});

// ------------------------------------------------------------------ export

export type ExportFormat = "text" | "csv" | "import";

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvRow = (cells: string[]) => cells.map(csvCell).join(",");

/** Column names the common work trackers' CSV import accepts. */
const WORK_ITEM_COLUMNS: [string, string][] = [
  ["Work Item Type", "Work item type"],
  ["Title", "Title"],
  ["Description", "Description"],
  ["Acceptance Criteria", "Acceptance criteria"],
  ["Parent", "Parent"],
  ["Tags", "Tags"],
  ["Assigned To", "Assigned to"],
];

/**
 * A step ready to paste or import: plain text (a checklist), CSV (one row per field), or the
 * system's import format where it has one (a work-item CSV row, a request as JSON).
 */
export function exportStep(
  step: ManualStep,
  format: ExportFormat,
): { format: string; fileName: string; text: string } {
  const field = (n: string) =>
    step.fields.find((f) => f.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  if (format === "csv")
    return {
      format: "csv",
      fileName: `${step.id}.csv`,
      text:
        [csvRow(["Field", "Value"]), ...step.fields.map((f) => csvRow([f.name, f.value]))].join(
          "\n",
        ) + "\n",
    };
  if (format === "import" && step.system === "work-tracker" && step.action === "create-work-item")
    return {
      format: "work-item-csv",
      fileName: `${step.id}.csv`,
      text:
        [
          csvRow(WORK_ITEM_COLUMNS.map(([c]) => c)),
          csvRow(WORK_ITEM_COLUMNS.map(([, f]) => field(f))),
        ].join("\n") + "\n",
    };
  if (format === "import" && step.system === "service-desk" && step.action === "submit-request")
    return {
      format: "request-json",
      fileName: `${step.id}.json`,
      text:
        JSON.stringify(
          {
            requestType: field("Request type"),
            fields: Object.fromEntries(
              step.fields.filter((f) => f.name !== "Request type").map((f) => [f.name, f.value]),
            ),
          },
          null,
          2,
        ) + "\n",
    };
  const lines = [
    `Step ${step.id}: ${step.title}`,
    `Where: ${step.where}`,
    ...(step.reason ? [`Why it is manual: ${step.reason}`] : []),
    ...(step.dependsOn.length ? [`Do first: ${step.dependsOn.join(", ")}`] : []),
    "",
    ...(step.instructions.length
      ? ["Steps:", ...step.instructions.map((s, i) => `${i + 1}. ${s}`), ""]
      : []),
    ...(step.fields.length
      ? ["Fields:", ...step.fields.map((f) => `${f.name}: ${f.value}`), ""]
      : []),
    ...(step.result.length
      ? [
          "Record back:",
          ...step.result.map(
            (f) =>
              `- ${f.label}${f.required ? "" : " (optional)"}: atticus todo done ${step.id} --result ${f.name}=…`,
          ),
        ]
      : [`When done: atticus todo done ${step.id}`]),
  ];
  return {
    format: "text",
    fileName: `${step.id}.txt`,
    text: lines.join("\n").replace(/\n+$/, "") + "\n",
  };
}
