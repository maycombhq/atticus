import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  acquireLock,
  FACTS_COMPANIONS,
  factsDirOf,
  factsRelOf,
  listQuestions,
  loadOrgPack,
  LockHeldError,
  ManifestEditError,
  mapRelOf,
  orgPackDirOf,
  parseRecord,
  Question,
  questionFileOf,
  questionFileText,
  RecordId,
  recordPath,
  renamedManifest,
  serializeRecord,
  specRelOf,
} from "@maycombhq/core";
import {
  buildAndWrite,
  buildCatalog,
  buildLines,
  curatedDirOf,
  factsSlotOf,
  factsSlotPaths,
  forgetCatalogs,
  forgetKeptReads,
  legacyJoinsPath,
  listUndo,
  loadBuildInputs,
  parseLegacyJoins,
  readCatalog,
  readersSlotPath,
  readersSlotRead,
  rollBackUndo,
  serializeFactsSlotMeta,
  serializeLegacyJoins,
  serializeReadersSlot,
  sha256Of,
  undoDirOf,
  withSlotWrites,
  type SlotWrite,
} from "@maycombhq/scanner";
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

/**
 * A test hook (ADR 0195 point 10, "the new slots fail to build"): the rename's new slot files are
 * made unreadable before they are checked, so the rename must change nothing. Never set outside
 * tests.
 */
export const renameHooks: { breakNewSlots?: boolean } = {};

type RenameOptions = { json?: boolean; allowRemovals?: number; discardEdits?: number };

export async function repoRename(
  root: string,
  from: string | undefined,
  to: string | undefined,
  io: Output,
  o: RenameOptions = {},
): Promise<number> {
  const breakSlots = renameHooks.breakNewSlots === true;
  renameHooks.breakNewSlots = undefined;
  if (!from || !to) {
    io.err("Usage: atticus repo rename <old id> <new id>");
    return 2;
  }
  if (!RecordId.safeParse(to).success) {
    io.err(`${to} isn't a repo id: ids are lowercase slugs (a-z, 0-9, '.', '_' and '-').`);
    return 2;
  }
  // ADR 0195 point 2 (compute, guard, then write): everything below runs under the scan's lock,
  // so what the rename checks is what it writes.
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
    return await renameLocked(root, from, to, io, o, breakSlots);
  } finally {
    await lock.release();
  }
}

/**
 * The rename under the lock. Every file it changes is computed in memory first: the repo's slots
 * under the new id, the legacy joins, the manifest entry, the facts files and their companions,
 * the scan settings, the questions and the curated decisions. The build from all of them runs its
 * guards, and only then is anything written, in one write with one undo copy (point 2). A
 * refusal writes nothing; a failure part way puts every file back from the undo copy.
 */
