import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOTYPE_GROUPS,
  comparePrototype,
  factsDirOf,
  inputsDirOf,
  isPrototypeType,
  parseFacts,
  type FactEnd,
  type PrototypeCall,
  type PrototypeComparison,
  type PrototypeGroup,
  type PrototypeVendor,
  type RepoDescription,
} from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";
import { attachToChange, readChangeInputs, readVendorSpec } from "@maycombhq/intake";
import { estateFacts, estateRepos, joinReposOf, outsideSystems } from "@maycombhq/scanner";
import type { Output } from "./commands.js";
import { intakeContext } from "./intake-commands.js";

/**
 * ADR 0133: a prototype (a repo the manifest types `prototype`) compared with the estate, and the
 * comparison attached to a change: `atticus change attach <change> --prototype <repo>`. The words
 * a person reads are here and in core's PROTOTYPE_WORDS, so the command, the attached document
 * and the app say the same thing.
 */

export const PROTOTYPE_CLI_WORDS = {
  usage: (change: string, repo: string) =>
    `--prototype names a prototype repo, attached on its own: atticus change attach ${change} --prototype ${repo}`,
  noChange: (change: string) => `There is no change ${change}: atticus change list shows them.`,
  noRepo: (repo: string) =>
    `There is no repo ${repo} in the manifests (org-pack/profiles/<platform>/repos.manifest.yaml); atticus repo add adds one.`,
  notPrototype: (repo: string, type: string) =>
    `${repo} isn't a prototype: repos.manifest.yaml types it ${type}. A prototype is typed prototype there; then attach it.`,
  notRead: (repo: string) =>
    `${repo} has no verified facts yet: read it with /atticus-map ${repo}, then atticus verify ${repo}.`,
  about: (repo: string, about?: RepoDescription) =>
    `${repo} (a prototype)${about ? `: ${about.text}${about.trust === "suggested" ? " (a draft nobody has confirmed)" : ""}` : ": nothing says what it is yet (atticus repo describe)."}`,
  counts: (c: Record<PrototypeGroup, number>) => {
    const all = PROTOTYPE_GROUPS.reduce((n, g) => n + c[g], 0);
    return `${all} call${all === 1 ? "" : "s"} compared with the estate: ${c.exists} exist${c.exists === 1 ? "s" : ""}, ${c.changes} change${c.changes === 1 ? "s" : ""}, ${c.new} new, ${c.vendor} only a vendor provides.`;
  },
  group: {
    exists: "Exists: the estate serves it as the prototype needs.",
    changes: "Changes: the estate serves the operation, but not as the prototype needs.",
    new: "New: nothing in the estate serves it.",
    vendor: "Vendor: only a vendor provides it, so it needs a route through the external gateway.",
  } as Record<PrototypeGroup, string>,
  left: (n: number) =>
    `${n} call${n === 1 ? "" : "s"} of the prototype reach${n === 1 ? "es" : ""} nothing in it and ${n === 1 ? "isn't" : "aren't"} compared:`,
  attached: (path: string) =>
    `Attached as ${path}: the change's feature and architecture stages read it as data, citing it by line.`,
  unchanged: (path: string) =>
    `The comparison is what ${path} already says: nothing to attach again.`,
  footprint: (c: PrototypeComparison) => {
    const parts = [
      c.repos.length ? `repos ${c.repos.join(", ")}` : "",
      c.endpoints.length ? `Endpoints ${c.endpoints.join(", ")}` : "",
      c.vendorOperations.length ? `vendor operations ${c.vendorOperations.join(", ")}` : "",
    ].filter(Boolean);
    return parts.length
      ? `Its footprint now has ${parts.join("; ")}.`
      : "Its footprint is unchanged: every call exists as the prototype needs, or is new.";
  },
  docTitle: (repo: string) => `# What the prototype ${repo} asks of the estate`,
};

export interface LoadedPrototype {
  repo: string;
  about?: RepoDescription;
  comparison: PrototypeComparison;
  /** What the estate's facts or the vendors' specs left out, said once. */
  notes: string[];
  /** The repos' systems, for the change's footprint. */
  systemOf: Record<string, string>;
}

const SPECS = new Set(["openapi", "swagger"]);

