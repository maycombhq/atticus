import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ChangeLifecycle, loadOrgPack, type CatalogRecord } from "@maycombhq/core";
import {
  changeFootprint,
  changeStore,
  loadChangeContext,
  type ChangeConflict,
  type ChangeContext,
} from "@maycombhq/changes";
import { readCatalog } from "@maycombhq/scanner";
import { isDir } from "./files.js";
import { readLayout, resolveMetarepo, type MetarepoPaths } from "./layout.js";

/**
 * Federation: another Atticus metarepo absorbed in `link` mode. Its catalog joins every scan
 * (see `scanEstate`'s `federated` option); its open changes are read here, read-only, so a
 * change of ours that touches what one of theirs touches shows up as a conflict. Nothing of
 * theirs is ever written.
 */

export interface FederatedSource {
  id: string;
  dir: string;
}

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP = /^[^/\\]+@[^:/\\]+:/;

/** The federated metarepos on this machine: local folders, or absorb's copies under absorbed/. */
export async function federatedSources(
  root: string,
  paths?: MetarepoPaths,
): Promise<FederatedSource[]> {
  const p = paths ?? (await resolveMetarepo(root));
  const op = await loadOrgPack(p.orgPackDir);
  const out: FederatedSource[] = [];
  for (const a of op.sources.absorbed) {
    if (a.format !== "atticus" || a.mode !== "link") continue;
    const local = a.url.startsWith("file://")
      ? fileURLToPath(a.url)
      : REMOTE.test(a.url) || SCP.test(a.url)
        ? undefined
        : isAbsolute(a.url)
          ? a.url
          : resolve(root, a.url);
    const copy = join(p.stateDir, "absorbed", a.id);
    if (local && (await isDir(local)) && !(await isDir(join(local, "objects"))))
      out.push({ id: a.id, dir: local });
    else if (await isDir(copy)) out.push({ id: a.id, dir: copy });
  }
  return out;
}

export interface FederatedChange {
  origin: string;
  change: ChangeLifecycle;
  /** The federated metarepo's root. */
  dir: string;
}

/** Open (not archived) changes of the federated metarepos, read-only. */
export async function federatedChanges(sources: FederatedSource[]): Promise<FederatedChange[]> {
  const out: FederatedChange[] = [];
  for (const s of sources) {
    const orgPack = (await isDir(join(s.dir, "org-pack")))
      ? join(s.dir, "org-pack")
      : join(s.dir, ".atticus", "org-pack");
    const layout = await readLayout(orgPack);
    const changes = join(s.dir, ...layout.openspec.split("/"), "changes");
    let names: string[];
    try {
      names = (await readdir(changes, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name !== "archive")
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const n of names) {
      let text: string;
      try {
        text = await readFile(join(changes, n, "change.yaml"), "utf8");
      } catch {
        continue;
      }
      const r = ChangeLifecycle.safeParse(parse(text));
      if (r.success && r.data.state !== "archived")
        out.push({ origin: s.id, change: r.data, dir: s.dir });
    }
  }
  return out;
}

const both = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

/**
 * Our open changes against theirs: pairs that touch the same systems, interfaces, data
 * stores, tables, records or repos. Their change ids are shown as `<origin>:<id>`.
 */
export async function federationConflicts(
  root: string,
  o: { sources?: FederatedSource[]; records?: CatalogRecord[]; paths?: MetarepoPaths } = {},
): Promise<ChangeConflict[]> {
  const p = o.paths ?? (await resolveMetarepo(root));
  const sources = o.sources ?? (await federatedSources(root, p));
  if (!sources.length) return [];
  const base = await loadChangeContext(root);
  const ctx: ChangeContext = {
    ...base,
    orgPack: await loadOrgPack(p.orgPackDir),
    records: o.records ?? (await readCatalog(join(p.catalogDir, "generated"))).records,
  };
  const ours = (await changeStore(root).list()).filter((c) => c.state !== "archived");
  const theirs = await federatedChanges(sources);
  const mine = await Promise.all(
    ours.map(async (c) => [c.id, await changeFootprint(ctx, c)] as const),
  );
  const out: ChangeConflict[] = [];
  for (const t of theirs) {
    // Their change folder is read from their metarepo; ids resolve against our merged catalog.
    const fp = await changeFootprint({ ...ctx, root: t.dir }, t.change);
    for (const [id, m] of mine) {
      const overlap = {
        systems: both(m.systems, fp.systems),
        interfaces: both(
          m.interfaces.map((x) => x.id),
          fp.interfaces.map((x) => x.id),
        ),
        dataStores: both(m.dataStores, fp.dataStores),
        tables: both(m.tables, fp.tables),
        records: both(m.records, fp.records),
        repos: both(m.repos, fp.repos),
        // Flows both change (ADR 0124 addendum B-change).
        flows: both(
          m.flows.filter((x) => x.change !== "read").map((x) => x.id),
          fp.flows.filter((x) => x.change !== "read").map((x) => x.id),
        ),
      };
      if (Object.values(overlap).some((v) => v.length > 0))
        out.push({ changes: [id, `${t.origin}:${t.change.id}`], overlap });
    }
  }
  return out.sort((a, b) => a.changes.join().localeCompare(b.changes.join()));
}
