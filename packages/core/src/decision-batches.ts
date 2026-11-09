import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { DecisionBatch, type DecisionBatchT } from "./ai-decisions.js";
import { withSharedFileLock, writeFileAtomic } from "./fs.js";
import { decisionsDirOf, decisionsRelOf, factsDirOf, factsRelOf } from "./metarepo.js";
import { FACT_CORRECTIONS_SCHEMA_VERSION } from "./schema/fact-corrections.js";
import { BatchId } from "./schema/question.js";

/**
 * ADR 0181: the batch records under `decisions/` (`.atticus/decisions/` when adopted), one file
 * per batch, and the `corrections-v2` upgrade step. The lines a batch names stay in the repos'
 * corrections files and the answers in the question files; the record is what Undo reads.
 */

/** Where a batch's record is, relative to the root. */
export const batchRelOf = (root: string, id: string) => `${decisionsRelOf(root)}/${id}.yaml`;

/** Write a batch's record (a new one, or the same one undone). */
export async function writeBatch(root: string, b: DecisionBatchT): Promise<string> {
  const p = DecisionBatch.parse(b);
  await writeFileAtomic(
    join(decisionsDirOf(root), `${p.id}.yaml`),
    `# A batch of decisions (ADR 0181): what it applied and what it took away. Undo: atticus questions undo ${p.id}\n${stringify(p, { lineWidth: 0 })}`,
  );
  return batchRelOf(root, p.id);
}

/** One batch's record; undefined when there is none (or the id isn't a batch's). */
export async function readBatch(root: string, id: string): Promise<DecisionBatchT | undefined> {
  if (!BatchId.safeParse(id).success) return undefined;
  const text = await readFile(join(decisionsDirOf(root), `${id}.yaml`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  const r = DecisionBatch.safeParse(parse(text));
  return r.success ? r.data : undefined;
}

/** Every batch on record, newest first, with the files that don't read as one. */
export async function listBatches(
  root: string,
): Promise<{ batches: DecisionBatchT[]; problems: { file: string; message: string }[] }> {
  const names = (await readdir(decisionsDirOf(root)).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  const batches: DecisionBatchT[] = [];
  const problems: { file: string; message: string }[] = [];
  for (const n of names) {
    const file = `${decisionsRelOf(root)}/${n}`;
    let data: unknown;
    try {
      data = parse(await readFile(join(decisionsDirOf(root), n), "utf8"));
    } catch (e) {
      problems.push({ file, message: `not YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    const r = DecisionBatch.safeParse(data);
    if (r.success) batches.push(r.data);
    else
      problems.push({
        file,
        message: r.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
  }
  batches.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  return { batches, problems };
}

const V2_FIELDS = ["ai", "batch", "rule", "match"] as const;

/**
 * The `corrections-v2` step (ADR 0181): a corrections line that uses version 2's fields (an AI
 * pairing, a batch, a rule, a match, an unlink) but says version 1, as a hand edit might, says 2;
 * every other line means the same at version 1 and is left exactly as it is. Returns the files,
 * relative to the root; with dryRun, the files it would rewrite.
 */
export async function migrateCorrections(
  root: string,
  o: { dryRun?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  const names = (await readdir(factsDirOf(root)).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".corrections.jsonl"))
    .sort();
  for (const n of names) {
    const file = join(factsDirOf(root), n);
    // Round 46: under the corrections lock, so a line the app appends meanwhile isn't lost.
    const rewrite = () => migrateOne(file, o.dryRun === true);
    if (await (o.dryRun ? rewrite() : withSharedFileLock(file, rewrite)))
      out.push(`${factsRelOf(root)}/${n}`);
  }
  return out;
}

/** One corrections file through `corrections-v2`: whether it needs (or got) a rewrite. */
async function migrateOne(file: string, dryRun: boolean): Promise<boolean> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  let changed = false;
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).map((raw) => {
    if (!raw.trim()) return raw;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return raw;
    }
    const needs = json.action === "unlink" || V2_FIELDS.some((k) => json[k] !== undefined);
    if (!needs || json.schemaVersion !== 1) return raw;
    changed = true;
    return raw.replace(
      /"schemaVersion"\s*:\s*1\b/,
      `"schemaVersion":${FACT_CORRECTIONS_SCHEMA_VERSION}`,
    );
  });
  if (!changed) return false;
  if (!dryRun) await writeFileAtomic(file, lines.join(eol));
  return true;
}