/** The prototype compared with the estate's verified facts and the vendors' specs in inputs/. */
export async function loadPrototypeComparison(
  root: string,
  repo: string,
  io: Output,
): Promise<LoadedPrototype | { error: string }> {
  const { op, inputs } = await intakeContext(root, io);
  const manifest = estateRepos(op).find((r) => r.id === repo);
  if (!manifest) return { error: PROTOTYPE_CLI_WORDS.noRepo(repo) };
  if (!isPrototypeType(manifest.type))
    return { error: PROTOTYPE_CLI_WORDS.notPrototype(repo, manifest.type) };
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(() => "");
  const parsed = text.trim() ? parseFacts(text) : undefined;
  if (!parsed?.ok || !parsed.facts.length || parsed.facts.some((f) => f.verified === "none"))
    return { error: PROTOTYPE_CLI_WORDS.notRead(repo) };

  const estate = await estateFacts(root, op, repo);
  const systems = op.profiles.flatMap((p) => p.profile?.systems ?? []);
  const vendors: PrototypeVendor[] = [];
  for (const d of inputs.documents) {
    if (!d.id || d.supersededBy || !SPECS.has(d.classification)) continue;
    const system = systems.find((s) => s.id === d.systems[0] && s.boundary === "vendor");
    if (!system) continue;
    const body = await readFile(join(inputsDirOf(root), ...d.path.split("/").slice(1)), "utf8");
    const spec = readVendorSpec(d.path, body, system.id);
    if (!spec) continue;
    const prior = vendors.find((v) => v.system === system.id);
    const operations = spec.operations.map((o) => ({
      id: o.id,
      method: o.method,
      path: o.path,
      fullPath: o.fullPath,
      cite: o.cite,
      ...(o.auth ? { auth: o.auth } : {}),
      scopes: o.scopes,
      fields: [
        ...o.request.map((f) => ({ side: "request" as const, f })),
        ...o.response.map((f) => ({ side: "response" as const, f })),
      ].map(({ side, f }) => ({
        side,
        name: f.name,
        ...(f.type ? { type: f.type } : {}),
        ...(f.required !== undefined ? { required: f.required } : {}),
        at: f.cite,
      })),
    }));
    if (prior) {
      (prior.operations as typeof operations).push(...operations);
      (prior.hosts as string[]).push(...spec.hosts);
    } else
      vendors.push({
        system: system.id,
        names: [system.name, ...system.aliases],
        hosts: [...spec.hosts],
        operations,
      });
  }
  const comparison = comparePrototype({
    prototype: {
      repo,
      facts: parsed.facts,
      ...(manifest.component ? { component: manifest.component } : {}),
    },
    estate: joinReposOf(op, estate.repos),
    vendors,
    outside: outsideSystems(op),
  });
  return {
    repo,
    ...(manifest.description ? { about: manifest.description } : {}),
    comparison,
    notes: estate.notes,
    systemOf: Object.fromEntries(
      estateRepos(op).flatMap((r) => (r.system ? [[r.id, r.system] as const] : [])),
    ),
  };
}

const where = (e: FactEnd) => `${e.repo} ${e.at}`;

/** One call's lines: its sentence, where it is cited, and what differs. */
function callLines(c: PrototypeCall): string[] {
  const other = c.estate
    ? `; ${where(c.estate.entry)}`
    : c.vendor?.at
      ? `; ${c.vendor.name} ${c.vendor.at}`
      : "";
  return [
    `  ${c.sentence}`,
    `    ${c.call.repo} ${c.call.at} → ${c.lands.at}${other}`,
    ...(c.candidates ?? []).map((x) => `    ? ${where(x)}`),
    ...c.differences.map((d) => `    - ${d.message}`),
  ];
}

/** The comparison as lines a person reads; the same lines go into the attached document. */
export function prototypeLines(l: LoadedPrototype): string[] {
  const c = l.comparison;
  const out = [PROTOTYPE_CLI_WORDS.about(l.repo, l.about), PROTOTYPE_CLI_WORDS.counts(c.counts)];
  for (const g of PROTOTYPE_GROUPS) {
    const calls = c.calls.filter((x) => x.group === g);
    if (!calls.length) continue;
    out.push(PROTOTYPE_CLI_WORDS.group[g]);
    for (const x of calls) out.push(...callLines(x));
  }
  if (c.left.length) {
    out.push(PROTOTYPE_CLI_WORDS.left(c.left.length));
    for (const x of c.left) out.push(`  ${x.why} (${x.call.at})`);
  }
  out.push(...l.notes);
  return out;
}

