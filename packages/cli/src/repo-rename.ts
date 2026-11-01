import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  acquireLock,
  catalogDirOf,
  FACTS_COMPANIONS,
  factsDirOf,
  factsRelOf,
  listQuestions,
  LockHeldError,
  ManifestEditError,
  mapRelOf,
  orgPackDirOf,
  parseRecord,
  RecordId,
  recordPath,
  renameManifestRepo,
  serializeRecord,
  specRelOf,
  writeFileAtomic,
  writeQuestion,
  type Question,
} from "@maycombhq/core";
import { forgetCatalogs, readCatalog } from "@maycombhq/scanner";
import { loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * atticus repo rename <old> <new> (F5): a repo's id moved with everything filed under it, in one
 * change a person reviews. The manifest entry's id; the facts file and its companions (the read
 * plan, the reviewed file, the questions the reader wrote, the verify report, the rejected and
 * corrections files), each moved and every `repo` in it rewritten; the questions raised for the
 * repo; the catalog records that name it; and its scan settings. Files are moved and rewritten
 * only: Atticus never commits or pushes, so the change is a person's to review in a pull request.
 *
 * Everything is checked before anything moves: an id that isn't a slug, a repo no manifest lists,
 * a new id one already lists, or a file already where one would go, changes nothing.
 */

const posix = (p: string) => p.split(sep).join("/");

/** Every `repo: <old>` in a parsed document, at any depth, as `<new>`. */
function renamed(v: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x)) {
        if (k === "repo" && y === from) {
          out[k] = to;
          changed = true;
        } else out[k] = walk(y);
      }
      return out;
    }
    return x;
  };
  return { value: walk(v), changed };
}

