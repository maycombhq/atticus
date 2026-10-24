import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { writeFileAtomic } from "./fs.js";
import { judgmentsDirOf, judgmentsRelOf } from "./metarepo.js";
import { canonicalize, toCanonicalYaml } from "./serialize.js";
import {
  Judgment,
  JudgmentKey,
  JudgmentKind,
  JUDGMENT_SCHEMA_VERSION,
  type JudgmentConfirmer,
  type JudgmentVerdict,
} from "./schema/judgment.js";

/**
 * The judgments store (ADR 0117): judgments/<kind>/<key>.yaml, the key a hash of the inputs.
 * Any step that asks a model a closed question about meaning keeps the answer here (the judge
 * step in @maycombhq/ai, and the context engine's query expansion and rerank), so the same
 * commit with the same inputs reads the stored verdict and never asks again, and a changed input
 * invalidates only its own judgment.
 *
 * The interface is two calls, get and put by kind and key; `judgmentKey` makes the key.
 */
export interface JudgmentStore {
  get(kind: string, key: string): Promise<Judgment | undefined>;
  /**
   * Keep a judgment. A person's verdict on file is never replaced by a model's or a check's:
   * the stored one comes back instead.
   */
  put(j: Judgment): Promise<Judgment>;
}

/**
 * The key of a judgment: 24 hex characters of the sha256 of the kind and the inputs in
 * canonical form (keys sorted, undefined left out), so the same inputs in any key order give
 * the same key.
 */
export function judgmentKey(kind: string, inputs: unknown): string {
  JudgmentKind.parse(kind);
  const text = JSON.stringify(canonicalize(inputs, []));
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 24);
}

/** A new judgment at the current schema version, its key made from the inputs. */
export function makeJudgment(o: {
  kind: string;
  inputs: Record<string, unknown>;
  verdict: JudgmentVerdict;
  confirmedBy: JudgmentConfirmer;
  at: string;
  value?: unknown;
  quotes?: { of: string; text: string }[];
  why?: string;
}): Judgment {
  return Judgment.parse({
    schemaVersion: JUDGMENT_SCHEMA_VERSION,
    kind: o.kind,
    key: judgmentKey(o.kind, o.inputs),
    verdict: o.verdict,
    ...(o.value !== undefined ? { value: o.value } : {}),
    quotes: o.quotes ?? [],
    ...(o.why ? { why: o.why } : {}),
    inputs: o.inputs,
    confirmedBy: o.confirmedBy,
    at: o.at,
  });
}

const keep = (stored: Judgment | undefined, next: Judgment) =>
  stored?.confirmedBy.by === "person" && next.confirmedBy.by !== "person" ? stored : next;

/** The store in the metarepo: judgments/ (or .atticus/judgments/ when adopted). */
export function fileJudgments(root: string): JudgmentStore & {
  list(
    kind?: string,
  ): Promise<{ judgments: Judgment[]; problems: { file: string; message: string }[] }>;
} {
  const dir = judgmentsDirOf(root);
  const fileOf = (kind: string, key: string) => join(dir, kind, `${key}.yaml`);
  const get = async (kind: string, key: string) => {
    if (!JudgmentKind.safeParse(kind).success || !JudgmentKey.safeParse(key).success)
      return undefined;
    const text = await readFile(fileOf(kind, key), "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    const r = Judgment.safeParse(parse(text));
    return r.success && r.data.kind === kind && r.data.key === key ? r.data : undefined;
  };
  return {
    get,
    async put(j) {
      const next = Judgment.parse(j);
      const kept = keep(await get(next.kind, next.key), next);
      if (kept !== next) return kept;
      await mkdir(join(dir, next.kind), { recursive: true });
      await writeFileAtomic(
        fileOf(next.kind, next.key),
        `# A judgment (ADR 0117): ${next.kind}, ${next.confirmedBy.by === "person" ? `decided by ${next.confirmedBy.name}` : next.confirmedBy.by === "ai" ? `answered by run ${next.confirmedBy.run}` : `settled by the check ${next.confirmedBy.rule}`}. To override it, change verdict, set confirmedBy to { by: person, name: <your Git user> } and keep what it said under overrides; commit it for review.\n${toCanonicalYaml(next, ["schemaVersion", "kind", "key", "verdict", "value"])}`,
      );
      return next;
    },
    async list(kind) {
      const rel = judgmentsRelOf(root);
      const kinds = kind ? [kind] : (await readdir(dir).catch(() => [] as string[])).sort();
      const judgments: Judgment[] = [];
      const problems: { file: string; message: string }[] = [];
      for (const k of kinds)
        for (const n of (await readdir(join(dir, k)).catch(() => [] as string[]))
          .filter((x) => x.endsWith(".yaml"))
          .sort()) {
          const file = `${rel}/${k}/${n}`;
          try {
            const r = Judgment.safeParse(parse(await readFile(join(dir, k, n), "utf8")));
            if (r.success) judgments.push(r.data);
            else
              problems.push({
                file,
                message: r.error.issues
                  .map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`)
                  .join("; "),
              });
          } catch (e) {
            problems.push({ file, message: (e as Error).message.split("\n")[0]! });
          }
        }
      return { judgments, problems };
    },
  };
}

/** A store in memory, for tests and for a step run without a metarepo. */
export function memoryJudgments(initial: Judgment[] = []): JudgmentStore & {
  all(): Judgment[];
} {
  const m = new Map(initial.map((j) => [`${j.kind}/${j.key}`, Judgment.parse(j)]));
  return {
    async get(kind, key) {
      return m.get(`${kind}/${key}`);
    },
    async put(j) {
      const next = Judgment.parse(j);
      const kept = keep(m.get(`${next.kind}/${next.key}`), next);
      m.set(`${next.kind}/${next.key}`, kept);
      return kept;
    },
    all: () => [...m.values()],
  };
}

/**
 * A person overrides a judgment: their verdict is kept, with the one it replaced under
 * `overrides`. Every step that reads the judgment follows the person from then on.
 */
export async function overrideJudgment(
  store: JudgmentStore,
  kind: string,
  key: string,
  o: { verdict: JudgmentVerdict; value?: unknown; name: string; at: string; why?: string },
): Promise<Judgment> {
  const was = await store.get(kind, key);
  if (!was) throw new Error(`There is no judgment ${kind}/${key}.`);
  const original = was.overrides ?? {
    verdict: was.verdict,
    ...(was.value !== undefined ? { value: was.value } : {}),
    confirmedBy: was.confirmedBy,
  };
  return store.put(
    Judgment.parse({
      ...was,
      verdict: o.verdict,
      ...(o.value !== undefined ? { value: o.value } : {}),
      ...(o.why ? { why: o.why } : {}),
      confirmedBy: { by: "person", name: o.name },
      overrides: original,
      at: o.at,
    }),
  );
}
