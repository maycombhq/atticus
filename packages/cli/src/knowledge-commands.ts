import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadOrgPack,
  Sources,
  type CatalogRecord,
  type OrgPack,
  orgPackDirOf,
} from "@maycombhq/core";
import {
  coverage,
  diffPatterns,
  knowledgeGaps,
  mapFacts,
  scanPatterns,
  syncSources,
  toApiCoverage,
  type PatternDraft,
} from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

const WIKI_TYPES = ["confluence", "ado-wiki", "sharepoint", "markdown-folder"] as const;
type WikiType = (typeof WIKI_TYPES)[number];

const toPosix = (p: string) => p.split(sep).join("/");
const isUrl = (s: string) => /^https?:\/\/[^\s/]+/i.test(s);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function load(root: string, io: Output) {
  const orgPackDir = join(orgPackDirOf(root));
  const op = await loadOrgPack(orgPackDir);
  for (const p of op.problems)
    io.err(`org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
  const catalogDir = join(root, op.sources.layout.catalog);
  const generated = await readCatalog(join(catalogDir, "generated"));
  const curated = await readCatalog(join(catalogDir, "curated"));
  for (const p of [...generated.problems, ...curated.problems])
    io.err(`catalog ${p.file}: ${p.message}`);
  const records: CatalogRecord[] = [...generated.records, ...curated.records];
  return { op, orgPackDir, records };
}

const systemsOf = (op: OrgPack) => op.profiles.flatMap((p) => p.profile?.systems ?? []);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * atticus sources add <type> <location>: check a wiki and print the sources.yaml lines to
 * add. It never writes the org pack: the org pack changes only through a reviewed PR.
 * A folder location is given relative to the metarepo root and printed relative to the
 * org-pack folder, which is how sources.yaml reads it.
 */
export async function sourcesAdd(
  root: string,
  kind: string,
  location: string,
  io: Output,
): Promise<number> {
  if (!(WIKI_TYPES as readonly string[]).includes(kind)) {
    io.err(`Unknown wiki type ${kind}. Use one of: ${WIKI_TYPES.join(", ")}.`);
    return 2;
  }
  const type = kind as WikiType;
  const orgPackDir = join(orgPackDirOf(root));
  const op = await loadOrgPack(orgPackDir);
  const folder = type === "markdown-folder" || (type !== "confluence" && !isUrl(location));
  let entryLocation: string;
  let id: string;
  if (folder) {
    const abs = isAbsolute(location) ? location : resolve(root, location);
    if (!(await isDir(abs))) {
      io.err(`Can't find the folder ${location} (paths are relative to ${root}).`);
      return 1;
    }
    entryLocation = toPosix(relative(orgPackDir, abs)) || ".";
    const same = op.sources.wikis.find(
      (w) => !isUrl(w.location) && resolve(orgPackDir, w.location) === abs,
    );
    if (same) {
      io.err(`That folder is already in sources.yaml as ${same.id}.`);
      return 1;
    }
    id = slug(basename(abs)) || "wiki";
  } else {
    if (!isUrl(location)) {
      io.err(`A ${type} wiki needs an https:// address; ${location} isn't one.`);
      return 1;
    }
    const same = op.sources.wikis.find((w) => w.location === location);
    if (same) {
      io.err(`That wiki is already in sources.yaml as ${same.id}.`);
      return 1;
    }
    entryLocation = location;
    id = slug(new URL(location).hostname) || "wiki";
  }
  const taken = new Set(op.sources.wikis.map((w) => w.id));
  let unique = id;
  for (let n = 2; taken.has(unique); n++) unique = `${id}-${n}`;
  const entry = { id: unique, type, location: entryLocation };
  const check = Sources.safeParse({ ...op.sources, wikis: [...op.sources.wikis, entry] });
  if (!check.success) {
    io.err(check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    return 1;
  }
  io.out(
    "Add this under wikis: in org-pack/sources.yaml through a pull request (Atticus never changes the org pack itself):",
  );
  io.out(
    `  - { id: ${entry.id}, type: ${entry.type}, location: ${JSON.stringify(entry.location)} }`,
  );
  return 0;
}

