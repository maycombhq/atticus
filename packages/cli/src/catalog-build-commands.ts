import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  acquireLock,
  catalogDirOf,
  cmpText,
  deserializeRecord,
  LockHeldError,
  parseRecord,
  recordPath,
  serializeRecord,
  writeFileAtomic,
  type CatalogRecord,
} from "@maycombhq/core";
import {
  applyUndo,
  baselineTarget,
  buildAndWrite,
  buildCatalog,
  buildLines,
  filesUnder,
  generatedBeforeUpgradeDirOf,
  guardBuild,
  listUndo,
  loadBuildInputs,
  planUndo,
  readBuildManifest,
  takeUndoCopy,
  undoDirOf,
  UPGRADE_UNDONE,
  writeCuratedEdits,
  type BuildAndWrite,
  type BuildRefusal,
} from "@maycombhq/scanner";
import { gitUser } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * The build's own commands (ADR 0195, ticket CS2): `atticus catalog build [--check]` makes
 * catalog/generated from the slots and inputs on demand (after a curated file is edited by hand,
 * or a merge conflict), `catalog edits [--curate]` turns hand edits into curated decisions,
 * `catalog undo [<n>]` takes back the last builds and `catalog prune` removes the slot files no
 * build reads. Each takes the scan's lock, and nothing is removed or overwritten without being
 * listed first.
 */

const posix = (p: string) => p.split(sep).join("/");

