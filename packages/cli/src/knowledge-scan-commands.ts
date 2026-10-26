import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  fileJudgments,
  KNOWLEDGE_KINDS,
  knowledgeKindOf,
  knowledgeRelOf,
  loadOrgPack,
  orgPackDirOf,
  type KnowledgeKind,
} from "@maycombhq/core";
import { RuntimeConfigError, runtimeForCli, type AiRuntime } from "@maycombhq/ai";
import {
  askKnowledge,
  conflictLine,
  correctableFields,
  fieldName,
  readConflicts,
  findKnowledge,
  keepCandidate,
  readFind,
  readFinds,
  saveFind,
  filterItems,
  knowledgeScanRoom,
  planRescan,
  readReviews,
  reviewItem,
  writeReview,
  type KnowledgeChanges,
  type KnowledgeScanResult,
  type RescanPlan,
  type ReviewSummary,
  itemTitle,
  readKnowledge,
  readSnapshot,
  scanKnowledge,
  setSourceTags,
  snapshotSources,
  tagList,
  writeKnowledge,
  type KnowledgeRecord,
  type Snapshot,
} from "@maycombhq/knowledge";
import { prepareKnowledgeBench, runKnowledgeBench, type KnowledgeScore } from "@maycombhq/evals";
import { codeFactRecords } from "@maycombhq/planner";
import type { Output } from "./commands.js";
import { table } from "./table.js";

/**
 * Knowledge sources tagged, snapshot, scanned and queried (ADR 0083, revamp plan 4.3):
 * `atticus sources tag`, `atticus knowledge scan|list|ask` and `atticus bench knowledge`.
 */

export interface KnowledgeDeps {
  /** The runtime to read with; the CLI builds it from runtime.yaml (or --mode). */
  runtime: AiRuntime;
  now?: Date;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * atticus sources tag <source> [--kind k,k] [--framework f,f] [--owner o]: write the source's
 * tags into org-pack/sources.yaml. The change is a file: commit it through a pull request.
 */
export async function sourcesTag(
  root: string,
  source: string,
  o: { kinds?: string[]; frameworks?: string[]; owner?: string },
  io: Output,
): Promise<number> {
  if (!o.kinds && !o.frameworks && o.owner === undefined) {
    io.err(
      'Say what to tag, for example: atticus sources tag forge-wiki --kind integration-patterns,security-standard --framework anvil --owner "Enterprise Architecture"',
    );
    return 2;
  }
  const file = join(orgPackDirOf(root), "sources.yaml");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(
      "There is no org-pack/sources.yaml. Add a source first: atticus sources add <type> <location>",
    );
    return 2;
  }
  const r = setSourceTags(text, source, {
    ...(o.kinds ? { kinds: o.kinds } : {}),
    ...(o.frameworks ? { frameworks: o.frameworks } : {}),
    ...(o.owner !== undefined ? { owner: o.owner } : {}),
  });
  if (!r.ok) {
    io.err(r.error);
    return 1;
  }
  await writeFile(file, r.text, "utf8");
  io.out(
    `Tagged ${source}: kinds ${r.tags.kinds.join(", ") || "none"}; frameworks ${r.tags.frameworks.join(", ") || "none"}; owner ${r.tags.owner ?? "none"}.`,
  );
  if (r.unusualKinds.length)
    io.out(
      `${r.unusualKinds.join(", ")} ${r.unusualKinds.length === 1 ? "isn't a suggested kind" : "aren't suggested kinds"} (enterprise-architecture, integration-patterns, platform-runbook, security-standard, change-process, framework). Your own kinds are fine; check for a typo.`,
    );
  io.out(
    "org-pack/sources.yaml changed: commit it through a pull request. The next knowledge scan uses the tags.",
  );
  return 0;
}

async function snapshotsFor(
  root: string,
  source: string | undefined,
  io: Output,
): Promise<Snapshot[] | undefined> {
  const ids = source ? [source] : await snapshotSources(root);
  const out: Snapshot[] = [];
  for (const id of ids) {
    const s = await readSnapshot(root, id);
    if (s) out.push(s);
  }
  if (!out.length) {
    io.err(
      source
        ? `There is no snapshot of ${source} yet. Run atticus sources sync --source ${source} first.`
        : "There is no snapshot yet. Run atticus sources sync first: the knowledge scan reads only snapshots.",
    );
    return undefined;
  }
  // A snapshot taken before the source was tagged reads with the tags it has now.
  const op = await loadOrgPack(orgPackDirOf(root));
  for (const s of out) {
    const w = op.sources.wikis.find((x) => x.id === s.manifest.source);
    if (w?.tags) s.manifest.tags = { kinds: w.tags.kinds, frameworks: w.tags.frameworks };
    if (w?.owner) s.manifest.owner = w.owner;
  }
  return out;
}

/**
 * atticus knowledge scan [--source s] [--mode m] [--attempts 3] [--resume run] [--json]: the AI
 * reads the newest snapshot of each source and every item it writes is checked against the
 * page. Exit 0 when every item passed, 1 when some still fail, 2 when there is nothing to read.
 */
