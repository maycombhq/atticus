import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  fileJudgments,
  loadOrgPack,
  Sources,
  type CatalogRecord,
  type OrgPack,
  orgPackDirOf,
} from "@maycombhq/core";
import {
  coverage,
  diffPatterns,
  judgeFacts,
  knowledgeGaps,
  scanPatterns,
  syncSources,
  checkoutGitWiki,
  gitWikiAdapter,
  type GitCheckout,
  toApiCoverage,
  writeSnapshots,
  type PatternDraft,
} from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import { createGit } from "@maycombhq/workspace";
import { isSeq, parseDocument } from "yaml";
import type { Output } from "./commands.js";
import { judgingRuntime } from "./judging.js";
import { table } from "./index-commands.js";

const WIKI_TYPES = ["confluence", "ado-wiki", "sharepoint", "markdown-folder", "git"] as const;
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
 * add. With --save it writes them into sources.yaml (keeping its comments), as sources tag
 * does: the change is a file, committed through a pull request, which is the approval. A
 * folder (or a local git repository) is given relative to the metarepo root and written
 * relative to the org-pack folder, which is how sources.yaml reads it. A git wiki (ADR 0101)
 * takes --path (its pages' folder), --ref (a branch or tag) and --submodule.
 */
export interface SourceAddOptions {
  id?: string;
  path?: string;
  ref?: string;
  submodule?: boolean;
  kinds?: string[];
  frameworks?: string[];
  owner?: string;
  save?: boolean;
}

const isRemote = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

export async function sourcesAdd(
  root: string,
  kind: string,
  location: string,
  io: Output,
  o: SourceAddOptions = {},
): Promise<number> {
  if (!(WIKI_TYPES as readonly string[]).includes(kind)) {
    io.err(`Unknown wiki type ${kind}. Use one of: ${WIKI_TYPES.join(", ")}.`);
    return 2;
  }
  const type = kind as WikiType;
  if (type !== "git" && (o.path || o.ref || o.submodule)) {
    io.err("--path, --ref and --submodule are for a git wiki.");
    return 2;
  }
  const orgPackDir = join(orgPackDirOf(root));
  const op = await loadOrgPack(orgPackDir);
  let entryLocation: string;
  let id: string;
  if (type === "git") {
    if (isRemote(location)) {
      entryLocation = location;
    } else {
      const abs = isAbsolute(location) ? location : resolve(root, location);
      entryLocation = toPosix(relative(orgPackDir, abs)) || ".";
    }
    const same = op.sources.wikis.find(
      (w) =>
        w.location === entryLocation ||
        (!isRemote(w.location) &&
          !isRemote(entryLocation) &&
          resolve(orgPackDir, w.location) === resolve(orgPackDir, entryLocation)),
    );
    if (same) {
      io.err(`That repository is already in sources.yaml as ${same.id}.`);
      return 1;
    }
    const name = (
      location
        .replace(/[\\/]+$/, "")
        .split(/[\\/:]/)
        .pop() ?? ""
    )
      .replace(/\.git$/i, "")
      .replace(/\.wiki$/i, "");
    id = slug(name) || "wiki";
  } else {
    const folder = type === "markdown-folder" || (type !== "confluence" && !isUrl(location));
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
  }
  const taken = new Set(op.sources.wikis.map((w) => w.id));
  if (o.id && taken.has(o.id)) {
    io.err(`sources.yaml already has a source ${o.id}.`);
    return 1;
  }
  let unique = o.id ?? id;
  for (let n = 2; taken.has(unique); n++) unique = `${id}-${n}`;
  const tags =
    o.kinds?.length || o.frameworks?.length
      ? { kinds: o.kinds ?? [], frameworks: o.frameworks ?? [] }
      : undefined;
  const entry = {
    id: unique,
    type,
    location: entryLocation,
    ...(o.path ? { path: o.path } : {}),
    ...(o.ref ? { ref: o.ref } : {}),
    ...(type === "git" && o.submodule ? { checkout: "submodule" as const } : {}),
    ...(o.owner ? { owner: o.owner } : {}),
    ...(tags ? { tags } : {}),
  };
  const check = Sources.safeParse({ ...op.sources, wikis: [...op.sources.wikis, entry] });
  if (!check.success) {
    io.err(check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    return 1;
  }
  if (o.save) {
    const file = join(orgPackDir, "sources.yaml");
    const doc = parseDocument(
      await readFile(file, "utf8").catch(
        () => "# Where things are and what Atticus reads.\nschemaVersion: 1\n",
      ),
    );
    const wikis = doc.get("wikis");
    if (isSeq(wikis)) wikis.add(doc.createNode(entry));
    else doc.set("wikis", doc.createNode([entry]));
    await writeFile(file, doc.toString(), "utf8");
    io.out(
      `Added ${entry.id} (${type}) to org-pack/sources.yaml: commit it through a pull request.`,
    );
    io.out(
      `Then read it: atticus sources sync --source ${entry.id}, and atticus knowledge scan --source ${entry.id}.`,
    );
    return 0;
  }
  io.out(
    "Add this under wikis: in org-pack/sources.yaml through a pull request (or run this again with --save):",
  );
  const extra = [
    ...(entry.path ? [`path: ${entry.path}`] : []),
    ...(entry.ref ? [`ref: ${entry.ref}`] : []),
    ...("checkout" in entry && entry.checkout ? [`checkout: ${entry.checkout}`] : []),
  ];
  io.out(
    `  - { id: ${entry.id}, type: ${entry.type}, location: ${JSON.stringify(entry.location)}${extra.map((x) => `, ${x}`).join("")} }`,
  );
  return 0;
}

async function syncAll(root: string, io: Output, only?: string) {
  const loaded = await load(root, io);
  const { orgPackDir, records } = loaded;
  let op = loaded.op;
  if (op.sources.wikis.length === 0) {
    io.err(
      "No wikis in org-pack/sources.yaml. Add one with: atticus sources add <type> <location>",
    );
    return undefined;
  }
  if (only) {
    const wikis = op.sources.wikis.filter((w) => w.id === only);
    if (!wikis.length) {
      io.err(
        `There is no source ${only} in org-pack/sources.yaml (there is ${op.sources.wikis.map((w) => w.id).join(", ")}).`,
      );
      return undefined;
    }
    op = { ...op, sources: { ...op.sources, wikis } };
  }
  // ADR 0101: a git wiki is cloned (or its submodule updated) before its pages are read.
  const checkouts = new Map<string, GitCheckout>();
  const gitProblems: { source: string; message: string }[] = [];
  const git = createGit();
  for (const w of op.sources.wikis.filter((x) => x.type === "git"))
    try {
      checkouts.set(w.id, await checkoutGitWiki(root, w, orgPackDir, git));
    } catch (e) {
      gitProblems.push({
        source: w.id,
        message: `Can't fetch the git wiki ${w.id}: ${(e as Error).message.split("\n")[0]}`,
      });
    }
  const readable = {
    ...op,
    sources: {
      ...op.sources,
      wikis: op.sources.wikis.filter((w) => w.type !== "git" || checkouts.has(w.id)),
    },
  };
  const sync = await syncSources({
    root,
    orgPack: readable,
    orgPackDir,
    records,
    now: now(),
    adapters: { git: gitWikiAdapter(checkouts) },
  });
  sync.problems.push(...gitProblems);
  const runtime = await judgingRuntime(root);
  const facts = await judgeFacts(
    { pages: sync.pages, records, systems: systemsOf(op) },
    { ...(runtime ? { runtime } : {}), store: fileJudgments(root), now: new Date() },
  );
  return { op, records, sync, facts, checkouts };
}

/**
 * atticus sources sync: read every wiki (read-only), and compare what the pages say with the
 * catalog. Exit 0 when they agree, 1 when a source can't be read or a page conflicts with
 * code, 2 when no wiki is configured.
 */
export async function sourcesSync(
  root: string,
  io: Output,
  o: { json?: boolean; source?: string; now?: string },
): Promise<number> {
  const r = await syncAll(root, io, o.source);
  if (!r) return 2;
  const { sync, facts } = r;
  // ADR 0083: every page read is copied to a dated snapshot; the knowledge scan reads only those.
  const snapshots = await writeSnapshots({
    root,
    orgPack: r.op,
    sync,
    takenAt: o.now ?? now(),
    commits: Object.fromEntries([...r.checkouts].map(([id, c]) => [id, c.commit])),
  });
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          snapshots,
          classificationLimit: sync.classificationLimit,
          pages: sync.pages.map(
            ({ doc: _doc, sections: _s, frontMatter: _f, text: _t, ...p }) => p,
          ),
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
      const c = r.checkouts.get(w.id);
      if (c)
        io.out(
          `  ${c.submodule ? `Submodule ${c.submodule.path}` : "Cloned"} at commit ${c.commit.slice(0, 7)}${c.submodule?.moved ? `: the pin moved, commit ${c.submodule.path} to keep it` : ""}`,
        );
      const s = snapshots.find((x) => x.source === w.id);
      if (s) io.out(`  Snapshot: ${s.dir}/ (the knowledge scan reads this copy)`);
    }
    for (const s of sync.skipped) io.out(`Skipped ${s.path}: ${s.reason}`);
    // High-risk pages are problems (printed above); medium risk stays data, marked for a person.
    for (const p of sync.pages)
      if (p.defences?.risk === "medium")
        io.out(`Flagged ${p.path}: medium risk, ${p.defences.reason}`);
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
    // ADR 0117 addendum: how two systems reach each other is a judgment; without a model to ask
    // it, the sentences are for a person, not read by a word rule.
    const unjudged = facts.claims.filter((c) => c.status === "unjudged");
    if (unjudged.length) {
      io.out(
        `${unjudged.length} sentence${unjudged.length === 1 ? "" : "s"} may say how two systems reach each other, but no model was asked to judge ${unjudged.length === 1 ? "it" : "them"}; a person reads ${unjudged.length === 1 ? "it" : "them"}:`,
      );
      for (const c of unjudged) io.out(`  ${c.doc}:${c.line} ${c.from} → ${c.to}: "${c.claim}"`);
    }
    if (!n && !f && !unjudged.length && !sync.problems.length)
      io.out("The wiki agrees with the catalog.");
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
    const runtime = await judgingRuntime(root);
    documents = (
      await judgeFacts(
        { pages: sync.pages, records, systems: systemsOf(op) },
        { ...(runtime ? { runtime } : {}), store: fileJudgments(root), now: new Date() },
      )
    ).documentOnlyFacts.map((f) => f.record);
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