async function renameLocked(
  root: string,
  from: string,
  to: string,
  io: Output,
  o: RenameOptions,
  breakSlots: boolean,
): Promise<number> {
  const refusedJson = (reasons: string[], message: string) => {
    if (o.json) io.out(JSON.stringify({ renamed: false, refused: { reasons, message } }, null, 2));
  };
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

  // ---- ADR 0195 (CS2): the repo's slots under the new id, checked
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
    const next0 =
      "slot" in read
        ? serializeReadersSlot(
            renamed({ ...read.slot }, from, to).value as Parameters<typeof serializeReadersSlot>[0],
          )
        : undefined;
    const next = breakSlots && next0 ? next0.slice(0, -10) : next0;
    const check = next === undefined ? undefined : readersSlotRead(next);
    if (!next || !check || !("slot" in check) || check.slot.repo !== to) {
      const why = `The readers slot of ${from} doesn't read under ${to} (${"problem" in read ? read.problem : "problem" in (check ?? {}) ? (check as { problem: string }).problem : "renamed, it isn't a slot"}); nothing was changed.`;
      io.err(why);
      refusedJson(["build-failed"], why);
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
    const check = factsSlotOf(to, facts, breakSlots && meta ? meta.slice(0, -10) : meta);
    if (!check?.ok || facts === undefined || meta === undefined) {
      const why = `The facts snapshot of ${from} doesn't read under ${to} (${check && !check.ok ? check.problem : "its meta isn't JSON"}); nothing was changed.`;
      io.err(why);
      refusedJson(["build-failed"], why);
      return 1;
    }
    const p = factsSlotPaths(root, to);
    slotWrites.push({ path: p.facts, text: facts }, { path: p.meta, text: meta });
  }
  // The legacy joins name the repo too (an arrow's evidence, its slot among the inputs): renamed
  // with it, so a join stays until a repo at either end is removed or archived (point 6). The
  // slots it rested on are recorded under their new paths with their new hashes: a rename is
  // not a change of what they hold.
  const ljPath = legacyJoinsPath(root);
  const ljText = await readText(ljPath);
  if (ljText !== undefined) {
    const lj = parseLegacyJoins(ljText);
    if (!lj.ok) {
      const why = `catalog/sources/legacy/joins.json doesn't read (${lj.issues[0]?.message ?? "invalid"}); nothing was changed.`;
      io.err(why);
      refusedJson(["build-failed"], why);
      return 1;
    }
    const relPath = (abs: string) => posix(relative(root, abs));
    const moved = new Map<string, string>();
    for (const w of slotWrites)
      if (w.text !== null)
        moved.set(relPath(w.path).replace(`/${to}.`, `/${from}.`), relPath(w.path));
    const inputs: Record<string, string> = {};
    for (const [k, h] of Object.entries(lj.slot.inputs)) {
      const next = moved.get(k);
      const w = next ? slotWrites.find((x) => relPath(x.path) === next) : undefined;
      if (next && w?.text) inputs[next] = sha256Of(w.text);
      else inputs[k] = h;
    }
    const records = lj.slot.records.map((r) => {
      const n = renamed(r, from, to);
      if (!n.changed) return r;
      const p = parseRecord(n.value);
      return p.ok ? p.record : r;
    });
    const next = serializeLegacyJoins({ ...lj.slot, records, inputs });
    if (next !== ljText) slotWrites.push({ path: ljPath, text: next });
  }

  // ---- the inputs, renamed in memory: the manifest entry, the facts and their companions, the
  // scan settings, the questions and the curated decisions (catalog/generated is the build's)
  forgetKeptReads();
  const said: string[] = [];
  const inputWrites: SlotWrite[] = [];
  const inputRemovals: SlotWrite[] = [];
  let manifest;
  try {
    manifest = await renamedManifest(root, from, to);
  } catch (e) {
    if (e instanceof ManifestEditError) {
      io.err(e.message);
      return e.code === "not-found" ? 2 : 1;
    }
    throw e;
  }
  inputWrites.push({ path: manifest.file.path, text: manifest.next, input: true });
  said.push(`${manifest.file.rel}: the entry's id`);
  for (const m of moves) {
    const text = await readFile(m.src, "utf8");
    inputWrites.push({ path: m.dst, text: rewriteFactsFile(m.name, text, from, to), input: true });
    inputRemovals.push({ path: m.src, text: null, input: true });
    said.push(`${m.rel} → ${m.relTo}`);
  }
  const questions = (await listQuestions(root)).questions.map((q) =>
    q.repo === from
      ? Question.parse({
          ...q,
          repo: to,
          rerun: renamedText(q.rerun, from, to),
          askedBy: { ...q.askedBy, command: renamedText(q.askedBy.command, from, to) },
          ...(q.scope.level === "repo" && q.scope.id === from
            ? { scope: { ...q.scope, id: to } }
            : {}),
        })
      : q,
  );
  const qMoved = questions.filter((q) => q.repo === to);
  for (const q of qMoved)
    inputWrites.push({ path: questionFileOf(root, q.id), text: questionFileText(q), input: true });
  if (qMoved.length)
    said.push(`${qMoved.length} question${qMoved.length === 1 ? "" : "s"} (repo ${to})`);
  const op0 = await loadOrgPack(orgPackDirOf(root));
  const op = structuredClone(op0);
  for (const p of op.profiles)
    for (const r of p.repos?.repos ?? []) if (r.id === from) (r as { id: string }).id = to;
  for (const s of op.scanSettings) if (s.repo === from) (s as { repo: string }).repo = to;
  const curatedDir = curatedDirOf(root, op0);
  const curatedNow = await readCatalog(curatedDir, { cacheRoot: root, fresh: true });
  let decisions = 0;
  const curatedNext = curatedNow.records.map((r) => {
    const n = renamed(r, from, to);
    if (!n.changed) return r;
    const p = parseRecord(n.value);
    if (!p.ok) {
      io.err(
        `${r.kind} ${r.id} names ${from} but wouldn't be valid renamed (${p.issues.map((i) => i.message).join("; ")}); left as it is.`,
      );
      return r;
    }
    inputWrites.push({
      path: join(curatedDir, ...recordPath(p.record).split("/")),
      text: serializeRecord(p.record),
      input: true,
    });
    decisions++;
    return p.record;
  });

  // ---- the build from all of it, guarded, before anything is written
  const writes: SlotWrite[] = [
    ...slotWrites,
    ...inputWrites,
    ...inputRemovals,
    // The old slot files go last, once the new ones are written.
    ...(rText !== undefined ? [{ path: rOld, text: null }] : []),
    ...(fText !== undefined ? [{ path: fOld.facts, text: null }] : []),
    ...(mText !== undefined ? [{ path: fOld.meta, text: null }] : []),
  ];
  const pending = new Map<string, string | null>();
  for (const w of [...inputWrites, ...inputRemovals]) pending.set(w.path, w.text);
  const command = `atticus repo rename ${from} ${to}`;
  const inputs = await loadBuildInputs(root, { op, curated: curatedNext, pending, questions });
  const build = await buildCatalog({
    ...inputs,
    slots: await withSlotWrites(
      root,
      inputs.slots,
      writes.filter((w) => !w.input),
    ),
  });
  const confirm = {
    ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
    ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
  };
  // ---- one write: the undo copy of every file it touches first (the slots, the inputs, the
  // records, build.json), then the slots and inputs in order, the records, build.json last. A
  // failure part way puts every file back from that copy and removes only the files that
  // weren't there before.
  const undoDir = await undoDirOf(root);
  const newest = (await listUndo(undoDir))[0]?.n ?? 0;
  let written;
  try {
    written = await buildAndWrite(root, { command, build, slots: writes, ...confirm });
  } catch (e) {
    await rollBackUndo(root, undoDir, newest);
    forgetKeptReads();
    io.err(
      `The rename stopped part way (${e instanceof Error ? e.message : String(e)}); every file it had written was put back, so nothing was renamed.`,
    );
    throw e;
  }
  if (written.guard.refused) {
    for (const l of buildLines(root, written)) io.err(l);
    io.err("Nothing was renamed.");
    if (o.json) io.out(JSON.stringify({ renamed: false, refused: written.guard.refused }, null, 2));
    return 1;
  }
  if (decisions)
    said.push(`${decisions} curated decision${decisions === 1 ? "" : "s"} (repo ${to})`);
  for (const l of buildLines(root, written)) said.push(l);
  forgetCatalogs();

  if (o.json) {
    io.out(
      JSON.stringify(
        {
          renamed: true,
          from,
          to,
          files: written.write
            ? {
                written: written.write.written,
                unchanged: written.write.unchanged,
                removed: written.write.removed,
              }
            : null,
          slots: written.write?.slots ?? [],
          removed: (written.write?.removals ?? []).map((x) => ({
            kind: x.kind,
            id: x.id,
            repos: x.repos,
            explainedBy: x.explainedBy,
            reasons: x.reasons,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
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
}