async function syncAll(root: string, io: Output) {
  const { op, orgPackDir, records } = await load(root, io);
  if (op.sources.wikis.length === 0) {
    io.err(
      "No wikis in org-pack/sources.yaml. Add one with: atticus sources add <type> <location>",
    );
    return undefined;
  }
  const sync = await syncSources({ root, orgPack: op, orgPackDir, records, now: now() });
  const facts = mapFacts({ pages: sync.pages, records, systems: systemsOf(op) });
  return { op, records, sync, facts };
}

/**
 * atticus sources sync: read every wiki (read-only), and compare what the pages say with the
 * catalog. Exit 0 when they agree, 1 when a source can't be read or a page conflicts with
 * code, 2 when no wiki is configured.
 */
export async function sourcesSync(
  root: string,
  io: Output,
  o: { json?: boolean },
): Promise<number> {
  const r = await syncAll(root, io);
  if (!r) return 2;
  const { sync, facts } = r;
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          classificationLimit: sync.classificationLimit,
          pages: sync.pages.map(({ doc: _doc, sections: _s, frontMatter: _f, ...p }) => p),
          documents: sync.documents,
          skipped: sync.skipped,
          problems: sync.problems,
          claims: facts.claims,
          documentConflicts: facts.documentConflicts,
          documentOnlyFacts: facts.documentOnlyFacts,
        },
        null,
        2,
      ),
    );
  } else {
    for (const w of r.op.sources.wikis) {
      const read = sync.pages.filter((p) => p.source === w.id).length;
      const skipped = sync.skipped.filter((p) => p.source === w.id).length;
      io.out(`${w.id}: ${read} page${read === 1 ? "" : "s"} read, ${skipped} skipped`);
      for (const p of sync.problems.filter((x) => x.source === w.id)) io.out(`  ! ${p.message}`);
    }
    for (const s of sync.skipped) io.out(`Skipped ${s.path}: ${s.reason}`);
    for (const p of sync.pages)
      for (const s of p.stale)
        io.out(
          s.reason === "too-old"
            ? `Stale ${p.path}: last updated ${p.date}, ${s.days} days ago (limit ${s.maxDays})`
            : `Stale ${p.path}: last updated ${p.date}, before code for ${s.system} was seen on ${s.codeAt.slice(0, 10)}`,
        );
    const n = facts.documentConflicts.length;
    if (n) {
      io.out(`${n} conflict${n === 1 ? "" : "s"} with code (code wins; each goes to triage):`);
      for (const c of facts.documentConflicts)
        io.out(`  ${c.doc}:${c.line} "${c.claim}": ${c.code}`);
    }
    const f = facts.documentOnlyFacts.length;
    if (f) {
      io.out(
        `${f} fact${f === 1 ? "" : "s"} only the wiki states, waiting for an owner to confirm:`,
      );
      for (const d of facts.documentOnlyFacts)
        io.out(`  ${d.system}: ${d.fact} (${d.doc}:${d.line})`);
    }
    if (!n && !f && !sync.problems.length) io.out("The wiki agrees with the catalog.");
  }
  return sync.problems.length || facts.documentConflicts.length ? 1 : 0;
}

/**
 * atticus patterns scan: read the pattern codes the wiki lists and compare them with the org
 * pack's patterns. Exit 0 when they match, 1 when a pattern is new, changed or missing,
 * 2 when no page lists pattern codes.
 */
