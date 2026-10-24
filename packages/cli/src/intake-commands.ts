import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  inputsDirOf,
  loadOrgPack,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  orgPackDirOf,
} from "@maycombhq/core";
import {
  buildTriage,
  classify,
  scanInputs,
  TriageError,
  type IntakeDocument,
  type ScanInputsResult,
  type Triage,
} from "@maycombhq/intake";
import { readDrawio, reconcile } from "@maycombhq/reconcile";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/** The inbox relative to the root, with forward slashes: inputs/inbox, or .atticus/inputs/inbox when adopted. */
const inboxRelOf = (root: string) =>
  relative(root, join(inputsDirOf(root), "inbox"))
    .split(sep)
    .join("/");

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const rel = (root: string, p: string) => relative(root, p).split(sep).join("/");

/**
 * Copy files into inputs/inbox/ as they are, with no sorting (ADR 0122: the drop target for
 * general knowledge). A file already somewhere under inputs/ (same bytes), an empty file and a
 * name with a folder in it are refused; a name taken in the inbox gets -2, -3...
 */
export async function addToInbox(
  root: string,
  files: { name: string; bytes: Uint8Array }[],
): Promise<{
  added: { name: string; path: string; kind: string }[];
  refused: { name: string; why: string }[];
}> {
  const INBOX = inboxRelOf(root);
  const inbox = join(root, ...INBOX.split("/"));
  const known = new Map<string, string>();
  for (const f of await filesUnder(inputsDirOf(root)))
    known.set(sha256(new Uint8Array(await readFile(f))), rel(root, f));
  const added: { name: string; path: string; kind: string }[] = [];
  const refused: { name: string; why: string }[] = [];
  for (const { name, bytes } of files) {
    if (!name || /[\\/]/.test(name) || name === "." || name === "..") {
      refused.push({ name, why: "give a file name without a folder in it" });
      continue;
    }
    if (bytes.length === 0) {
      refused.push({ name, why: "it is empty" });
      continue;
    }
    const hash = sha256(bytes);
    const already = known.get(hash);
    if (already) {
      refused.push({ name, why: `it is already in inputs as ${already}` });
      continue;
    }
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    await mkdir(inbox, { recursive: true });
    const taken = new Set(await readdir(inbox));
    let target = name;
    for (let n = 2; taken.has(target); n++) target = `${stem}-${n}${ext}`;
    await writeFile(join(inbox, target), bytes);
    const path = `${INBOX}/${target}`;
    known.set(hash, path);
    added.push({ name, path, kind: classify(target, bytes).classification });
  }
  return { added, refused };
}

/**
 * atticus intake add <files...>: copy files into inputs/inbox/ as they are, with no sorting.
 * A file already somewhere under inputs/ (same bytes) is refused. Exit 0 when everything was
 * added, 1 when something was refused or unreadable, 2 when no file was named.
 */
export async function intakeAdd(root: string, files: string[], io: Output): Promise<number> {
  if (files.length === 0) {
    io.err("Name at least one file to add.");
    return 2;
  }
  let problems = false;
  let added = 0;
  const ALREADY = "it is already in inputs as ";
  // One at a time, in the order given, so each message names the file as it was typed.
  for (const f of files) {
    const src = resolve(f);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(src));
    } catch {
      io.err(`Can't read ${f}.`);
      problems = true;
      continue;
    }
    const r = await addToInbox(root, [{ name: basename(src), bytes }]);
    for (const x of r.refused) {
      io.err(
        x.why.startsWith(ALREADY)
          ? `${f} is already in inputs as ${x.why.slice(ALREADY.length)}; not copied.`
          : `${f} wasn't copied: ${x.why}.`,
      );
      problems = true;
    }
    for (const a of r.added) {
      const reading = a.kind === "document" || a.kind === "image" ? ", needs reading" : "";
      io.out(`Added ${a.path} (${a.kind}${reading}).`);
      added++;
    }
  }
  if (added > 0) io.out("Run atticus intake list to see what Atticus made of them.");
  return problems ? 1 : 0;
}

