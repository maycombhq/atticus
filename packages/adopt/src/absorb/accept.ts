import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";
import { Sources } from "@maycombhq/core";
import { AdoptError } from "../errors.js";
import { readText, toPosix } from "../files.js";
import { resolveMetarepo, type MetarepoPaths } from "../layout.js";
import type { AbsorbedEntry } from "./absorb.js";
import type { Action } from "./types.js";

/**
 * `atticus absorb accept <id>`: the reviewed proposal of `atticus absorb` into the metarepo.
 * Every file an item marked adopt points at is copied where it belongs (`org-pack/…` into the
 * org pack, `openspec/…` into the metarepo's OpenSpec folder, `inputs/…` into inputs/); linked
 * items stay references, followed through the `absorbed` entry, which is added to
 * `sources.yaml`. A file already there with other content is kept unless `replace`. Nothing is
 * committed: the person opens a pull request with it, and merging it is the approval.
 */

export interface AcceptOptions {
  /** Overwrite files already in the metarepo with other content. */
  replace?: boolean;
  /** Say what would be copied; write nothing. */
  dryRun?: boolean;
}

export interface AcceptResult {
  id: string;
  /** The proposal folder, relative to the root. */
  proposal: string;
  /** Files copied (or, on a dry run, that would be), relative to the root. */
  copied: string[];
  /** Files already there with the same content. */
  same: string[];
  /** Files already there with other content, left as they are (no replace). */
  kept: string[];
  /** Items linked: followed through the absorbed entry, not copied. */
  linked: number;
  /** What happened to the absorbed entry in sources.yaml. */
  entry: "added" | "replaced" | "already";
  /** sources.yaml, relative to the root. */
  sourcesFile: string;
}

interface Inventory {
  entry: AbsorbedEntry;
  items: { action: Action; artifact?: string }[];
}

/** Where a proposal file goes in the metarepo, or undefined when it stays a reference. */
function targetOf(p: MetarepoPaths, file: string): string | undefined {
  const [head, ...rest] = file.split("/");
  const base =
    head === "org-pack"
      ? p.orgPackDir
      : head === "openspec"
        ? p.openspecDir
        : head === "inputs"
          ? p.inputsDir
          : undefined;
  return base && rest.length ? join(base, ...rest) : undefined;
}

export async function acceptAbsorbed(
  root: string,
  id: string,
  o: AcceptOptions = {},
  paths?: MetarepoPaths,
): Promise<AcceptResult> {
  const p = paths ?? (await resolveMetarepo(root));
  const dir = join(p.proposalsDir, "absorb", id);
  const text = await readText(join(dir, "inventory.json"));
  if (text === undefined)
    throw new AdoptError(
      "not-found",
      `There is no absorb proposal ${id}. Make it first: atticus absorb <git-url|folder> --id ${id}`,
    );
  const inv = JSON.parse(text) as Inventory;
  const rel = (f: string) => toPosix(relative(root, f));
  const out: AcceptResult = {
    id,
    proposal: rel(dir),
    copied: [],
    same: [],
    kept: [],
    linked: inv.items.filter((i) => i.action === "link").length,
    entry: "already",
    sourcesFile: rel(join(p.orgPackDir, "sources.yaml")),
  };

  const files = [
    ...new Set(inv.items.filter((i) => i.action === "adopt" && i.artifact).map((i) => i.artifact!)),
  ].sort();
  for (const f of files) {
    const to = targetOf(p, f);
    if (!to) continue;
    const from = join(dir, ...f.split("/"));
    const theirs = await readFile(from);
    const ours = await readFile(to).catch(() => undefined);
    if (ours && ours.equals(theirs)) {
      out.same.push(rel(to));
      continue;
    }
    if (ours && !o.replace) {
      out.kept.push(rel(to));
      continue;
    }
    out.copied.push(rel(to));
    if (!o.dryRun) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }

  // The absorbed entry, added to sources.yaml with its comments kept.
  const file = join(p.orgPackDir, "sources.yaml");
  const doc = parseDocument((await readText(file)) ?? "schemaVersion: 1\n");
  const list = doc.get("absorbed");
  const entries = isSeq(list) ? (list.toJSON() as AbsorbedEntry[]) : [];
  const at = entries.findIndex((e) => e.id === inv.entry.id);
  if (at < 0) {
    if (isSeq(list)) list.add(doc.createNode(inv.entry));
    else doc.set("absorbed", doc.createNode([inv.entry]));
    out.entry = "added";
  } else if (o.replace && JSON.stringify(entries[at]) !== JSON.stringify(inv.entry)) {
    doc.setIn(["absorbed", at], doc.createNode(inv.entry));
    out.entry = "replaced";
  }
  if (out.entry !== "already") {
    const checked = Sources.safeParse(doc.toJS());
    if (!checked.success)
      throw new AdoptError(
        "usage",
        `sources.yaml would not be valid with ${id}'s entry: ${checked.error.issues[0]?.message ?? "invalid"}`,
      );
    if (!o.dryRun) await writeFile(file, doc.toString());
  }
  return out;
}