export async function patternsScan(
  root: string,
  io: Output,
  o: { json?: boolean },
): Promise<number> {
  const r = await syncAll(root, io);
  if (!r) return 2;
  const drafts: PatternDraft[] = [];
  const pages: { path: string; codes: string[] }[] = [];
  for (const p of r.sync.pages) {
    const found = scanPatterns(p).filter((d) => !drafts.some((x) => x.code === d.code));
    if (!found.length) continue;
    drafts.push(...found);
    pages.push({ path: p.path, codes: found.map((d) => d.code) });
  }
  if (!drafts.length) {
    io.err("No wiki page lists integration pattern codes in a table.");
    return 2;
  }
  const diff = diffPatterns(drafts, r.op.patterns);
  const differs = diff.new.length + diff.changed.length + diff.missing.length > 0;
  if (o.json) io.out(JSON.stringify({ pages, drafts, diff }, null, 2));
  else {
    for (const p of pages) io.out(`${p.path}: ${p.codes.join(", ")}`);
    if (!differs) io.out(`The org pack matches the wiki: ${diff.same.length} patterns.`);
    for (const d of diff.new)
      io.out(
        `New on the wiki: ${d.code} (line ${d.line}); add org-pack/patterns/${d.code}.yaml in a PR`,
      );
    for (const c of diff.changed)
      for (const f of c.fields)
        io.out(
          `Changed: ${c.code} ${f.field}: wiki ${JSON.stringify(f.page)}, org pack ${JSON.stringify(f.pack)}`,
        );
    for (const m of diff.missing) io.out(`In the org pack but not on the wiki: ${m}`);
  }
  return differs ? 1 : 0;
}

/**
 * atticus coverage: per system and area, how much is verified from code, stated only by a
 * document, or unknown. Exit 2 when the catalog is empty.
 */
export async function coverageCommand(
  root: string,
  io: Output,
  o: { json?: boolean },
): Promise<number> {
  const { op, orgPackDir, records } = await load(root, io);
  if (records.length === 0) {
    io.err("The catalog is empty: run atticus scan first.");
    return 2;
  }
  let documents: CatalogRecord[] = [];
  if (op.sources.wikis.length) {
    const sync = await syncSources({ root, orgPack: op, orgPackDir, records, now: now() });
    documents = mapFacts({
      pages: sync.pages,
      records,
      systems: systemsOf(op),
    }).documentOnlyFacts.map((f) => f.record);
  }
  const res = coverage({ records, documents, orgPack: op, now: now() });
  if (o.json) {
    io.out(
      JSON.stringify({ systems: res.systems, areas: res.areas, api: toApiCoverage(res) }, null, 2),
    );
    return 0;
  }
  for (const l of table(
    ["SYSTEM", "VERIFIED", "DOCUMENT-ONLY", "UNKNOWN", "GAPS"],
    res.systems.map((s) => [
      s.system,
      String(s.verified),
      String(s.documentOnly),
      String(s.unknown),
      String(s.gaps),
    ]),
  ))
    io.out(l);
  io.out("");
  for (const l of table(
    ["AREA", "VERIFIED", "DOCUMENT-ONLY", "UNKNOWN", "EXPECTED"],
    res.areas.map((a) => [
      a.area,
      String(a.verified),
      String(a.documentOnly),
      String(a.unknown),
      String(a.expected),
    ]),
  ))
    io.out(l);
  io.out("Counts are areas. Document-only facts count once an owner confirms them.");
  return 0;
}

/**
 * atticus questions: the owner questions for knowledge gaps. It lists them; sending one goes
 * through the work tracker or notifier adapter, which asks a person to approve. Exit 0 when
 * there are none, 1 when questions are open, 2 when the catalog is empty.
 */
export async function questionsCommand(
  root: string,
  io: Output,
  o: { json?: boolean },
): Promise<number> {
  const { op, records } = await load(root, io);
  if (records.length === 0) {
    io.err("The catalog is empty: run atticus scan first.");
    return 2;
  }
  const gaps = knowledgeGaps({ records, orgPack: op, now: now() });
  if (o.json) io.out(JSON.stringify({ questions: gaps.map((g) => g.question), gaps }, null, 2));
  else {
    for (const g of gaps) {
      const q = g.question;
      io.out(
        `${q.id} → ${q.owner}${g.routeTo ? ` (route to the ${g.routeTo})` : ""} (${q.channel}, ${q.questionState})`,
      );
      io.out(`  ${q.question}`);
      io.out(`  Needs: ${q.neededFact}`);
      if (q.answer) io.out(`  Answer: ${q.answer} (record it in the catalog to close the gap)`);
    }
    io.out(
      gaps.length
        ? `${gaps.length} open question${gaps.length === 1 ? "" : "s"}. Unanswered questions stay unknowns; nothing is guessed.`
        : "No knowledge gaps.",
    );
  }
  return gaps.length ? 1 : 0;
}