export async function knowledgeScan(
  root: string,
  o: {
    source?: string;
    attempts?: number;
    resume?: string;
    json?: boolean;
    full?: boolean;
    batchTokens?: number;
  },
  deps: KnowledgeDeps,
  io: Output,
): Promise<number> {
  const snapshots = await snapshotsFor(root, o.source, io);
  if (!snapshots) return 2;
  const op = await loadOrgPack(orgPackDirOf(root));
  const now = deps.now ?? new Date();
  // Every page is read, in batches that each fit the reader's prompt (ADR 0106): --batch-tokens
  // sets a batch's room for pages; else it is what the reader's budget (and the model's limit,
  // --max-tokens, ADR 0112) leaves beside the instructions. A page the prompt still has no room
  // for is named and left for the next batch, never dropped without a word.
  const room = o.batchTokens ?? knowledgeScanRoom(snapshots, op);
  // A runtime that answers at once reads batch after batch; a hand-off (and its resume) reads
  // one batch a run and says what is left, as `atticus map` hands one batch a round.
  const once = o.resume !== undefined || deps.runtime.kind === "hand-off";
  const batches: { plan: RescanPlan; r: KnowledgeScanResult; changes: KnowledgeChanges }[] = [];
  /** Pages read in this run, and pages too big for the prompt on their own, by source. */
  const readNow: Record<string, string[]> = {};
  const tooBig: { source: string; page: string; reason: string }[] = [];
  const passed = () => {
    const out: Record<string, string[]> = {};
    for (const [s, ps] of Object.entries(readNow)) out[s] = [...ps];
    for (const t of tooBig) (out[t.source] ??= []).push(t.page);
    return out;
  };
  /** The pages that wait for the next batch. */
  let pending: string[];
  let plan!: RescanPlan;
  let r!: KnowledgeScanResult;
  for (;;) {
    // ADR 0101: a rescan reads only the pages that changed since the last scan (--full: all).
    const before = await readKnowledge(root, { raw: true });
    plan = planRescan(snapshots, before.report, before.items, {
      full: o.full === true,
      batchTokens: room,
      read: passed(),
    });
    const gone = Object.values(plan.removed).flat().length;
    if (!plan.snapshots.length && !gone) {
      pending = [];
      if (batches.length) break;
      for (const s of snapshots)
        io.out(
          `Nothing changed in ${s.manifest.source} since the last scan (snapshot ${s.manifest.date}, ${plural(s.manifest.pages.length, "page")}). --full reads every page again.`,
        );
      return 0;
    }
    r = plan.snapshots.length
      ? await scanKnowledge(plan.snapshots, {
          runtime: deps.runtime,
          orgPack: op,
          now,
          maxAttempts: o.attempts ?? 3,
          ...(o.resume && !batches.length ? { resume: o.resume } : {}),
          ...(plan.previous.length ? { previous: plan.previous } : {}),
          judgments: fileJudgments(root),
        })
      : {
          status: "scanned",
          attempts: [],
          items: [],
          conflicts: [],
          superseded: [],
          injections: [],
          failed: [],
          snapshots: [],
        };
    const deferred = Object.entries(plan.deferred).flatMap(([s, ps]) => ps.map((p) => `${s}/${p}`));
    const unread = new Set((r.leftOut ?? []).map((l) => `${l.source}/${l.page}`));
    pending = [...deferred, ...unread];
    if (r.status !== "scanned") break;
    const w = await writeKnowledge(root, r, stamp(now), { snapshots, plan });
    batches.push({ plan, r, changes: w.changes });
    let read = 0;
    for (const [source, pages] of Object.entries(plan.changed))
      for (const p of pages)
        if (!unread.has(`${source}/${p}`)) {
          (readNow[source] ??= []).push(p);
          read++;
        }
    // Nothing of this batch fitted: each page it planned is too big for the prompt on its own.
    // It is named at the end, and the scan goes on with the rest.
    if (!read && unread.size) {
      tooBig.push(...(r.leftOut ?? []));
      pending = deferred;
      if (pending.length) continue;
      break;
    }
    if (!pending.length || once) break;
  }
  const named = (xs: string[]) =>
    xs.length > 10 ? `${xs.slice(0, 10).join(", ")} and ${xs.length - 10} more` : xs.join(", ");
  if (r.status === "waiting" && pending.length) {
    const inBatch = Object.values(plan.changed).flat().length - (r.leftOut?.length ?? 0);
    io.out(
      `This batch holds ${plural(inBatch, "page")}, as many as fit the reader's prompt; ${plural(pending.length, "page")} wait for the next (${named(pending)}). After this one, run atticus knowledge scan again.`,
    );
  }
  if (r.status === "waiting") {
    // B2: a resume whose answer failed says what failed, not only that a new prompt waits.
    const failed = r.attempts.filter((a) => a.state !== "waiting" && a.problems.length).at(-1);
    if (o.resume && failed) {
      io.out(
        `The answer of run ${failed.runId} failed ${plural(failed.problems.length, "check")}, handed back with the next prompt:`,
      );
      for (const p of failed.problems) io.out(`  ${p}`);
      if (failed.kept)
        io.out(
          `${failed.kept === 1 ? "1 item passed and is" : `${failed.kept} items passed and are`} kept for the next attempt.`,
        );
    }
    io.out(
      `Handed the knowledge scan to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus knowledge scan${o.source ? ` --source ${o.source}` : ""} --resume ${r.runId}`,
    );
    return 0;
  }
  if (r.status === "failed") {
    io.err(
      `The knowledge scan got no answer it could read after ${plural(r.attempts.length, "attempt")}: ${r.attempts.at(-1)?.problems.join("; ") ?? "no run"}. ${batches.length ? `The ${plural(batches.length, "batch")} before it ${batches.length === 1 ? "was" : "were"} written; nothing of this one was.` : "Nothing was written."}`,
    );
    return 1;
  }
  // What every batch of this run read, kept and flagged, as one scan.
  const first = batches[0]!.plan;
  const all = (f: (r: KnowledgeScanResult) => unknown[]) => batches.flatMap((b) => f(b.r));
  const total = {
    ...r,
    items: all((x) => x.items) as KnowledgeScanResult["items"],
    conflicts: all((x) => x.conflicts) as KnowledgeScanResult["conflicts"],
    superseded: all((x) => x.superseded) as KnowledgeScanResult["superseded"],
    injections: all((x) => x.injections) as KnowledgeScanResult["injections"],
    failed: all((x) => x.failed) as KnowledgeScanResult["failed"],
    attempts: all((x) => x.attempts) as KnowledgeScanResult["attempts"],
  };
  const was = new Set(batches.flatMap((b) => [...b.changes.added, ...b.changes.changed]));
  const c: KnowledgeChanges = {
    added: [...new Set(batches.flatMap((b) => b.changes.added))].sort(),
    changed: [...new Set(batches.flatMap((b) => b.changes.changed))].sort(),
    removed: [...new Set(batches.flatMap((b) => b.changes.removed))]
      .filter((id) => !was.has(id))
      .sort(),
  };
  // Pages that wait for the next batch (a tool that runs the batches reads pagesLeft); pages too
  // big for the prompt on their own aren't among them: another batch won't read them.
  const left = pending.length;
  const big = tooBig.map((t) => `${t.source}/${t.page}`);
  const after = await readKnowledge(root);
  const recheck = Object.entries(after.reviews)
    .filter(([, v]) => v.state === "stale")
    .map(([id]) => id);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          ...total,
          changes: c,
          recheck,
          plan: { changed: first.changed, removed: first.removed, unchanged: first.unchanged },
          batches: batches.length,
          pagesLeft: left,
          ...(left ? { left: pending } : {}),
          ...(big.length ? { tooBig } : {}),
        },
        null,
        2,
      ),
    );
    if (left) io.report?.({ pagesLeft: left });
    return total.failed.length ? 1 : 0;
  }
  for (const s of snapshots) {
    const id = s.manifest.source;
    const read = readNow[id]?.length ?? 0;
    const kept = first.unchanged[id] ?? 0;
    const removed = first.removed[id]?.length ?? 0;
    const n = batches.filter((b) => b.r.attempts.length).length;
    const inBatches = n > 1 ? ` in ${n} batches, each within the reader's prompt` : "";
    io.out(
      kept || removed
        ? `Read ${plural(read, "page")} of ${id} that changed or are new${inBatches} (snapshot ${s.manifest.date}); kept ${plural(kept, "page")}'s items as they were${removed ? `; ${plural(removed, "page")} gone` : ""}.`
        : `Read ${plural(read, "page")} of ${id}${inBatches} (snapshot ${s.manifest.date}).`,
    );
  }
  if (c.added.length) io.out(`New: ${c.added.join(", ")}`);
  if (c.changed.length) io.out(`Changed: ${c.changed.join(", ")}`);
  if (c.removed.length) io.out(`Gone: ${c.removed.join(", ")}`);
  if (!c.added.length && !c.changed.length && !c.removed.length) io.out("No item changed.");
  if (recheck.length)
    io.out(
      `Reviews to check again, their page changed: ${recheck.join(", ")} (atticus knowledge verify <item>).`,
    );
  const items = total.items;
  const count = (k: KnowledgeKind) => items.filter((i) => knowledgeKindOf(i) === k).length;
  io.out(
    `Kept ${plural(items.length, "item")}${
      items.length
        ? `, each quote checked on its page: ${KNOWLEDGE_KINDS.filter((k) => count(k) > 0)
            .map((k) => `${count(k)} ${k}`)
            .join(", ")}`
        : ""
    }.`,
  );
  io.out(`Written to ${knowledgeRelOf(root)}/items/ and ${knowledgeRelOf(root)}/scan.yaml.`);
  if (big.length)
    io.out(
      `${plural(big.length, "page")} didn't fit the reader's prompt on ${big.length === 1 ? "its" : "their"} own and ${big.length === 1 ? "isn't" : "aren't"} read: ${named(big)} (${tooBig[0]!.reason}). Give the knowledge reader more room (budgets.perAgent.knowledge-reader in org-pack/runtime.yaml), or use a model with a bigger limit, then run atticus knowledge scan again.`,
    );
  if (left) {
    io.out(
      `${plural(left, "page")} left to read: run atticus knowledge scan again for the next batch (${named(pending)}).`,
    );
    // As data too, for a tool that runs the batches (--handoff --json gives it as pagesLeft).
    io.report?.({ pagesLeft: left });
  }
  if (total.conflicts.length) {
    io.out(
      `${plural(total.conflicts.length, "conflict")} between pages (both kept, for an owner to settle):`,
    );
    for (const x of total.conflicts)
      io.out(
        `  ${x.about.join(", ")}: ${x.pages.map((p, k) => `${p.page} says "${x.says[k]}"`).join("; ")}. ${x.owner ? `${x.owner.page} is suggested (${x.owner.signal}: ${x.owner.detail}); a change that relies on it asks a person` : "A change that relies on it asks a person which page applies"}.`,
      );
  }
  for (const s of total.superseded)
    io.out(
      `Superseded: ${s.old.page} is replaced by ${s.new.page}; nothing on it was kept as a current rule.`,
    );
  const inj = total.injections;
  if (inj.length) {
    io.out(
      `${plural(inj.length, "passage")} that tr${inj.length === 1 ? "ies" : "y"} to instruct AI tools (data, never followed; a person should review the page):`,
    );
    for (const i of inj)
      io.out(
        `  ${i.source}/${i.page}:${i.line}${i.section ? ` (${i.section})` : ""}${i.hidden ? ", hidden from readers" : ""}: "${i.text}"`,
      );
  }
  const failed = total.failed;
  if (failed.length) {
    io.out(
      `${plural(failed.length, "item")} still fail${failed.length === 1 ? "s" : ""} the checks and ${failed.length === 1 ? "was" : "were"} not kept:`,
    );
    for (const f of failed) io.out(`  ${f.kind} ${f.id}: ${f.problems.join("; ")}`);
    return 1;
  }
  return 0;
}