async function locked<T>(
  root: string,
  what: string,
  io: Output,
  run: () => Promise<T>,
): Promise<T | number> {
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(root, "scan", what);
  } catch (e) {
    if (e instanceof LockHeldError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

/** A build's report for `--json` (the same structure for every command that builds). */
export function buildJson(r: BuildAndWrite) {
  return {
    written: r.write !== undefined,
    files: r.write
      ? { written: r.write.written, unchanged: r.write.unchanged, removed: r.write.removed }
      : null,
    slots: r.write?.slots ?? [],
    sources: r.build.sources,
    removed: (r.write?.removals ?? []).map((x) => ({
      kind: x.kind,
      id: x.id,
      repos: x.repos,
      explainedBy: x.explainedBy,
      reasons: x.reasons,
    })),
    retired: r.build.retired,
    orphaned: r.build.orphaned,
    orphanedDecisions: r.build.orphanedDecisions,
    ...(r.write?.undo !== undefined ? { undo: r.write.undo } : {}),
    ...(r.guard.refused ? { refused: r.guard.refused } : {}),
  };
}

/**
 * How the app says a refused build (ADR 0195 point 4; CS3 adds its confirm steps): the reason
 * in plain words and the command that goes on, so an action never just fails.
 */
export function refusalHint(r: BuildRefusal, command: string): string {
  if (r.reasons.includes("not-upgraded"))
    return "This catalog was written before beta.27: run atticus upgrade (it shows what it would do; atticus upgrade --yes applies it).";
  if (r.reasons.includes("hand-edits"))
    return `Files under catalog/generated were changed by hand. Make them curated: atticus catalog edits --curate, or discard them: ${command} --discard-edits ${r.discardEdits ?? 0}.`;
  if (r.reasons.includes("unexplained-removals"))
    return "The build would remove records nothing explains (a bug): nothing was written. The list is in the command's output.";
  if (r.reasons.includes("large-removals"))
    return `The build would remove ${r.allowRemovals ?? 0} records, more than the limit: confirm exactly these with ${command} --allow-removals ${r.allowRemovals ?? 0}.`;
  if (r.reasons.includes("empty"))
    return "The build has no record from any repo's code, so the catalog is left as it was.";
  return r.message.split("\n")[0] ?? "Nothing written.";
}

/** atticus catalog build [--check] [--json] [--allow-removals <n>] [--discard-edits <n>]. */
export async function catalogBuild(
  root: string,
  o: { check?: boolean; json?: boolean; allowRemovals?: number; discardEdits?: number },
  io: Output,
): Promise<number> {
  const command = "atticus catalog build";
  const run = async () => {
    const r = await buildAndWrite(root, {
      command,
      ...(o.check ? { check: true } : {}),
      ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
      ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
    });
    if (o.check) {
      if (o.json)
        io.out(JSON.stringify({ upToDate: r.upToDate, sources: r.build.sources }, null, 2));
      else
        io.out(
          r.upToDate
            ? "catalog/generated is what the slots and inputs build."
            : "catalog/generated isn't what the slots and inputs build: run atticus catalog build.",
        );
      return r.upToDate ? 0 : 1;
    }
    if (o.json) io.out(JSON.stringify(buildJson(r), null, 2));
    else {
      for (const s of r.build.sources)
        io.out(
          `${s.repo}: ${s.source === "none" ? "no slot yet" : `${s.source}${s.commit ? ` at ${s.commit.slice(0, 7)}` : ""}`}`,
        );
      for (const l of buildLines(root, r)) (r.guard.refused ? io.err : io.out)(l);
    }
    for (const p of r.build.problems)
      if (!o.json) io.err(`${p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
    return r.guard.refused ? 1 : 0;
  };
  const code = o.check ? await run() : await locked(root, command, io, run);
  return code;
}

/** atticus catalog undo [<n>] [--yes]: list the copies kept, and take back the latest (or back to before n). */
export async function catalogUndo(
  root: string,
  o: { n?: number; yes?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const undoDir = await undoDirOf(root);
  const list = await listUndo(undoDir);
  const plan = await planUndo(undoDir, o.n);
  if ("problem" in plan) {
    if (o.json) io.out(JSON.stringify({ copies: list, problem: plan.problem }, null, 2));
    else io.err(plan.problem);
    return 1;
  }
  if (!o.yes) {
    if (o.json) io.out(JSON.stringify({ copies: list, plan }, null, 2));
    else {
      io.out(`The last ${list.length} builds kept here, newest first:`);
      list.forEach((c, i) => io.out(`  ${i + 1}: ${c.command} (${c.at}, ${c.files.length} files)`));
      io.out(
        `atticus catalog undo${o.n !== undefined ? ` ${o.n}` : ""} --yes would put back ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"} as they were before ${plan.copies.length === 1 ? `the latest build (${plan.copies[0]!.command})` : `the ${plan.copies.length} latest builds`}:`,
      );
      for (const f of plan.files.slice(0, 30))
        io.out(`  ${f.to === "absent" ? "remove" : "restore"} ${f.path}`);
      if (plan.files.length > 30) io.out(`  and ${plan.files.length - 30} more`);
    }
    return 0;
  }
  return locked(root, "atticus catalog undo", io, async () => {
    // Undo refuses over hand edits, as a build does.
    const b = await buildCatalog(await loadBuildInputs(root));
    const g = await guardBuild(b, { undoDir, command: "atticus catalog build" });
    if (g.refused?.reasons.includes("hand-edits")) {
      io.err(
        "Nothing undone: files under catalog/generated were changed by hand since the last build. Make them curated (atticus catalog edits --curate) or discard them (atticus catalog build --discard-edits <count>) first.",
      );
      if (o.json)
        io.out(
          JSON.stringify({ refused: { reasons: ["hand-edits"], edits: g.refused.edits } }, null, 2),
        );
      return 1;
    }
    const r = await applyUndo(
      root,
      undoDir,
      plan,
      `atticus catalog undo${o.n !== undefined ? ` ${o.n}` : ""}`,
    );
    // The restored record files against the restored build.json: one that differs was a hand
    // edit before the build undone (a discard, say), and is one again, as it was; the next build
    // lists it rather than overwrite it.
    const m = await readBuildManifest(baselineTarget(root).manifest);
    const bad: string[] = [];
    for (const f of m.manifest?.files ?? []) {
      const text = await readFile(join(root, ...f.path.split("/")), "utf8").catch(() => undefined);
      const { sha256Of } = await import("@maycombhq/scanner");
      if (text === undefined || sha256Of(text.replace(/\r\n?/g, "\n")) !== f.sha256)
        bad.push(f.path);
    }
    if (o.json)
      io.out(JSON.stringify({ restored: r.restored, undo: r.undo, handEdits: bad }, null, 2));
    else {
      io.out(
        `Put back ${r.restored.length} ${r.restored.length === 1 ? "file" : "files"} as ${r.restored.length === 1 ? "it was" : "they were"} before ${plan.copies.map((c) => c.command).join(", then ")}.`,
      );
      if (r.undo !== undefined)
        io.out(`This undo can be undone too: atticus catalog undo --yes (copy ${r.undo}).`);
      if (plan.copies.some((c) => c.command.startsWith("atticus upgrade"))) io.out(UPGRADE_UNDONE);
      if (bad.length)
        io.out(
          `${bad.length} restored ${bad.length === 1 ? "file is a hand edit" : "files are hand edits"} again, as before (the next build lists ${bad.length === 1 ? "it" : "them"}: atticus catalog edits --curate keeps ${bad.length === 1 ? "it" : "them"}): ${bad.join(", ")}`,
        );
    }
    return 0;
  });
}

/** atticus catalog prune [--yes]: the slot files no build reads, listed, and removed only on confirmation. */
export async function catalogPrune(
  root: string,
  o: { yes?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  const b = await buildCatalog(await loadBuildInputs(root));
  const files = [
    ...b.orphaned.flatMap((x) =>
      x.files.map((f) => ({
        path: f,
        why: x.why === "archived" ? `${x.repo} is archived` : `${x.repo} isn't in the manifests`,
      })),
    ),
    ...(await filesUnder(generatedBeforeUpgradeDirOf(root))).map((p) => ({
      path: posix(relative(root, p)),
      why: "the copy the upgrade kept of the catalog before it",
    })),
  ].sort((a, x) => cmpText(a.path, x.path));
  if (!files.length) {
    if (o.json) io.out(JSON.stringify({ files: [], removed: [] }, null, 2));
    else io.out("Nothing to prune: every slot file is one a build reads.");
    return 0;
  }
  if (!o.yes) {
    if (o.json) io.out(JSON.stringify({ files, removed: [] }, null, 2));
    else {
      io.out(`${files.length} ${files.length === 1 ? "file" : "files"} no build reads:`);
      for (const f of files) io.out(`  ${f.path} (${f.why})`);
      io.out(
        "Nothing removed. atticus catalog prune --yes removes exactly these (atticus catalog undo and git keep them).",
      );
    }
    return 0;
  }
  return locked(root, "atticus catalog prune", io, async () => {
    const undoDir = await undoDirOf(root);
    const touched = files.map((f) => ({ path: join(root, ...f.path.split("/")), text: null }));
    const undo = await takeUndoCopy(root, undoDir, "atticus catalog prune", touched);
    for (const t of touched) await rm(t.path, { force: true });
    if (o.json) io.out(JSON.stringify({ files, removed: files.map((f) => f.path), undo }, null, 2));
    else {
      io.out(`Removed ${files.length} ${files.length === 1 ? "file" : "files"}:`);
      for (const f of files) io.out(`  ${f.path}`);
      if (undo !== undefined) io.out(`atticus catalog undo --yes puts them back (copy ${undo}).`);
    }
    return 0;
  });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);

/** Fields an assert can't set (identity and provenance belong to the catalog). */
const PROTECTED = new Set(["kind", "id", "schemaVersion", "confidence", "evidence"]);

/**
 * atticus catalog edits [--curate]: the files under catalog/generated changed by hand since the
 * last build. With --curate each becomes a curated decision (ADR 0195 point 4): a changed file an
 * assert of the fields it changed, a deleted one a suppress, an added record an assert of the
 * whole record with its kind (the build adds it while it makes no record of that id). When every edit is made
 * curated, the build runs with them, and the edited files' bytes go into the undo copy.
 */
export async function catalogEdits(
  root: string,
  o: { curate?: boolean; json?: boolean; by?: string; now?: Date },
  io: Output,
): Promise<number> {
  const undoDir = await undoDirOf(root);
  const inputs = await loadBuildInputs(root);
  const b = await buildCatalog(inputs);
  const g = await guardBuild(b, { undoDir, command: "atticus catalog build" });
  const edits = g.refused?.reasons.includes("hand-edits") ? (g.refused.edits ?? []) : [];
  if (!edits.length) {
    if (o.json) io.out(JSON.stringify({ edits: [], decisions: [] }, null, 2));
    else io.out("No file under catalog/generated was changed by hand since the last build.");
    return 0;
  }
  if (!o.curate) {
    if (o.json) io.out(JSON.stringify({ edits, decisions: [] }, null, 2));
    else {
      io.out(
        `${edits.length} ${edits.length === 1 ? "file was" : "files were"} changed by hand since the last build:`,
      );
      for (const e of edits) io.out(`  ${e.how}: ${e.path}`);
      io.out(
        `Make them curated decisions: atticus catalog edits --curate. Or discard them: atticus catalog build --discard-edits ${edits.length}.`,
      );
    }
    return 1;
  }
  return locked(root, "atticus catalog edits --curate", io, async () => {
    const by = o.by ?? (await gitUser(root)).handle;
    const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const built = new Map(b.records.map((r) => [recordPath(r), r]));
    const curatedDir = join(catalogDirOf(root), "curated");
    const written: string[] = [];
    const curated: string[] = [];
    const left: { path: string; why: string }[] = [];
    const genRel = posix(relative(root, join(catalogDirOf(root), "generated")));
    for (const e of edits) {
      const rel = e.path.startsWith(`${genRel}/`) ? e.path.slice(genRel.length + 1) : e.path;
      const derivedNow = built.get(rel);
      let derived = derivedNow;
      let decision: Record<string, unknown> | undefined;
      if (e.how === "deleted") {
        // A record this build no longer makes is suppressed by the id its file named, so it
        // stays deleted should it return.
        const id = derived?.id ?? (rel.split("/").pop() ?? "").replace(/\.ya?ml$/, "");
        decision = { action: "suppress", target: id, value: null };
      } else if (e.how === "added") {
        // An assert of the whole record, its kind named: the build adds it while it makes no
        // record of that id, and asserts its fields on the one it makes once it does.
        const text = await readFile(join(root, ...e.path.split("/")), "utf8").catch(() => "");
        const p = deserializeRecord(text);
        if (!p.ok || derived) {
          left.push({
            path: e.path,
            why: derived
              ? "the build makes a record of its id: change that record instead"
              : "it doesn't read as a record",
          });
          continue;
        }
        const rec = p.record as unknown as Record<string, unknown>;
        const value: Record<string, unknown> = { kind: rec.kind };
        for (const k of Object.keys(rec).sort(cmpText))
          if (!PROTECTED.has(k) && k !== "status") value[k] = rec[k];
        decision = { action: "assert", target: String(rec.id), value };
      } else {
        const text = await readFile(join(root, ...e.path.split("/")), "utf8").catch(() => "");
        const p = deserializeRecord(text);
        // A record this build no longer makes (its repo removed or archived since): the edit is
        // read against the record as its slot last held it, and the assert waits, orphaned,
        // until the record returns.
        const fromSlot = (): CatalogRecord | undefined => {
          if (!p.ok) return undefined;
          const { kind, id } = p.record;
          const held = [
            ...[...inputs.slots.readers.values()].flatMap((x) =>
              "slot" in x ? x.slot.records : [],
            ),
            ...(inputs.slots.legacy && "slot" in inputs.slots.legacy
              ? inputs.slots.legacy.slot.records
              : []),
          ];
          return held.find((r) => r.kind === kind && r.id === id);
        };
        derived = derivedNow ?? fromSlot();
        if (!p.ok || !derived) {
          left.push({
            path: e.path,
            why: "it doesn't read as a record, or the build no longer makes it",
          });
          continue;
        }
        const now = p.record as unknown as Record<string, unknown>;
        const was = derived as unknown as Record<string, unknown>;
        const value: Record<string, unknown> = {};
        const bad: string[] = [];
        for (const k of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort(cmpText)) {
          if (JSON.stringify(now[k]) === JSON.stringify(was[k])) continue;
          if (PROTECTED.has(k)) bad.push(k);
          else if (k in now) value[k] = now[k];
        }
        if (bad.length && !Object.keys(value).length) {
          left.push({
            path: e.path,
            why: `it changes only ${bad.join(", ")}, which a curated decision can't set`,
          });
          continue;
        }
        if (!Object.keys(value).length) {
          left.push({
            path: e.path,
            why: "its record says the same as the build's (a comment or the layout): discard it",
          });
          continue;
        }
        decision = { action: "assert", target: derived.id, value };
      }
      const record = parseRecord({
        kind: "CuratedDecision",
        id: slug(`cd-edit-${String(decision.action)}-${String(decision.target)}`),
        schemaVersion: 2,
        status: "current",
        confidence: "asserted",
        ...decision,
        reason: `A hand edit to ${e.path}, made curated (atticus catalog edits --curate).`,
        by,
        at,
      });
      if (!record.ok) {
        left.push({ path: e.path, why: record.issues.map((i) => i.message).join("; ") });
        continue;
      }
      const full = join(curatedDir, ...recordPath(record.record as CatalogRecord).split("/"));
      await mkdir(dirname(full), { recursive: true });
      await writeFileAtomic(full, serializeRecord(record.record as CatalogRecord));
      written.push(posix(relative(root, full)));
      curated.push(e.path);
    }
    // The next build replaces each edit made curated (its bytes kept in that build's undo copy);
    // nothing is built here, so the person reviews the decisions first.
    await writeCuratedEdits(root, undoDir, curated);
    if (o.json) io.out(JSON.stringify({ edits, decisions: written, left }, null, 2));
    else {
      for (const w of written)
        io.out(`Wrote ${w}: propose it in a pull request so every build keeps the edit.`);
      for (const l of left) io.err(`${l.path}: not made curated: ${l.why}.`);
      if (written.length)
        io.out(
          "atticus catalog build (or the next scan) builds with them, and replaces the edited files; their bytes are kept for atticus catalog undo.",
        );
      if (left.length)
        io.err(
          `What isn't curated stays a hand edit: discard it with atticus catalog build --discard-edits <count> (a copy is kept for undo).`,
        );
    }
    return left.length ? 1 : 0;
  });
}
