import { resolve, join } from "node:path";
import { catalogDirOf, type CatalogRecord } from "@maycombhq/core";
import { changeStore } from "@maycombhq/changes";
import { readCatalog } from "@maycombhq/scanner";
import { buildSite, systemGuide, type GuideChange } from "@maycombhq/site";
import type { Output } from "./commands.js";

/** Generated records, with a curated record of the same kind and id taking its place. */
export async function catalogRecords(root: string, io?: Output): Promise<CatalogRecord[]> {
  const dir = catalogDirOf(root);
  const gen = await readCatalog(join(dir, "generated"));
  const cur = await readCatalog(join(dir, "curated"));
  for (const p of [...gen.problems, ...cur.problems]) io?.err(`catalog ${p.file}: ${p.message}`);
  const curated = new Set(cur.records.map((r) => `${r.kind}/${r.id}`));
  return [...gen.records.filter((r) => !curated.has(`${r.kind}/${r.id}`)), ...cur.records];
}

/** Open changes with the systems they touch, for "Changes touching it". */
export async function openChanges(root: string): Promise<GuideChange[]> {
  try {
    return (await changeStore(root).list())
      .filter((c) => !["archived", "released", "abandoned"].includes(c.state))
      .map((c) => ({ id: c.id, title: c.title, state: c.state, systems: c.systems }));
  } catch {
    return [];
  }
}

/** atticus guide <system> [--json]: the system's guide, generated from the catalog. */
export async function guideCommand(
  root: string,
  system: string | undefined,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  if (!system) {
    io.err("guide needs a system id, for example: atticus guide ledger");
    return 2;
  }
  const records = await catalogRecords(root, io);
  let g;
  try {
    g = systemGuide(records, system, { changes: await openChanges(root) });
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (o.json) io.out(JSON.stringify(g, null, 2));
  else for (const l of g.markdown.split("\n")) io.out(l);
  return 0;
}

/** atticus site build <dir> [--title t]: the read-only catalog site as static files. */
export async function siteBuildCommand(
  root: string,
  dir: string | undefined,
  o: { title?: string; now?: Date },
  io: Output,
): Promise<number> {
  if (!dir) {
    io.err("site build needs a folder, for example: atticus site build ./site");
    return 2;
  }
  const out = resolve(dir);
  const r = await buildSite(await catalogRecords(root, io), out, {
    title: o.title ?? "Catalog",
    builtAt: (o.now ?? new Date()).toISOString().slice(0, 10),
    changes: await openChanges(root),
  });
  io.out(
    `Wrote the catalog site to ${out}: ${r.systems.length} system${r.systems.length === 1 ? "" : "s"}, ${r.files} files.`,
  );
  if (r.hidden.length)
    io.out(
      `Left out ${r.hidden.length} system${r.hidden.length === 1 ? "" : "s"} not open to everyone (their accessGroup); they aren't named anywhere on the site.`,
    );
  io.out("It is read-only static files: host it behind your own sign-in.");
  return 0;
}