/** The attached document's file name and text. */
export function prototypeDocument(l: LoadedPrototype): { name: string; text: string } {
  return {
    name: `prototype-${l.repo}.md`,
    text: [PROTOTYPE_CLI_WORDS.docTitle(l.repo), "", ...prototypeLines(l), ""].join("\n"),
  };
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The attached comparison's file name: prototype-<repo>.md, its repo. */
const ATTACHED = /^prototype-(.+)\.md$/;

/**
 * The prototypes attached to a change (the app's change page): each compared again from today's
 * facts, so the groups shown are the estate's as it is now; `problem` says why one can't be.
 */
export async function changePrototypes(
  root: string,
  change: string,
): Promise<{
  prototypes: {
    repo: string;
    attached: string;
    about?: { text: string; trust: "suggested" | "verified" };
    comparison?: PrototypeComparison;
    problem?: string;
  }[];
}> {
  const quiet: Output = { out: () => undefined, err: () => undefined };
  const files = (await readChangeInputs(changeFolder(root, change))).files
    .filter((f) => !f.supersededBy && ATTACHED.test(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const prototypes = [];
  for (const f of files) {
    const repo = ATTACHED.exec(f.name)![1]!;
    const got = await loadPrototypeComparison(root, repo, quiet);
    prototypes.push(
      "error" in got
        ? { repo, attached: f.path, problem: got.error }
        : {
            repo,
            attached: f.path,
            ...(got.about ? { about: { text: got.about.text, trust: got.about.trust } } : {}),
            comparison: got.comparison,
          },
    );
  }
  return { prototypes };
}

/**
 * atticus change attach <change> --prototype <repo> [--json]: the comparison attached to the
 * change (a newer one replaces the older), and the footprint it gives merged into change.yaml:
 * the repos that change or route, their systems and the vendor's, the Endpoints that change and
 * the vendor operations. Exit 0 attached (or unchanged), 1 refused.
 */
export async function attachPrototype(
  root: string,
  change: string,
  repo: string,
  o: { by: string; json?: boolean; now?: Date },
  io: Output,
): Promise<number> {
  const store = changeStore(root);
  const c = await store.read(change).catch(() => undefined);
  if (!c) {
    io.err(PROTOTYPE_CLI_WORDS.noChange(change));
    return 1;
  }
  const got = await loadPrototypeComparison(root, repo, io);
  if ("error" in got) {
    io.err(got.error);
    return 1;
  }
  const doc = prototypeDocument(got);
  const dir = changeFolder(root, c.id);
  const before = (await readChangeInputs(dir)).files.find(
    (f) => f.name === doc.name && !f.supersededBy,
  );
  const r = await attachToChange(
    dir,
    [{ name: doc.name, bytes: new TextEncoder().encode(doc.text) }],
    {
      by: o.by,
      at: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...(before ? { replaces: before.path } : {}),
    },
  );
  const added = r.added[0]?.path;
  const path = added ?? before?.path ?? `inputs/${doc.name}`;

  // The footprint (B-change's touches): what changes, what routes, and whose systems.
  const cmp = got.comparison;
  const fresh = await store.read(c.id);
  const touches = {
    ...fresh.touches,
    repos: sorted([...fresh.touches.repos, ...cmp.repos]),
    records: sorted([...fresh.touches.records, ...cmp.endpoints, ...cmp.vendorOperations]),
  };
  const systems = sorted([
    ...fresh.systems,
    ...cmp.vendors,
    ...cmp.repos.flatMap((x) => (got.systemOf[x] ? [got.systemOf[x]] : [])),
  ]);
  await store.write({ ...fresh, systems, touches });

  if (o.json) {
    io.out(
      JSON.stringify(
        {
          prototype: repo,
          ...(got.about ? { about: got.about } : {}),
          comparison: cmp,
          attached: path,
          touches: { repos: touches.repos, records: touches.records },
          systems,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const l of prototypeLines(got)) io.out(l);
  io.out(added ? PROTOTYPE_CLI_WORDS.attached(path) : PROTOTYPE_CLI_WORDS.unchanged(path));
  io.out(PROTOTYPE_CLI_WORDS.footprint(cmp));
  return 0;
}
