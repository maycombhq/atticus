import { loadOrgPack, orgPackDirOf, orgPackRelOf } from "@maycombhq/core";
import {
  askLookup,
  mapFault,
  mapIdOf,
  receiversOfAll,
  severalNamed,
  type CatalogIndex,
} from "@maycombhq/index";
import { openIndex } from "@maycombhq/index";
import type { Output } from "./commands.js";
import { mapSides, NO_OWNER } from "./map-lacks.js";
import { table } from "./table.js";

/**
 * ADR 0207 part 2: two of the three map tools a persona asks beside conflicts, as commands.
 * `atticus owners <id>`: who owns a record, a repo or a system, and where that is said (the
 * catalog's System record, a profile, a manifest). `atticus impact <id> --receivers`: who uses
 * it (a topic's receivers; an API's or a component's callers). Files only: the catalog's index
 * and the org pack. Nothing is written and no model is called.
 */

/** Where an owner is said. */
export interface OwnerAnswer {
  id: string;
  /** The record's kind, or `repo` for a manifest's repo nobody read, or `system`. */
  kind: string;
  /** `<Kind>/<id>` of the record asked about, when the map has one. */
  record?: string;
  system?: string;
  /** Whether the map has a record for it. */
  read: boolean;
  owner?: string;
  from?: "catalog" | "profile" | "manifest";
  /** With `catalog`: the System record that names the owner. */
  says?: string;
  /** With `profile` or `manifest`: the org pack's file, relative to the metarepo. */
  file?: string;
}

interface Said {
  owner: string;
  from: "profile" | "manifest";
  file: string;
}

/** The owners the org pack names: each manifest repo's, and each system's (a profile's word first). */
async function orgPackOwners(root: string) {
  const repos = new Map<string, { said?: Said; system?: string }>();
  const systems = new Map<string, Said>();
  try {
    const rel = orgPackRelOf(root);
    const pack = await loadOrgPack(orgPackDirOf(root));
    for (const p of pack.profiles) {
      const manifest = `${rel}/profiles/${p.platform}/repos.manifest.yaml`;
      for (const r of p.repos?.repos ?? []) {
        const said = r.owner
          ? { owner: r.owner, from: "manifest" as const, file: manifest }
          : undefined;
        repos.set(r.id, { ...(said ? { said } : {}), ...(r.system ? { system: r.system } : {}) });
        if (said && r.system && !systems.has(r.system)) systems.set(r.system, said);
      }
    }
    // A profile's own word on a system's owner is the more exact one (mapSides).
    for (const p of pack.profiles)
      for (const s of p.profile?.systems ?? [])
        if (s.owner)
          systems.set(s.id, {
            owner: s.owner,
            from: "profile",
            file: `${rel}/profiles/${p.platform}/profile.yaml`,
          });
  } catch {
    // No org pack that reads: the catalog's own owners are all there is.
  }
  return { repos, systems };
}

async function withIx<T>(root: string, fn: (ix: CatalogIndex) => T | Promise<T>): Promise<T> {
  const ix = await openIndex(root);
  try {
    return await fn(ix);
  } finally {
    ix.close();
  }
}

