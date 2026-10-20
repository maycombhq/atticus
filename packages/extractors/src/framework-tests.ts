import type { CatalogRecord, FrameworkModel } from "@maycombhq/core";
import { memoryRepo, scanRepo } from "@maycombhq/sdk";
import { houseExtractor } from "./house.js";
import { springExtractor } from "./spring.js";

/** A failed framework test, or "(coverage)" for an entry no test exercises. */
export interface FrameworkTestFailure {
  test: string;
  message: string;
}

const SHA = "0".repeat(40);
type Entries = "annotations" | "clients" | "calls" | "routes";
const ENTRIES: Entries[] = ["annotations", "clients", "calls", "routes"];

/** One record as a test line: "endpoint GET /x inferred" or "<loose-end kind> <raw>". */
export function frameworkTestLine(r: CatalogRecord): string | undefined {
  const x = r as unknown as {
    unresolvedKind?: string;
    raw?: string;
    method?: string;
    pathOrTopic?: string;
    confidence?: string;
  };
  if (r.kind === "Endpoint") return `endpoint ${x.method} ${x.pathOrTopic} ${x.confidence}`;
  if (r.kind === "Unresolved") return `${x.unresolvedKind} ${x.raw}`;
  return undefined;
}

/** What one test's files give, read with only this model, as sorted distinct lines. */
async function linesOf(model: FrameworkModel, files: Record<string, string>): Promise<string[]> {
  const s = await scanRepo({
    repo: memoryRepo(model.name, SHA, files),
    extractors: [springExtractor, houseExtractor],
    repoInfo: { component: model.name },
    frameworks: [model],
  });
  const lines = s.records.map(frameworkTestLine).filter((l): l is string => l !== undefined);
  return [...new Set(lines)].sort();
}

/** An endpoint line may leave out its confidence: learning from code later makes it verified. */
const same = (line: string, expected: string) =>
  line === expected || (line.startsWith("endpoint ") && line.replace(/ \S+$/, "") === expected);

const label = (list: Entries, e: Record<string, unknown>) =>
  `${list} ${list === "clients" ? `${String(e.type)}.${String(e.method)}` : String(e.name ?? e.function)}`;

/**
 * Run a model's own tests (ADR 0055). Each test must give exactly its expected lines, and every
 * annotation, client, call and route a document or a person gave must be exercised: taking it
 * out must change what some test gives. (What was read from code or bytecode is a reading, not
 * a draft.) A model with no tests has nothing to run and passes.
 */
export async function runFrameworkTests(model: FrameworkModel): Promise<FrameworkTestFailure[]> {
  if (model.tests.length === 0) return [];
  const failures: FrameworkTestFailure[] = [];
  const got: string[][] = [];
  for (const t of model.tests) {
    const lines = await linesOf(model, t.files);
    got.push(lines);
    const missing = t.expect.find((e) => !lines.some((l) => same(l, e)));
    const extra = lines.find((l) => !t.expect.some((e) => same(l, e)));
    if (missing !== undefined)
      failures.push({
        test: t.name,
        message: `expected "${missing}"; got: ${lines.join(", ") || "nothing"}`,
      });
    else if (extra !== undefined)
      failures.push({ test: t.name, message: `gave "${extra}", which the test doesn't expect` });
  }
  for (const list of ENTRIES) {
    const entries = model[list] as Record<string, unknown>[];
    for (let i = 0; i < entries.length; i++) {
      const kind = (entries[i]!.source as { kind: string }).kind;
      if (kind === "code" || kind === "bytecode") continue;
      const without = { ...model, [list]: entries.filter((_, j) => j !== i) } as FrameworkModel;
      let changed = false;
      for (let k = 0; k < model.tests.length && !changed; k++) {
        const lines = await linesOf(without, model.tests[k]!.files);
        changed = lines.join("\n") !== got[k]!.join("\n");
      }
      if (!changed)
        failures.push({
          test: "(coverage)",
          message: `${label(list, entries[i]!)} isn't exercised by any test`,
        });
    }
  }
  return failures;
}
