import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { recordFact, verifyScan, type VerifyResult } from "@maycombhq/assistant-kit";
import {
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  proposalsDirOf,
  proposalsRelOf,
  questionsRelOf,
  raiseQuestions,
  reusedLine,
  SCAN_VERIFY_SCHEMA_VERSION,
  ScanSettings,
  ScanVerifyProposal,
  type CatalogRecord,
  type VerifiedRecord,
  type VerifyFix,
  type VerifySettings,
} from "@maycombhq/core";
import { stepQuestionJudge } from "@maycombhq/planner";
import { checkScanSettings } from "@maycombhq/scanner";
import { fsRepo, type RepoHandle } from "@maycombhq/sdk";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";
import { repoFor, type OnboardDeps } from "./onboard-commands.js";

/**
 * atticus scan verify <repo> (ADR 0082), the last "AI" of a scan (ADR 0074): the assistant
 * compares the repo's code with what the last scan recorded. Every item it gives is checked
 * against the code and the catalog; what passes goes into proposals/scan/<repo>.yaml (settings
 * entries to accept, the records it confirmed), questions/ (what the code can't settle) and
 * proposals/scan/<repo>.findings.md (what a reader must read differently). Nothing here
 * changes the catalog or the org pack: `--accept` merges the settings when a person says so.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_WORDS = {
  "entry-point": "entry point",
  call: "call",
  table: "table",
  deployment: "deployment",
  other: "fact",
} as const;
const fixWords = (f: VerifyFix) =>
  "settings" in f
    ? "a scan settings entry"
    : "question" in f
      ? "a question for a person"
      : "a reader must change";
const sentence = (s: string) => {
  const t = s.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

const proposalFile = (root: string, repo: string) =>
  join(proposalsDirOf(root), "scan", `${repo}.yaml`);
const findingsFile = (root: string, repo: string) =>
  join(proposalsDirOf(root), "scan", `${repo}.findings.md`);

const EMPTY: VerifySettings = { exclude: [], prefixes: [], clients: [] };

/** Settings entries in `add` that `have` doesn't hold yet, by what they do (not why). */
function newEntries(have: VerifySettings, add: VerifySettings): VerifySettings {
  const ex = (e: VerifySettings["exclude"][number]) => e.path;
  const px = (p: VerifySettings["prefixes"][number]) => `${p.paths.join(",")} ${p.prefix}`;
  const cl = (c: VerifySettings["clients"][number]) =>
    `${c.paths.join(",")} ${c.base} ${c.names.join(",")}`;
  const fresh = <T>(had: T[], more: T[], key: (x: T) => string) => {
    const seen = new Set(had.map(key));
    return more.filter((x) => {
      const k = key(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return {
    exclude: fresh(have.exclude, add.exclude, ex),
    prefixes: fresh(have.prefixes, add.prefixes, px),
    clients: fresh(have.clients, add.clients, cl),
  };
}
const merge = (a: VerifySettings, b: VerifySettings): VerifySettings => {
  const n = newEntries(a, b);
  return {
    exclude: [...a.exclude, ...n.exclude],
    prefixes: [...a.prefixes, ...n.prefixes],
    clients: [...a.clients, ...n.clients],
  };
};
const size = (s: VerifySettings) => s.exclude.length + s.prefixes.length + s.clients.length;
const describeSettings = (s: VerifySettings) =>
  [
    s.exclude.length ? plural(s.exclude.length, "folder") + " left out" : "",
    s.prefixes.length ? plural(s.prefixes.length, "prefix", "prefixes") : "",
    s.clients.length ? plural(s.clients.length, "client base") : "",
  ]
    .filter(Boolean)
    .join(", ");

async function readProposal(root: string, repo: string) {
  const text = await readFile(proposalFile(root, repo), "utf8").catch(() => undefined);
  return text === undefined ? undefined : ScanVerifyProposal.parse(parse(text));
}

async function writeProposal(root: string, p: ScanVerifyProposal) {
  await mkdir(join(proposalsDirOf(root), "scan"), { recursive: true });
  await writeFile(
    proposalFile(root, p.repo),
    `# From atticus scan verify (ADR 0082): every item was checked against the code. Accept the settings with atticus scan verify ${p.repo} --accept.\n${stringify(ScanVerifyProposal.parse(p))}`,
    "utf8",
  );
}

/** The records whose evidence is in this repo. */
const ofRepo = (records: CatalogRecord[], repo: string) =>
  records.filter((r) => r.evidence.some((e) => e.repo === repo));

/** A confirmed record pinned to its first evidence line, so a later scan can see it still holds. */
async function pin(repo: RepoHandle, r: CatalogRecord): Promise<VerifiedRecord> {
  const e = r.evidence.find((x) => x.path) ?? r.evidence[0];
  if (!e?.path) return { record: r.id, at: "?" };
  if (!e.line) return { record: r.id, at: e.path };
  const text = await repo.readText(e.path).catch(() => undefined);
  const line = text?.replace(/\r\n?/g, "\n").split("\n")[e.line - 1];
  return {
    record: r.id,
    at: `${e.path}:${e.line}`,
    ...(line !== undefined
      ? { line: createHash("sha256").update(line.trim()).digest("hex").slice(0, 12) }
      : {}),
  };
}

function findings(
  repo: string,
  r: VerifyResult,
  now: Date,
  records: CatalogRecord[],
): {
  text: string;
  count: number;
} {
  const a = r.answer!;
  const items: string[] = [];
  for (const m of a.missed)
    if ("reader" in m.fix)
      items.push(
        `- Missed the ${KIND_WORDS[m.kind]} ${m.method ? `${m.method} ` : ""}${m.name} at ${m.at}. ${sentence(m.why)} What must change: ${sentence(m.fix.reader)}`,
      );
  for (const w of a.wrong)
    if ("reader" in w.fix) {
      const rec = records.find((x) => x.id === w.record);
      const f = rec ? recordFact(rec) : undefined;
      items.push(
        `- Wrong: ${w.record}${f ? ` (the ${KIND_WORDS[f.kind]} ${f.method ? `${f.method} ` : ""}${f.name})` : ""}, shown by ${w.at}. ${sentence(w.why)} What must change: ${sentence(w.fix.reader)}`,
      );
    }
  const text = [
    `# What the scan of ${repo} reads wrong`,
    "",
    `Found by atticus scan verify on ${now.toISOString().slice(0, 10)}${r.runId ? ` (run ${r.runId})` : ""}. No scan setting can put these right: each needs a change to a built-in reader or a scanner plugin (ADR 0080). Atticus checked that each cited line says what is quoted.`,
    "",
    ...(items.length ? items : ["Nothing this time."]),
    "",
  ].join("\n");
  return { text, count: items.length };
}

/** atticus scan verify <repo> [--attempts 3] [--resume run] [--json]. */
export async function scanVerify(
  root: string,
  target: string,
  o: { attempts?: number; resume?: string; json?: boolean },
  deps: OnboardDeps,
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(
      `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`,
    );
    return 2;
  }
  const { records: all } = await loadCatalog(root, { out: () => {}, err: (l) => io.err(l) });
  const records = ofRepo(all, repo.id);
  if (records.length === 0) {
    io.err(`The catalog has nothing from ${repo.id} yet: run atticus scan first.`);
    return 1;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const settings = op.scanSettings.find((s) => s.repo === repo.id);
  // Every question on file for the repo, whichever step asked it (ADR 0117): the step follows
  // the answers and says which one a question it would ask is (sameAs).
  const before = await listQuestions(root, { repo: repo.id }).then((l) => ({
    ...l,
    questions: l.questions.filter((q) => q.state !== "retired"),
  }));
  const handle = fsRepo(repo.id, repo.dir, "0".repeat(40));
  const now = deps.now ?? new Date();
  const r = await verifyScan(handle, {
    repoId: repo.id,
    runtime: deps.runtime,
    records,
    ...(settings ? { settings } : {}),
    orgPack: op,
    maxAttempts: o.attempts ?? 3,
    questions: before.questions,
    now,
    ...(o.resume ? { resume: o.resume } : {}),
  });
  if (r.status === "waiting") {
    io.out(
      `Handed the check to your assistant (run ${r.runId}). When it is done: atticus handoff done ${r.runId}, then atticus scan verify ${repo.id} --resume ${r.runId}`,
    );
    return 0;
  }
  const handedBack = r.attempts.filter(
    (x, n) => x.problems.length > 0 && n < r.attempts.length - 1,
  );
  if (r.status !== "checked" || !r.answer) {
    if (o.json) io.out(JSON.stringify({ status: r.status, attempts: r.attempts }, null, 2));
    else {
      for (const a of r.attempts) {
        io.out(`Attempt ${a.attempt}: ${plural(a.problems.length, "problem")}:`);
        for (const p of a.problems) io.out(`  - ${p}`);
      }
      io.out(
        `No answer could be read in ${plural(r.attempts.length, "attempt")}; nothing was written.`,
      );
    }
    return 1;
  }
  const a = r.answer;

  // Settings entries: merged with an earlier proposal's, leaving out what the settings hold.
  let fixes: VerifySettings = EMPTY;
  for (const item of [...a.missed, ...a.wrong])
    if ("settings" in item.fix) fixes = merge(fixes, item.fix.settings);
  const earlier = await readProposal(root, repo.id).catch(() => undefined);
  const proposed = newEntries(settings ?? EMPTY, merge(earlier?.settings ?? EMPTY, fixes));

  const drafts = [...a.missed, ...a.wrong].flatMap((x) =>
    "question" in x.fix ? [x.fix.question] : [],
  );
  // ADR 0117: a question on file is matched by the step's own reading (sameAs) and, where a
  // model can be called directly, a judge.
  const judge = stepQuestionJudge(root, deps.runtime, repo.id, now);
  const { raised, known, reused } = await raiseQuestions(
    root,
    drafts,
    {
      step: "scan-verify",
      repo: repo.id,
      command: `atticus scan verify ${repo.id}`,
      rerun: `atticus scan verify ${repo.id}`,
      ...(r.runId ? { run: r.runId } : {}),
      at: now.toISOString(),
    },
    judge ? { judge } : {},
  );
  const byId = new Map(records.map((x) => [x.id, x]));
  // Only confirmations that cite the line showing them passed the checks (ADR 0112); only
  // those are pinned as verified.
  const verified = await Promise.all(
    a.confirmed
      .map((c) => c.record)
      .sort()
      .map((id) => pin(handle, byId.get(id)!)),
  );
  const proposal: ScanVerifyProposal = {
    schemaVersion: SCAN_VERIFY_SCHEMA_VERSION,
    repo: repo.id,
    ...(r.runId ? { run: r.runId } : {}),
    at: now.toISOString(),
    settings: proposed,
    missed: a.missed,
    wrong: a.wrong.map((w) => ({ ...w, ...recordFact(byId.get(w.record)!) })),
    verified,
    questions: [...new Set([...raised, ...known].map((q) => q.id))].sort(),
    ...(earlier?.accepted ? { accepted: earlier.accepted } : {}),
  };
  await writeProposal(root, proposal);
  const f = findings(repo.id, r, now, records);
  await writeFile(findingsFile(root, repo.id), f.text, "utf8");

  const rel = proposalsRelOf(root);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          status: r.status,
          proposal,
          refused: r.refused,
          attempts: r.attempts,
          questions: { raised: raised.map((q) => q.id), known: known.map((q) => q.id) },
          files: {
            proposal: `${rel}/scan/${repo.id}.yaml`,
            findings: `${rel}/scan/${repo.id}.findings.md`,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    `Checked ${repo.id} against its last scan: ${a.missed.length} missed, ${a.wrong.length} wrong, ${a.confirmed.length} confirmed.`,
  );
  for (const at of handedBack) {
    io.out(`Attempt ${at.attempt}: ${plural(at.problems.length, "problem")}, handed back:`);
    for (const p of at.problems) io.out(`  - ${p}`);
  }
  if (r.refused.length) {
    io.out("Left out, because the last attempt still failed its checks:");
    for (const p of r.refused) io.out(`  - ${p}`);
  }
  for (const m of a.missed)
    io.out(
      `  missed: ${KIND_WORDS[m.kind]} ${m.method ? `${m.method} ` : ""}${m.name} (${m.at}); ${fixWords(m.fix)}`,
    );
  for (const w of a.wrong) io.out(`  wrong: ${w.record} (${w.at}); ${fixWords(w.fix)}`);
  io.out(
    `Wrote ${rel}/scan/${repo.id}.yaml: ${plural(size(proposed), "settings entry", "settings entries")} to accept, ${plural(verified.length, "record")} confirmed.`,
  );
  if (f.count)
    io.out(
      `Wrote ${rel}/scan/${repo.id}.findings.md: ${plural(f.count, "thing")} a reader or a scanner plugin must read differently.`,
    );
  const waiting = known.filter((q) => q.state === "open");
  if (raised.length) {
    io.out(`${plural(raised.length, "question")} for a person, in ${questionsRelOf(root)}/:`);
    for (const q of raised) io.out(`  ${q.id} ${q.question}`);
  }
  for (const q of reused) io.out(reusedLine(q));
  if (waiting.length)
    io.out(
      `${plural(waiting.length, "question")} still waiting for an answer: ${waiting.map((q) => q.id).join(", ")}`,
    );
  if (raised.length + waiting.length)
    io.out(
      `Answer with atticus questions answer <id> --option <n>, or on the app's Questions page; then run atticus scan verify ${repo.id} again.`,
    );
  io.out(
    size(proposed)
      ? `Next: review ${rel}/scan/${repo.id}.yaml, then atticus scan verify ${repo.id} --accept, and atticus scan.`
      : `Next: nothing to accept; see ${rel}/scan/${repo.id}.findings.md for what a reader must change.`,
  );
  return 0;
}

/** atticus scan verify <repo> --accept: merge the proposal's settings into org-pack/scan/<repo>.yaml. */
export async function scanVerifyAccept(
  root: string,
  target: string,
  o: { by: string; now?: Date },
  io: Output,
): Promise<number> {
  const repo = await repoFor(root, target);
  if (!repo) {
    io.err(
      `${target} isn't a cloned repo of the manifest or a folder; clone it with atticus workspace sync, or give its folder.`,
    );
    return 2;
  }
  const proposal = await readProposal(root, repo.id);
  if (!proposal) {
    io.err(`There is no proposal for ${repo.id} yet: run atticus scan verify ${repo.id} first.`);
    return 1;
  }
  if (size(proposal.settings) === 0) {
    io.out(`Nothing to accept for ${repo.id}: the proposal has no settings entries.`);
    return 0;
  }
  const file = join(orgPackDirOf(root), "scan", `${repo.id}.yaml`);
  const text = await readFile(file, "utf8").catch(() => undefined);
  const have = text
    ? ScanSettings.parse(parse(text))
    : ScanSettings.parse({ schemaVersion: 1, repo: repo.id });
  const added = newEntries(have, proposal.settings);
  const next = ScanSettings.parse({ ...have, ...merge(have, added) });
  // The entries are checked again against the code as it is now.
  const checked = await checkScanSettings(next, fsRepo(repo.id, repo.dir, "0".repeat(40)));
  if (checked.problems.length) {
    io.err(`The settings no longer check out against the code, so nothing was merged:`);
    for (const p of checked.problems) io.err(`  - ${p}`);
    return 1;
  }
  const now = o.now ?? new Date();
  await mkdir(join(orgPackDirOf(root), "scan"), { recursive: true });
  await writeFile(
    file,
    `# Scan settings for ${repo.id} (ADR 0075); entries accepted from atticus scan verify on ${now.toISOString().slice(0, 10)} by ${o.by} (ADR 0082). Review it like any org-pack change.\n${stringify(next)}`,
    "utf8",
  );
  await writeProposal(root, {
    ...proposal,
    settings: EMPTY,
    accepted: { at: now.toISOString(), by: o.by, entries: size(added) },
  });
  io.out(
    `Merged ${plural(size(added), "entry", "entries")} into org-pack/scan/${repo.id}.yaml${size(added) ? `: ${describeSettings(added)}` : ""}. Review it in a pull request, then run atticus scan.`,
  );
  return 0;
}