/** The answer, or the sentence that says why there is none (exit 1). */
export async function ownerOf(
  root: string,
  id: string,
): Promise<OwnerAnswer | { refused: string }> {
  const [org, sides] = await Promise.all([orgPackOwners(root), mapSides(root)]);
  return withIx(root, (ix) => {
    const found = mapIdOf(ix, id, "records");
    if (found && "several" in found) return { refused: severalNamed(id, found.several) };
    if (!found) {
      // A repo the manifests list that nobody read is no record, and still has its owner.
      const repo = org.repos.get(id);
      if (repo && !mapFault(ix, root))
        return {
          id,
          kind: "repo",
          read: false,
          ...(repo.said ?? (repo.system ? org.systems.get(repo.system) : undefined) ?? {}),
        };
      return { refused: mapFault(ix, root) ?? sides.lacks(id, ix) };
    }
    const rec = ix.find(found.id)[0]!;
    const full = ix.get(rec.kind, rec.id) as
      { system?: string; repo?: string; owner?: string; component?: string } | undefined;
    // An entry, a table or a column says its component; the component says its system and repo.
    const comp = full?.component
      ? (ix.get("Component", full.component) as { system?: string; repo?: string } | undefined)
      : undefined;
    const system = rec.kind === "System" ? rec.id : (full?.system ?? comp?.system);
    const base: OwnerAnswer = {
      id: rec.id,
      kind: rec.kind,
      record: `${rec.kind}/${rec.id}`,
      ...(system && rec.kind !== "System" ? { system } : {}),
      read: true,
    };
    const sys = system ? (ix.get("System", system) as { owner?: string } | undefined) : undefined;
    if (sys?.owner) return { ...base, owner: sys.owner, from: "catalog", says: `System/${system}` };
    // The org pack: the system's owner, else the owner of the record's own repo, else of the
    // repo that is the record's id (mapSides.owner's order, with where it is said).
    const viaRepo = (r: string | undefined) => (r ? org.repos.get(r)?.said : undefined);
    const said =
      (system ? org.systems.get(system) : undefined) ??
      viaRepo(full?.repo) ??
      viaRepo(comp?.repo) ??
      viaRepo(rec.id);
    return said ? { ...base, ...said } : base;
  });
}

/** atticus owners <id> [--json]. Exit 1 only when the map has no such id (or couldn't be read). */
export async function ownersCommand(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const a = await ownerOf(root, id);
  if ("refused" in a) {
    io.err(a.refused);
    return 1;
  }
  if (o.json) {
    io.out(JSON.stringify(a, null, 2));
    return 0;
  }
  const what = a.read
    ? `${a.id} (${a.kind})`
    : `${a.id} (a repo in the manifest, not read: atticus map ${a.id})`;
  if (!a.owner) {
    io.out(
      `${what}: ${NO_OWNER}. Neither the catalog's system${a.system ? ` ${a.system}` : ""} nor a manifest or profile of the org pack names one.`,
    );
    return 0;
  }
  io.out(
    a.from === "catalog"
      ? `${what} is owned by ${a.owner}, as the catalog's ${a.says} says.`
      : a.from === "profile"
        ? `${what} is owned by ${a.owner}, as ${a.file} says of its system${a.system ? ` ${a.system}` : ""}.`
        : `${what} is owned by ${a.owner}, as ${a.file} says${a.read ? " of its repo" : ""}.`,
  );
  return 0;
}

/** One consumer: a component that receives a topic, or that calls an API or a component. */
export interface Consumer {
  kind: string;
  id: string;
  owner?: string;
  /** A caller: the Interface record that says so. */
  via?: string;
  why: string;
}

export interface ConsumersAnswer {
  /** What was asked about, as given. */
  id: string;
  kind: "topic" | "api" | "component" | "record";
  /** The map's records it is: the id, or a topic's Endpoint at each of its consumers. */
  records: string[];
  consumers: Consumer[];
  /** A topic: how many records a change reaches past its receivers (atticus impact lists them). */
  further?: number;
}

/**
 * atticus impact <id> --receivers [--json]: who uses it. A topic (by its id or its name, at every
 * one of its consumers): the components that receive it. An API: the components that call it.
 * A component (or its repo): the components that call it. Anything else: what receives it, as
 * the impact walk finds. Exit 1 when the map has no such id.
 */