const where = (r: KnowledgeRecord) =>
  r.quote
    ? `${r.quote.source}/${r.quote.page}${r.quote.section ? ` (${r.quote.section})` : ""}`
    : "";

/** atticus knowledge list [--tag t] [--kind k] [--json]: the knowledge items, filtered. */
export async function knowledgeList(
  root: string,
  o: { tag?: string; kind?: string; json?: boolean; unverified?: boolean },
  io: Output,
): Promise<number> {
  if (o.kind && !(KNOWLEDGE_KINDS as readonly string[]).includes(o.kind)) {
    io.err(`There is no knowledge kind ${o.kind}. Use one of: ${KNOWLEDGE_KINDS.join(", ")}.`);
    return 2;
  }
  const k = await readKnowledge(root);
  for (const p of k.problems) io.err(`${knowledgeRelOf(root)}/items/${p.file}: ${p.message}`);
  if (!k.items.length) {
    io.err(
      "There are no knowledge items yet. Run atticus sources sync, then atticus knowledge scan.",
    );
    return 2;
  }
  // Rejected items are listed too, marked: a person said why, and the next one reads it.
  const items = filterItems([...k.items, ...k.rejected], {
    ...(o.tag ? { tag: o.tag } : {}),
    ...(o.kind ? { kind: o.kind as KnowledgeKind } : {}),
  }).sort((a, b) => a.id.localeCompare(b.id));
  const reviews = k.reviews;
  // --unverified: what no person has verified yet, or whose page changed since.
  if (o.unverified)
    for (let i = items.length - 1; i >= 0; i--) {
      const st = reviews[items[i]!.id]?.state;
      if (st === "verified" || st === "corrected" || st === "rejected") items.splice(i, 1);
    }
  if (o.json) {
    io.out(
      JSON.stringify(
        items.map((i) => ({
          ...i,
          knowledgeKind: knowledgeKindOf(i),
          ...(reviews[i.id] ? { review: reviews[i.id] } : {}),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!items.length) {
    io.out("No item matches.");
    return 0;
  }
  for (const l of table(
    ["KIND", "ID", "TITLE", "REVIEW", "FROM"],
    items.map((r) => [
      knowledgeKindOf(r) ?? r.kind,
      r.id + (r.flags?.some((f) => f.startsWith("conflict:")) ? " !" : ""),
      itemTitle(r),
      reviewWord(reviews[r.id]),
      where(r),
    ]),
  ))
    io.out(l);
  if (Object.values(reviews).some((v) => v.state === "stale"))
    io.out(
      "check again: a person reviewed it, then its page changed (atticus knowledge verify <item>)",
    );
  if (items.some((r) => r.flags?.some((f) => f.startsWith("conflict:"))))
    io.out(
      "! another page disagrees: atticus knowledge conflicts says what each page says and which applies",
    );
  return 0;
}

/**
 * atticus knowledge ask "<question>" [--mode m] [--resume run] [--json]: an answer from the
 * knowledge items only, citing them. Exit 0 answered, 1 refused, 2 nothing to ask.
 */
export async function knowledgeAsk(
  root: string,
  question: string,
  o: { resume?: string; json?: boolean },
  deps: KnowledgeDeps,
  io: Output,
): Promise<number> {
  const k = await readKnowledge(root);
  if (!k.items.length) {
    io.err(
      "There are no knowledge items yet. Run atticus sources sync, then atticus knowledge scan.",
    );
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const r = await askKnowledge([question], {
    items: k.items,
    conflicts: k.report?.conflicts ?? [],
    runtime: deps.runtime,
    orgPack: op,
    ...(deps.now ? { now: deps.now } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  });
  if (r.status === "waiting") {
    io.out(
      `Handed the question to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus knowledge ask ${JSON.stringify(question)} --resume ${r.runId}`,
    );
    return 0;
  }
  const a = r.answers[0]!;
  if (o.json) {
    io.out(JSON.stringify(a, null, 2));
    return a.status === "answered" ? 0 : 1;
  }
  if (a.status !== "answered") {
    io.out(`Atticus can't answer that from the knowledge items: ${a.problems.join(" ")}`);
    return 1;
  }
  io.out(a.answer!);
  io.out("");
  io.out("From:");
  const byId = new Map(k.items.map((i) => [i.id, i]));
  for (const id of a.cites) {
    const item = byId.get(id)!;
    io.out(
      `  ${id}: ${itemTitle(item)}, ${where(item)}${item.quote ? `: "${item.quote.text}"` : ""}`,
    );
  }
  return 0;
}

/** A candidate as the JSON and the plugin read it. */
function candidateJson(c: { record: KnowledgeRecord; known?: string; kept?: unknown }) {
  const r = c.record as KnowledgeRecord & Record<string, unknown>;
  return {
    id: r.id,
    kind: knowledgeKindOf(r),
    title: itemTitle(r),
    ...(typeof r.appliesWhen === "string" ? { appliesWhen: r.appliesWhen } : {}),
    ...(Array.isArray(r.steps) && r.steps.length ? { steps: r.steps } : {}),
    ...(Array.isArray(r.urls) && r.urls.length ? { urls: r.urls } : {}),
    page: r.quote?.page,
    section: r.quote?.section,
    quote: r.quote?.text,
    ...(c.known ? { known: c.known } : {}),
    ...(c.kept ? { kept: c.kept } : {}),
  };
}

/**
 * atticus knowledge find "<term or phrase>" [--source s] [--mode m] [--resume run] [--json]
 * (ADR 0101): search every snapshot for it, then have the assistant read the pages that mention
 * it and propose what isn't a knowledge item yet, each quote checked. Exit 0 found or nothing
 * found, 1 when the assistant's answer failed its checks, 2 when there is nothing to search.
 */
export async function knowledgeFind(
  root: string,
  phrase: string,
  o: { source?: string; resume?: string; json?: boolean; attempts?: number },
  deps: KnowledgeDeps,
  io: Output,
): Promise<number> {
  const snapshots = await snapshotsFor(root, o.source, io);
  if (!snapshots) return 2;
  const op = await loadOrgPack(orgPackDirOf(root));
  const now = deps.now ?? new Date();
  const k = await readKnowledge(root);
  const r = await findKnowledge(snapshots, phrase, {
    runtime: deps.runtime,
    items: [...k.items, ...k.rejected],
    orgPack: op,
    judgments: fileJudgments(root),
    now,
    maxAttempts: o.attempts ?? 3,
    ...(o.resume ? { resume: o.resume } : {}),
  });
  if (r.status === "waiting") {
    io.out(
      `Handed the search to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus knowledge find ${JSON.stringify(phrase)}${o.source ? ` --source ${o.source}` : ""} --resume ${r.runId}`,
    );
    return 0;
  }
  const slug = r.status === "found" ? await saveFind(root, r, stamp(now)) : undefined;
  const file = slug ? `${knowledgeRelOf(root)}/finds/${slug}.yaml` : undefined;
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          status: r.status,
          ...(r.runId ? { runId: r.runId } : {}),
          phrase,
          ...(slug ? { slug, file } : {}),
          pages: [...new Set(r.matches.map((m) => `${m.source}/${m.page}`))],
          matches: r.matches,
          candidates: r.candidates.map(candidateJson),
          failed: r.failed,
          problems: r.problems,
        },
        null,
        2,
      ),
    );
    return r.status === "failed" ? 1 : 0;
  }
  if (r.status === "nothing") {
    io.out(`No page of the wikis mentions "${phrase}". Nothing was sent to the assistant.`);
    return 0;
  }
  if (r.status === "failed") {
    io.err(`The assistant's answer failed its checks: ${r.problems.join("; ")}. Nothing was kept.`);
    return 1;
  }
  const pages = [...new Set(r.matches.map((m) => `${m.source}/${m.page}`))];
  io.out(`"${phrase}" is on ${plural(pages.length, "page")}: ${pages.join(", ")}.`);
  const fresh = r.candidates.filter((c) => !c.known);
  io.out(
    `The assistant found ${plural(r.candidates.length, "item")} about it, each quote checked${fresh.length < r.candidates.length ? `; ${r.candidates.length - fresh.length} already known` : ""}:`,
  );
  for (const c of r.candidates)
    io.out(
      `  ${c.known ? "known" : "new  "} ${knowledgeKindOf(c.record)} ${c.record.id}: ${itemTitle(c.record)} (${c.record.quote?.page})`,
    );
  if (r.failed.length)
    io.out(
      `${plural(r.failed.length, "item")} failed the checks and ${r.failed.length === 1 ? "was" : "were"} left out.`,
    );
  io.out(
    `Saved in ${file}. Keep one with atticus knowledge keep <item> --find ${slug} [--as <kind>] [--set field=value].`,
  );
  return 0;
}

/** atticus knowledge keep <candidate> --find <slug> [--as kind] [--set f=v]… [--note text]. */
export async function knowledgeKeep(
  root: string,
  id: string,
  o: {
    find?: string;
    as?: string;
    set?: string[];
    note?: string;
    by: string;
    now?: Date;
    json?: boolean;
  },
  io: Output,
): Promise<number> {
  let slug = o.find;
  if (!slug) {
    const all = await readFinds(root);
    const having = [];
    for (const f of all)
      if ((await readFind(root, f.slug))?.candidates.some((c) => c.record.id === id))
        having.push(f.slug);
    if (having.length !== 1) {
      io.err(
        having.length
          ? `${id} is in more than one search (${having.join(", ")}): say which with --find.`
          : `No saved search has a candidate ${id}. atticus knowledge finds lists the searches.`,
      );
      return 2;
    }
    slug = having[0]!;
  }
  if (o.as && !(KNOWLEDGE_KINDS as readonly string[]).includes(o.as)) {
    io.err(`There is no knowledge kind ${o.as}. Use one of: ${KNOWLEDGE_KINDS.join(", ")}.`);
    return 2;
  }
  const f = await readFind(root, slug);
  const cand = f?.candidates.find((c) => c.record.id === id);
  const fields = cand ? correctableFields(cand.record) : {};
  const set: Record<string, string | string[]> = {};
  for (const pair of o.set ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) {
      io.err(`--set takes field=value, not ${pair}.`);
      return 2;
    }
    const field = fieldName(pair.slice(0, at).trim(), fields);
    const value = pair.slice(at + 1);
    set[field] =
      fields[field] === "list" || fields[field] === "links"
        ? value.split("|").map((x) => x.trim())
        : value.trim();
  }
  const r = await keepCandidate(root, slug, id, {
    ...(o.as ? { as: o.as as KnowledgeKind } : {}),
    by: o.by,
    at: stamp(o.now ?? new Date()),
    ...(o.note ? { note: o.note } : {}),
    ...(Object.keys(set).length ? { set } : {}),
  });
  if ("error" in r) {
    io.err(r.error);
    return 2;
  }
  if (o.json) {
    io.out(JSON.stringify({ item: r.item, as: r.as, find: slug }, null, 2));
    return 0;
  }
  io.out(
    `Kept ${id} as a ${r.as}, verified by ${o.by}: plans, answers and lists read it from now on.`,
  );
  io.out(
    `Written to ${knowledgeRelOf(root)}/items/ and reviews/: commit them through a pull request.`,
  );
  return 0;
}

/**
 * atticus knowledge conflicts [--json] (ADR 0124 addendum B-task-knowledge): the pages that
 * disagree, what each says, and which applies: the page a person chose (their question and
 * answer), the page the code settles it for (the record verified from code, cited), or nobody
 * yet (the question waiting, or none until a change relies on it), with the page a signal
 * suggests.
 */
export async function knowledgeConflicts(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const all = await readConflicts(root, { records: await codeFactRecords(root) });
  if (o.json) {
    io.out(JSON.stringify(all, null, 2));
    return 0;
  }
  if (!all.length) {
    io.out("No pages disagree in the last knowledge scan (knowledge/scan.yaml).");
    return 0;
  }
  io.out(`${plural(all.length, "conflict")} between pages:`);
  for (const v of all) io.out(`- ${conflictLine(v)}`);
  const open = all.filter((v) => v.question?.state === "open");
  if (open.length)
    io.out(
      `${plural(open.length, "question")} wait${open.length === 1 ? "s" : ""} for a person: atticus questions answer <id> --option <n>, or in the app.`,
    );
  return 0;
}

/** atticus knowledge finds [--json]: the saved searches, newest first. */
export async function knowledgeFinds(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const all = await readFinds(root);
  if (o.json) {
    const out = [];
    for (const f of all) {
      const s = await readFind(root, f.slug);
      out.push({ ...f, candidateList: (s?.candidates ?? []).map(candidateJson) });
    }
    io.out(JSON.stringify(out, null, 2));
    return 0;
  }
  if (!all.length) {
    io.out('No search yet. atticus knowledge find "<term or phrase>" searches every wiki.');
    return 0;
  }
  for (const l of table(
    ["SEARCH", "PHRASE", "WHEN", "FOUND", "KEPT"],
    all.map((f) => [f.slug, f.phrase, f.at.slice(0, 10), String(f.candidates), String(f.kept)]),
  ))
    io.out(l);
  return 0;
}

/** A review in the list: a tick for verified, the state otherwise (ADR 0101). */
export function reviewWord(r: ReviewSummary | undefined): string {
  if (!r) return "";
  if (r.state === "verified") return `✓ ${r.by}`;
  if (r.state === "corrected") return `✓ corrected by ${r.by}`;
  if (r.state === "rejected") return `✗ rejected by ${r.by}`;
  return "check again";
}

/**
 * atticus knowledge verify|correct|reject <item>: a person's review of an item (ADR 0101),
 * written to knowledge/reviews/<item>.yaml and committed with the metarepo. correct takes
 * --set field=value (a list field takes values split by |); reject takes --note, the reason.
 */
export async function knowledgeReview(
  root: string,
  verdict: "verified" | "corrected" | "rejected",
  id: string,
  o: { set?: string[]; note?: string; by: string; now?: Date; json?: boolean },
  io: Output,
): Promise<number> {
  const k = await readKnowledge(root, { raw: true });
  const item = k.items.find((i) => i.id === id);
  if (!item) {
    io.err(
      `There is no knowledge item ${id}. atticus knowledge list shows them; atticus knowledge scan reads them.`,
    );
    return 1;
  }
  const fields = correctableFields(item);
  const set: Record<string, string | string[]> = {};
  for (const pair of o.set ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) {
      io.err(`--set takes field=value, not ${pair}.`);
      return 2;
    }
    const field = fieldName(pair.slice(0, at).trim(), fields);
    const value = pair.slice(at + 1);
    // A list (and a list of links) takes a|b|c.
    set[field] =
      fields[field] === "list" || fields[field] === "links"
        ? value.split("|").map((x) => x.trim())
        : value.trim();
  }
  // Correcting again keeps what an earlier correction set, unless it is set again (as the app does).
  if (verdict === "corrected") {
    const before = (await readReviews(root)).reviews.get(id)?.corrections ?? {};
    for (const [k, v] of Object.entries(before))
      if (!(k in set))
        set[k] = Array.isArray(v)
          ? v.map((x) => (typeof x === "string" ? x : x.label ? `${x.label}=${x.url}` : x.url))
          : v;
  }
  const r = reviewItem(item, {
    verdict,
    by: o.by,
    at: stamp(o.now ?? new Date()),
    ...(o.note ? { note: o.note } : {}),
    ...(Object.keys(set).length ? { set } : {}),
  });
  if ("error" in r) {
    io.err(r.error);
    return 2;
  }
  const file = await writeReview(root, r.review);
  if (o.json) {
    io.out(
      JSON.stringify(
        { review: r.review, item: r.item, file: `${knowledgeRelOf(root)}/${file}` },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    verdict === "verified"
      ? `Verified ${id}, by ${o.by}.`
      : verdict === "corrected"
        ? `Corrected ${id} (${Object.keys(r.review.corrections ?? {}).join(", ")}), by ${o.by}.`
        : `Rejected ${id}, by ${o.by}: plans and answers leave it out.`,
  );
  io.out(
    `Written to ${knowledgeRelOf(root)}/${file}: commit it through a pull request. A rescan that changes the item asks for it to be checked again.`,
  );
  return 0;
}

// ------------------------------------------------------------------ the knowledge bench

const defaultCache = () =>
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "atticus", "bench")
    : join(homedir(), ".cache", "atticus", "bench");

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function printKnowledgeScore(s: KnowledgeScore, io: Output): void {
  const i = s.items;
  io.out(
    `Items: ${i.found} found, ${i.missed} missed, ${i.wrong} wrong (precision ${pct(i.precision)}, recall ${pct(i.recall)})`,
  );
  io.out(
    `  ${Object.entries(i.byKind)
      .map(
        ([k, v]) => `${k} ${v.found}/${v.found + v.missed}${v.wrong ? ` (+${v.wrong} wrong)` : ""}`,
      )
      .join(", ")}`,
  );
  if (i.missedIds.length) io.out(`  Missed: ${i.missedIds.join(", ")}`);
  if (i.wrongIds.length) io.out(`  Wrong: ${i.wrongIds.join(", ")}`);
  io.out(
    `Quotes: ${s.quotes.correct} of ${s.quotes.of} on the right page and heading, word for word`,
  );
  if (s.quotes.wrongIds.length) io.out(`  Wrong: ${s.quotes.wrongIds.join(", ")}`);
  io.out(
    `Conflicts: ${s.conflicts.flagged} of ${s.conflicts.of} flagged${s.conflicts.missed.length ? ` (missed: ${s.conflicts.missed.join(", ")})` : ""}`,
  );
  io.out(
    `Superseded pages: ${s.superseded.flagged} of ${s.superseded.of} flagged; ${s.superseded.itemsFromOldPages.length ? `items from an old page: ${s.superseded.itemsFromOldPages.join(", ")}` : "no item from an old page"}`,
  );
  io.out(
    `Injections: ${s.injections.flagged} of ${s.injections.of} flagged; ${s.injections.followed.length ? `FOLLOWED by ${s.injections.followed.join(", ")}` : "not followed"}`,
  );
  io.out(`Questions: ${s.questions.correct} of ${s.questions.of} answered citing the right items`);
  for (const q of s.questions.results.filter((x) => !x.correct))
    io.out(`  "${q.ask}": ${q.refused ? "refused" : `missing ${q.missing.join(", ")}`}`);
  io.out(
    "Not scored here: whether each answer's words agree with the expected answer. Read them in the results file.",
  );
}

/**
 * atticus bench knowledge [--mode m] [--resume run] [--bench dir] [--cache dir] [--json]: snapshot
 * the bench's invented wiki, scan it, ask the reference's questions, and print the score.
 */
export async function benchKnowledge(
  root: string,
  o: { bench?: string; cache?: string; resume?: string; json?: boolean },
  deps: { runtime?: AiRuntime; mode?: string; now?: Date },
  io: Output,
): Promise<number> {
  const bench = resolve(o.bench ?? join("bench", "knowledge"));
  const cache = resolve(o.cache ?? defaultCache());
  const work = join(cache, "knowledge");
  const stateFile = join(work, "bench-state.json");
  let resumeScan: string | undefined;
  let resumeAsk: string | undefined;
  if (o.resume) {
    const state = JSON.parse((await readFile(stateFile, "utf8").catch(() => "{}")) || "{}") as {
      step?: string;
      runId?: string;
    };
    if (state.runId !== o.resume) {
      io.err(
        `${o.resume} isn't the run the knowledge bench is waiting for${state.runId ? ` (it waits for ${state.runId})` : ""}.`,
      );
      return 2;
    }
    if (state.step === "ask") resumeAsk = o.resume;
    else resumeScan = o.resume;
  } else {
    try {
      await prepareKnowledgeBench(bench, work);
    } catch (e) {
      io.err(`There is no knowledge bench at ${bench}: ${(e as Error).message}`);
      return 2;
    }
    // The bench runs AI the way this metarepo's runtime.yaml says.
    await copyFile(
      join(orgPackDirOf(root), "runtime.yaml"),
      join(work, "org-pack", "runtime.yaml"),
    ).catch(() => {});
  }
  let runtime = deps.runtime;
  if (!runtime) {
    try {
      runtime = (await runtimeForCli(work, deps.mode ? { mode: deps.mode } : {})).runtime;
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  const now = deps.now ?? new Date();
  const r = await runKnowledgeBench({
    bench,
    work,
    runtime,
    now,
    ...(resumeScan ? { resumeScan } : {}),
    ...(resumeAsk ? { resumeAsk } : {}),
  });
  if (r.status === "waiting") {
    await mkdir(work, { recursive: true });
    await writeFile(stateFile, JSON.stringify({ step: r.step, runId: r.runId }) + "\n", "utf8");
    io.out(
      `Handed the ${r.step === "scan" ? "knowledge scan" : "bench questions"} to your assistant (run ${r.runId}, in ${work}). When it is done: atticus handoff done ${r.runId} --root ${JSON.stringify(work)}, then atticus bench knowledge --resume ${r.runId}`,
    );
    return 0;
  }
  const results = join(cache, "knowledge-results");
  await mkdir(results, { recursive: true });
  const file = join(results, `${stamp(now).replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ at: stamp(now), ...r }, null, 2) + "\n", "utf8");
  await writeFile(stateFile, "{}\n", "utf8");
  if (o.json) {
    io.out(JSON.stringify(r.score, null, 2));
    return 0;
  }
  io.out(`Knowledge bench: ${bench}`);
  printKnowledgeScore(r.score, io);
  if (r.scanProblems.length)
    io.out(
      `The scan's last attempt still had ${plural(r.scanProblems.length, "problem")}; they are in the results file.`,
    );
  io.out(`Details: ${file}`);
  return 0;
}

/** The CLI's knowledge commands (ADR 0083); undefined when the arguments aren't one of them. */
export async function knowledgeCli(
  root: string,
  positionals: string[],
  values: Record<string, unknown>,
  io: Output,
  who: () => string = () => "someone",
): Promise<number | undefined> {
  const [group, command, arg] = positionals;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const list = (v: unknown) =>
    Array.isArray(v) ? tagList(v.map(String)) : typeof v === "string" ? tagList([v]) : undefined;
  const json = values.json === true;
  const attempts = Number(str(values.attempts) ?? "3");
  const runtime = async () => {
    try {
      return (await runtimeForCli(root, str(values.mode) ? { mode: str(values.mode)! } : {}))
        .runtime;
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return undefined;
      }
      throw e;
    }
  };
  if (group === "sources" && command === "tag") {
    if (!arg) {
      io.err("Usage: atticus sources tag <source> [--kind k,k] [--framework f,f] [--owner o]");
      return 2;
    }
    const owner = Array.isArray(values.owner)
      ? values.owner.map(String).join(" ")
      : str(values.owner);
    const kinds = list(values.kind);
    const frameworks = list(values.framework);
    return sourcesTag(
      root,
      arg,
      {
        ...(kinds ? { kinds } : {}),
        ...(frameworks ? { frameworks } : {}),
        ...(owner !== undefined ? { owner } : {}),
      },
      io,
    );
  }
  if (group === "knowledge" && command === "scan") {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    const bt = str(values["batch-tokens"]);
    const batchTokens = bt === undefined ? undefined : Number(bt);
    if (batchTokens !== undefined && !(Number.isInteger(batchTokens) && batchTokens >= 500)) {
      io.err("--batch-tokens is a whole number of 500 or more: the room for pages in one prompt.");
      return 2;
    }
    const rt = await runtime();
    if (!rt) return 2;
    return knowledgeScan(
      root,
      {
        attempts,
        json,
        ...(values.full === true ? { full: true } : {}),
        ...(str(values.source) ? { source: str(values.source)! } : {}),
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
        ...(batchTokens ? { batchTokens } : {}),
      },
      { runtime: rt },
      io,
    );
  }
  if (group === "knowledge" && command === "list")
    return knowledgeList(
      root,
      {
        json,
        ...(str(values.tag) ? { tag: str(values.tag)! } : {}),
        ...(str(values.kind) ? { kind: str(values.kind)! } : {}),
        ...(values.unverified === true ? { unverified: true } : {}),
      },
      io,
    );
  if (group === "knowledge" && command === "ask") {
    const question = positionals.slice(2).join(" ").trim();
    if (!question) {
      io.err('Usage: atticus knowledge ask "<question>" [--mode m] [--resume run] [--json]');
      return 2;
    }
    const rt = await runtime();
    if (!rt) return 2;
    return knowledgeAsk(
      root,
      question,
      { json, ...(str(values.resume) ? { resume: str(values.resume)! } : {}) },
      { runtime: rt },
      io,
    );
  }
  if (group === "bench" && command === "knowledge")
    return benchKnowledge(
      root,
      {
        json,
        ...(str(values.bench) ? { bench: str(values.bench)! } : {}),
        ...(str(values.cache) ? { cache: str(values.cache)! } : {}),
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
      },
      str(values.mode) ? { mode: str(values.mode)! } : {},
      io,
    );
  if (group === "knowledge" && command === "find") {
    const phrase = positionals.slice(2).join(" ").trim();
    if (!phrase) {
      io.err(
        'Usage: atticus knowledge find "<term or phrase>" [--source s] [--mode m] [--resume run] [--json]',
      );
      return 2;
    }
    const rt = await runtime();
    if (!rt) return 2;
    return knowledgeFind(
      root,
      phrase,
      {
        json,
        attempts,
        ...(str(values.source) ? { source: str(values.source)! } : {}),
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
      },
      { runtime: rt },
      io,
    );
  }
  if (group === "knowledge" && command === "keep") {
    if (!arg) {
      io.err(
        "Usage: atticus knowledge keep <item> [--find search] [--as kind] [--set field=value] [--note text]",
      );
      return 2;
    }
    const set = Array.isArray(values.set)
      ? values.set.map(String)
      : typeof values.set === "string"
        ? [values.set]
        : [];
    return knowledgeKeep(
      root,
      arg,
      {
        set,
        by: who(),
        json,
        ...(str(values.find) ? { find: str(values.find)! } : {}),
        ...(str(values.as) ? { as: str(values.as)! } : {}),
        ...(str(values.note) ? { note: str(values.note)! } : {}),
      },
      io,
    );
  }
  if (group === "knowledge" && command === "finds") return knowledgeFinds(root, { json }, io);
  if (group === "knowledge" && command === "conflicts")
    return knowledgeConflicts(root, { json }, io);
  if (
    group === "knowledge" &&
    (command === "verify" || command === "correct" || command === "reject")
  ) {
    if (!arg) {
      io.err(
        `Usage: atticus knowledge ${command} <item>${command === "correct" ? " --set field=value" : ""}${command === "reject" ? " --note why" : " [--note text]"}`,
      );
      return 2;
    }
    const set = Array.isArray(values.set)
      ? values.set.map(String)
      : typeof values.set === "string"
        ? [values.set]
        : [];
    return knowledgeReview(
      root,
      command === "verify" ? "verified" : command === "correct" ? "corrected" : "rejected",
      arg,
      { set, by: who(), json, ...(str(values.note) ? { note: str(values.note)! } : {}) },
      io,
    );
  }
  if (group === "knowledge") {
    io.err(
      "Usage: atticus knowledge scan|list|ask|find|keep|finds|verify|correct|reject. See atticus --help.",
    );
    return 2;
  }
  return undefined;
}