/** A command or text with the repo id, as a word of its own, put as the new one. */
function renamedText(text: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9._-])${esc}(?![A-Za-z0-9._-])`, "g"), to);
}

/** A facts-folder file's text with every `repo` of the old id put as the new. */
function rewriteFactsFile(name: string, text: string, from: string, to: string): string {
  if (name.endsWith(".jsonl"))
    return text
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const r = renamed(JSON.parse(line), from, to);
          return r.changed ? JSON.stringify(r.value) : line;
        } catch {
          return line; // a line that isn't JSON is the reader's to fix, kept as written
        }
      })
      .join("\n");
  try {
    const r = renamed(parse(text), from, to);
    return r.changed ? stringify(r.value) : text;
  } catch {
    return text;
  }
}

export async function repoRename(
  root: string,
  from: string | undefined,
  to: string | undefined,
  io: Output,
): Promise<number> {
  if (!from || !to) {
    io.err("Usage: atticus repo rename <old id> <new id>");
    return 2;
  }
  if (!RecordId.safeParse(to).success) {
    io.err(`${to} isn't a repo id: ids are lowercase slugs (a-z, 0-9, '.', '_' and '-').`);
    return 2;
  }
  const listed = await loadRepos(root).catch(() => []);
  if (!listed.some((r) => r.id === from)) {
    io.err(`There is no repo ${from} in any manifest (atticus repos list shows the ids).`);
    return 2;
  }
  if (listed.some((r) => r.id === to)) {
    io.err(`${to} is already listed; repo ids are unique across every profile.`);
    return 2;
  }

  // ---- what moves, checked before anything does
  const factsDir = factsDirOf(root);
  const fRel = factsRelOf(root);
  const moves: { src: string; dst: string; rel: string; relTo: string; name: string }[] = [];
  for (const suffix of [".jsonl", ...FACTS_COMPANIONS]) {
    const src = join(factsDir, `${from}${suffix}`);
    if (!existsSync(src)) continue;
    moves.push({
      src,
      dst: join(factsDir, `${to}${suffix}`),
      rel: `${fRel}/${from}${suffix}`,
      relTo: `${fRel}/${to}${suffix}`,
      name: suffix,
    });
  }
  const scanDir = join(orgPackDirOf(root), "scan");
  const scanSrc = join(scanDir, `${from}.yaml`);
  if (existsSync(scanSrc)) {
    const rel = posix(relative(root, scanDir));
    moves.push({
      src: scanSrc,
      dst: join(scanDir, `${to}.yaml`),
      rel: `${rel}/${from}.yaml`,
      relTo: `${rel}/${to}.yaml`,
      name: ".yaml",
    });
  }
  const taken = moves.filter((m) => existsSync(m.dst));
  if (taken.length) {
    for (const m of taken)
      io.err(
        `${m.relTo} is already there: move or remove it first, so ${m.rel} doesn't overwrite it. Nothing was changed.`,
      );
    return 1;
  }

  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(root, "scan", `atticus repo rename ${from} ${to}`);
  } catch (e) {
    if (e instanceof LockHeldError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  try {
    const said: string[] = [];
    let manifest;
    try {
      manifest = await renameManifestRepo(root, from, to);
    } catch (e) {
      if (e instanceof ManifestEditError) {
        io.err(e.message);
        return e.code === "not-found" ? 2 : 1;
      }
      throw e;
    }
    said.push(`${manifest.rel}: the entry's id`);

    // ---- the facts and their companions, and the scan settings: moved, `repo` rewritten
    for (const m of moves) {
      const text = await readFile(m.src, "utf8");
      await writeFileAtomic(m.dst, rewriteFactsFile(m.name, text, from, to));
      await rm(m.src, { force: true });
      said.push(`${m.rel} → ${m.relTo}`);
    }

    // ---- the questions raised for it: its repo, its scope and the commands they name
    const qs = (await listQuestions(root)).questions.filter((q) => q.repo === from);
    for (const q of qs) {
      const next: Question = {
        ...q,
        repo: to,
        rerun: renamedText(q.rerun, from, to),
        askedBy: { ...q.askedBy, command: renamedText(q.askedBy.command, from, to) },
        ...(q.scope.level === "repo" && q.scope.id === from
          ? { scope: { ...q.scope, id: to } }
          : {}),
      } as Question;
      await writeQuestion(root, next);
    }
    if (qs.length) said.push(`${qs.length} question${qs.length === 1 ? "" : "s"} (repo ${to})`);

    // ---- the catalog records that name it, generated and curated
    let records = 0;
    for (const sub of ["generated", "curated"]) {
      const dir = join(catalogDirOf(root), sub);
      const cat = await readCatalog(dir, { cacheRoot: root });
      for (const r of cat.records) {
        const n = renamed(r, from, to);
        if (!n.changed) continue;
        const p = parseRecord(n.value);
        if (!p.ok) {
          io.err(
            `${r.kind} ${r.id} names ${from} but wouldn't be valid renamed (${p.issues.map((i) => i.message).join("; ")}); left as it is.`,
          );
          continue;
        }
        await writeFileAtomic(
          join(dir, ...recordPath(p.record).split("/")),
          serializeRecord(p.record),
        );
        records++;
      }
    }
    forgetCatalogs();
    if (records) said.push(`${records} catalog record${records === 1 ? "" : "s"} (repo ${to})`);

    io.out(`Renamed ${from} to ${to}:`);
    for (const l of said) io.out(`  ${l}`);
    const left = [
      existsSync(join(root, ...specRelOf(root, from).split("/"))) ? specRelOf(root, from) : "",
      existsSync(join(root, ...`${mapRelOf(root)}/${from}`.split("/")))
        ? `${mapRelOf(root)}/${from}`
        : "",
    ].filter(Boolean);
    if (left.length)
      io.out(
        `Left as they are: ${left.join(" and ")}. atticus verify ${to} --write writes them under ${to}; remove the old ones in the same pull request.`,
      );
    io.out(
      `Review the change and commit it in a pull request: Atticus commits and pushes nothing. A clone under the old id is cloned again under ${to} by atticus workspace sync.`,
    );
    return 0;
  } finally {
    await lock.release();
  }
}