interface Context {
  op: Awaited<ReturnType<typeof loadOrgPack>>;
  records: CatalogRecord[];
  curated: CatalogRecord[];
  inputs: ScanInputsResult;
}

/** The org pack, the catalog (generated and curated) and the inputs, as every command sees them. */
async function context(root: string, io: Output): Promise<Context> {
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const catalogDir = join(root, op.sources.layout.catalog);
  const generated = await readCatalog(join(catalogDir, "generated"));
  const curated = await readCatalog(join(catalogDir, "curated"));
  for (const p of [...generated.problems, ...curated.problems])
    io.err(`catalog ${p.file}: ${p.message}`);
  const inputs = await scanInputs({
    root,
    orgPack: op,
    records: [...generated.records, ...curated.records],
    inputsDir: inputsDirOf(root),
  });
  return { op, records: generated.records, curated: curated.records, inputs };
}

const STATUS_WORDS: [IntakeDocument["status"], (n: number) => string][] = [
  ["read", (n) => `${n} read`],
  ["needs-reading", (n) => `${n} need${n === 1 ? "s" : ""} reading`],
  ["no-reader", (n) => `${n} with no reader yet`],
  ["unresolved", (n) => `${n} waiting for a system name`],
  ["duplicate", (n) => `${n} duplicate${n === 1 ? "" : "s"}`],
  ["superseded", (n) => `${n} older version${n === 1 ? "" : "s"}`],
  ["failed", (n) => `${n} failed`],
];

/** Version chains, oldest first: each file's supersededBy followed to the newest. */
function chains(docs: IntakeDocument[]): string[][] {
  const byId = new Map(docs.filter((d) => d.id).map((d) => [d.id!, d]));
  const replaced = new Set(docs.flatMap((d) => (d.supersededBy ? [d.supersededBy] : [])));
  const out: string[][] = [];
  for (const d of docs) {
    if (!d.supersededBy || (d.id && replaced.has(d.id))) continue;
    const chain = [d.path];
    const seen = new Set([d.id]);
    for (let next = byId.get(d.supersededBy); next && !seen.has(next.id);) {
      chain.push(next.path);
      seen.add(next.id);
      next = next.supersededBy ? byId.get(next.supersededBy) : undefined;
    }
    out.push(chain);
  }
  return out;
}

/**
 * atticus intake list: every file under inputs/ with what it is, what happened to it, the
 * systems it is about, version chains and problems. Exit 1 when there are problems.
 */
export async function intakeList(root: string, io: Output, o: { json?: boolean }): Promise<number> {
  const { inputs } = await context(root, io);
  const { documents, problems } = inputs;
  if (o.json) {
    io.out(JSON.stringify({ documents, chains: chains(documents), problems }, null, 2));
    return problems.length > 0 ? 1 : 0;
  }
  if (documents.length === 0) {
    io.out(
      "Nothing in inputs/ yet: drop files into inputs/inbox/, or run atticus intake add <files>.",
    );
    return problems.length > 0 ? 1 : 0;
  }
  for (const l of table(
    ["PATH", "TYPE", "STATUS", "SYSTEMS"],
    documents.map((d) => [
      d.path,
      d.classification,
      d.duplicateOf ? `duplicate of ${d.duplicateOf}` : d.status,
      d.systems.join(", "),
    ]),
  ))
    io.out(l);
  const ch = chains(documents);
  if (ch.length > 0) {
    io.out("Versions:");
    for (const c of ch) io.out(`  ${c.join(" → ")}`);
  }
  const counts = STATUS_WORDS.map(([s, words]) => {
    const n = documents.filter((d) => d.status === s).length;
    return n > 0 ? words(n) : "";
  }).filter(Boolean);
  io.out(`${documents.length} file${documents.length === 1 ? "" : "s"}: ${counts.join(", ")}.`);
  for (const p of problems) io.out(`  ! ${p.path}: ${p.message}`);
  return problems.length > 0 ? 1 : 0;
}

