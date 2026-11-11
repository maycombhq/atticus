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
import {
  buildAndWrite,
  buildCatalog,
  buildLines,
  factsSlotOf,
  factsSlotPaths,
  forgetCatalogs,
  loadBuildInputs,
  readCatalog,
  readersSlotPath,
  readersSlotRead,
  serializeFactsSlotMeta,
  serializeReadersSlot,
  sha256Of,
  withSlotWrites,
  type SlotWrite,
} from "@maycombhq/scanner";
import { loadOrgPack } from "@maycombhq/core";
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

  // ---- ADR 0195 (CS2): the repo's slots under the new id, checked, then the build from them
  // with its guards, all in memory before anything moves. A failure changes nothing.
  const slotWrites: SlotWrite[] = [];
  const readText = (p: string) =>
    readFile(p, "utf8").then(
      (t) => t.replace(/\r\n?/g, "\n"),
      () => undefined,
    );
  const rOld = readersSlotPath(root, from);
  const rText = await readText(rOld);
  if (rText !== undefined) {
    const read = readersSlotRead(rText);
    const next =
      "slot" in read
        ? serializeReadersSlot(
            renamed({ ...read.slot }, from, to).value as Parameters<typeof serializeReadersSlot>[0],
          )
        : undefined;
    const check = next === undefined ? undefined : readersSlotRead(next);
    if (!next || !check || !("slot" in check) || check.slot.repo !== to) {
      io.err(
        `The readers slot of ${from} doesn't read under ${to} (${"problem" in read ? read.problem : "renamed, it isn't a slot"}); nothing was changed.`,
      );
      return 1;
    }
    slotWrites.push({ path: readersSlotPath(root, to), text: next });
  }
  const fOld = factsSlotPaths(root, from);
  const [fText, mText] = [await readText(fOld.facts), await readText(fOld.meta)];
  if (fText !== undefined || mText !== undefined) {
    const facts = fText === undefined ? undefined : rewriteFactsFile(".jsonl", fText, from, to);
    let meta: string | undefined;
    try {
      const m = mText === undefined ? undefined : (JSON.parse(mText) as Record<string, unknown>);
      if (m && facts !== undefined) {
        const n = renamed(m, from, to).value as Record<string, unknown>;
        meta = serializeFactsSlotMeta({
          ...(n as Parameters<typeof serializeFactsSlotMeta>[0]),
          repo: to,
          factsHash: sha256Of(facts),
        });
      }
    } catch {
      meta = undefined;
    }
    const check = factsSlotOf(to, facts, meta);
    if (!check?.ok || facts === undefined || meta === undefined) {
      io.err(
        `The facts snapshot of ${from} doesn't read under ${to} (${check && !check.ok ? check.problem : "its meta isn't JSON"}); nothing was changed.`,
      );
      return 1;
    }
    const p = factsSlotPaths(root, to);
    slotWrites.push({ path: p.facts, text: facts }, { path: p.meta, text: meta });
  }
  // The old slot files go last, once the new ones are written.
  if (rText !== undefined) slotWrites.push({ path: rOld, text: null });
  if (fText !== undefined) slotWrites.push({ path: fOld.facts, text: null });
  if (mText !== undefined) slotWrites.push({ path: fOld.meta, text: null });
  const op0 = await loadOrgPack(orgPackDirOf(root));
  const op = structuredClone(op0);
  for (const p of op.profiles)
    for (const r of p.repos?.repos ?? []) if (r.id === from) (r as { id: string }).id = to;
  const curatedNow = await readCatalog(join(catalogDirOf(root), "curated"), { cacheRoot: root });
  const curatedNext = curatedNow.records.map((r) => {
    const n = renamed(r, from, to);
    if (!n.changed) return r;
    const p = parseRecord(n.value);
    return p.ok ? p.record : r;
  });
  const command = `atticus repo rename ${from} ${to}`;
  const inputs = await loadBuildInputs(root, { op, curated: curatedNext });
  const build = await buildCatalog({
    ...inputs,
    slots: await withSlotWrites(root, inputs.slots, slotWrites),
  });
  const pre = await buildAndWrite(root, { command, build, check: true });
  if (pre.guard.refused) {
    for (const l of buildLines(root, pre)) io.err(l);
    io.err("Nothing was renamed.");
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

    // ---- the curated decisions that name it (catalog/generated is the build's: written below)
    let records = 0;
    const dir = join(catalogDirOf(root), "curated");
    for (const r of curatedNow.records) {
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
    // ---- the new slots, then the build, then the old slots go (ADR 0195 point 2)
    let written;
    try {
      written = await buildAndWrite(root, { command, build, slots: slotWrites });
    } catch (e) {
      // Only the new files this wrote are taken away; the old ones stay.
      for (const w of slotWrites) if (w.text !== null) await rm(w.path, { force: true });
      throw e;
    }
    if (written.guard.refused) {
      for (const l of buildLines(root, written)) io.err(l);
      return 1;
    }
    for (const l of buildLines(root, written)) said.push(l);
    forgetCatalogs();
    if (records) said.push(`${records} curated decision${records === 1 ? "" : "s"} (repo ${to})`);

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