export async function consumersCommand(
  root: string,
  id: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const sides = await mapSides(root);
  const r = await withIx(root, (ix): ConsumersAnswer | { refused: string } => {
    const hit = askLookup(ix)(id);
    const rec = hit && ix.find(hit.id)[0];
    if (!hit || !rec) {
      const found = mapIdOf(ix, id, "records");
      if (found && "several" in found) return { refused: severalNamed(id, found.several) };
      return { refused: mapFault(ix, root) ?? sides.lacks(id, ix) };
    }
    const ownerOfRec = (kind: string, x: string): string | undefined => {
      const full = ix.get(kind, x) as { system?: string } | undefined;
      const sys = full?.system
        ? (ix.get("System", full.system) as { owner?: string } | undefined)
        : undefined;
      return (
        sys?.owner ?? sides.owner({ kind, id: x, ...(full?.system ? { system: full.system } : {}) })
      );
    };
    const endpoint =
      rec.kind === "Endpoint"
        ? (ix.get("Endpoint", rec.id) as { endpointType?: string } | undefined)
        : undefined;
    if (endpoint?.endpointType === "event-topic") {
      const records = [rec.id, ...(hit.also ?? [])].sort();
      const walk = receiversOfAll(ix, records, 4, { owner: sides.owner });
      return {
        id,
        kind: "topic",
        records,
        consumers: walk.receivers.map((a) => ({
          kind: a.kind,
          id: a.id,
          ...(a.owner ? { owner: a.owner } : {}),
          why: a.reason,
        })),
        further: walk.further.length,
      };
    }
    if (rec.kind === "Endpoint" || rec.kind === "Component") {
      const rows = ix.query(
        `kind:interface ${rec.kind === "Endpoint" ? "endpoint" : "to"}:${rec.id}`,
        { limit: 500 },
      ).rows;
      const consumers: Consumer[] = [];
      for (const i of ix.records(rows) as { id: string; from?: string; name?: string }[]) {
        if (!i.from) continue;
        const owner = ownerOfRec("Component", i.from);
        consumers.push({
          kind: "Component",
          id: i.from,
          ...(owner ? { owner } : {}),
          via: i.id,
          why: `calls ${rec.id}${i.name ? ` (${i.name})` : ""}`,
        });
      }
      consumers.sort((a, b) => (a.id + a.via! < b.id + b.via! ? -1 : 1));
      return {
        id,
        kind: rec.kind === "Endpoint" ? "api" : "component",
        records: [rec.id],
        consumers,
      };
    }
    const walk = receiversOfAll(ix, [rec.id], 4, { owner: sides.owner });
    return {
      id,
      kind: "record",
      records: [rec.id],
      consumers: walk.receivers.map((a) => ({
        kind: a.kind,
        id: a.id,
        ...(a.owner ? { owner: a.owner } : {}),
        why: a.reason,
      })),
      further: walk.further.length,
    };
  });
  if ("refused" in r) {
    io.err(r.refused);
    return 1;
  }
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return 0;
  }
  const calls = r.kind === "api" || r.kind === "component";
  const n = calls ? new Set(r.consumers.map((c) => c.id)).size : r.consumers.length;
  if (!r.consumers.length) {
    io.out(`Nothing in the map ${calls ? "calls" : "receives"} ${r.id}.`);
    return 0;
  }
  io.out(
    calls
      ? `${r.id} is called by ${n} component${n === 1 ? "" : "s"}:`
      : `${r.id} is received by ${n} component${n === 1 ? "" : "s"}:`,
  );
  for (const l of table(
    calls ? ["KIND", "ID", "OWNER", "INTERFACE", "WHY"] : ["KIND", "ID", "OWNER", "WHY"],
    r.consumers.map((c) =>
      calls
        ? [c.kind, c.id, c.owner ?? NO_OWNER, c.via ?? "", c.why]
        : [c.kind, c.id, c.owner ?? NO_OWNER, c.why],
    ),
  ))
    io.out(`  ${l}`);
  if (r.further)
    io.out(
      `Further, through a receiver: ${r.further} record${r.further === 1 ? "" : "s"} (atticus impact ${r.records[0]} lists them).`,
    );
  return 0;
}