/** Triage over the inputs and every current draw.io diagram in them, reconciled with the catalog. */
async function triageOf(root: string, io: Output): Promise<Triage> {
  const { op, records, curated, inputs } = await context(root, io);
  if (records.length === 0 && inputs.documents.length > 0)
    io.err(
      "The catalog is empty: run atticus scan first, or most diagram edges will look unknown.",
    );
  const profile = op.profiles.find((p) => p.profile)?.profile;
  const all = [...records, ...curated];
  const reconcileItems = [];
  for (const d of inputs.documents.filter(
    (x) => x.classification === "diagram" && x.status === "read" && x.reader?.startsWith("drawio@"),
  )) {
    const xml = await readFile(join(root, ...d.path.split("/")), "utf8");
    reconcileItems.push({
      file: d.path,
      items: reconcile({
        diagram: readDrawio(xml, profile?.legend),
        file: d.path,
        records: all,
        systems: profile?.systems ?? [],
        patterns: op.patterns,
      }).items,
    });
  }
  return buildTriage({ records, inputs, decisions: curated, reconcileItems, ai: op.runtime.ai });
}

/**
 * atticus triage: what a person must decide (conflicts with code, unknown names, aliases to
 * confirm, edges read from images, unclear versions, diagram gaps, planned work), each with
 * numbered options. Exit 0 when there is nothing to decide, 1 when there is.
 */
export async function triageList(root: string, io: Output, o: { json?: boolean }): Promise<number> {
  const { items } = await triageOf(root, io);
  if (o.json) {
    io.out(JSON.stringify({ items }, null, 2));
    return items.length > 0 ? 1 : 0;
  }
  if (items.length === 0) {
    io.out("Nothing to triage.");
    return 0;
  }
  io.out(`${items.length} item${items.length === 1 ? "" : "s"} to decide.`);
  for (const i of items) {
    io.out("");
    io.out(`${i.id} (${i.kind})`);
    io.out(`  ${i.summary}`);
    const where = `${i.source.path}${i.source.line ? `:${i.source.line}` : ""}`;
    io.out(`  at ${where}${i.source.cell ? ` (cell ${i.source.cell})` : ""}`);
    i.options.forEach((opt, n) => io.out(`  ${n + 1}. ${opt.label}`));
    if (i.next) io.out(`  → ${i.next}`);
  }
  io.out("");
  io.out("Decide one with: atticus triage decide <item> <option>");
  return 1;
}

/**
 * atticus triage decide <item> <option> [--by] [--reason]: write the option's CuratedDecision
 * under catalog/curated. A person runs it, so it is the human approval the decision needs.
 * Exit 1 for an unknown item, 2 for an option that isn't on the list.
 */
export async function triageDecide(
  root: string,
  itemId: string,
  option: number,
  o: { by?: string; reason?: string },
  io: Output,
): Promise<number> {
  const t = await triageOf(root, io);
  const item = t.items.find((i) => i.id === itemId);
  if (!item) {
    io.err(`There is no open triage item ${itemId}. List them with: atticus triage`);
    return 1;
  }
  if (!Number.isInteger(option) || option < 1 || option > item.options.length) {
    const n = item.options.length;
    io.err(`${itemId} has ${n} option${n === 1 ? "" : "s"}; pick 1 to ${n}.`);
    return 2;
  }
  let decision;
  try {
    decision = t.decide(itemId, option - 1, {
      by: o.by ?? userInfo().username,
      ...(o.reason ? { reason: o.reason } : {}),
    });
  } catch (e) {
    if (e instanceof TriageError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const relPath = `${op.sources.layout.catalog}/curated/${recordPath(decision)}`;
  const full = join(root, ...relPath.split("/"));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, serializeRecord(decision), "utf8");
  io.out(
    `Wrote ${relPath}: ${item.options[option - 1]!.label}. Commit it so everyone's triage uses it.`,
  );
  return 0;
}
