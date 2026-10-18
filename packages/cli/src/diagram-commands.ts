import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadOrgPack, type CatalogRecord, orgPackDirOf } from "@maycombhq/core";
import {
  buildView,
  shapeLibrary,
  toDrawio,
  toMermaid,
  viewFromDiagram,
  ViewError,
  VIEW_NAMES,
  type ViewName,
} from "@maycombhq/diagrams";
import { readDrawio } from "@maycombhq/reconcile";
import { readCatalog } from "@maycombhq/scanner";
import type { Output } from "./commands.js";

/** The catalog (generated and curated records) and the profile's legend words. */
export async function loadCatalog(
  root: string,
  io: Output,
): Promise<{
  records: CatalogRecord[];
  generated: number;
  legend?: Parameters<typeof readDrawio>[1];
}> {
  const op = await loadOrgPack(join(orgPackDirOf(root)));
  const catalogDir = join(root, op.sources.layout.catalog);
  const generated = await readCatalog(join(catalogDir, "generated"));
  const curated = await readCatalog(join(catalogDir, "curated"));
  for (const p of [...generated.problems, ...curated.problems])
    io.err(`catalog ${p.file}: ${p.message}`);
  const legend = op.profiles[0]?.profile?.legend;
  return {
    records: [...generated.records, ...curated.records],
    generated: generated.records.length,
    ...(legend ? { legend } : {}),
  };
}

async function emit(root: string, text: string, out: string | undefined, io: Output) {
  if (!out) {
    io.out(text.replace(/\n$/, ""));
    return;
  }
  const full = resolve(root, out);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text, "utf8");
  io.out(`Wrote ${relative(root, full).split(sep).join("/")}.`);
}

/**
 * atticus diagram render <view|file>: draw a catalog view (context, container, data, event,
 * sequence) as Mermaid or draw.io, or show a .drawio file as Mermaid. Exit 0 drawn, 1 when the
 * catalog can't answer (empty, unknown focus), 2 for a usage mistake.
 */
export async function diagramRender(
  root: string,
  o: { view: string; focus?: string; format?: string; out?: string },
  io: Output,
): Promise<number> {
  const format = o.format ?? "mermaid";
  if (format !== "mermaid" && format !== "drawio") {
    io.err(`Unknown format "${format}": use mermaid or drawio.`);
    return 2;
  }
  if (/\.drawio(\.xml)?$/i.test(o.view)) {
    if (format !== "mermaid") {
      io.err("A diagram file renders as Mermaid only.");
      return 2;
    }
    const full = resolve(root, o.view);
    let xml: string;
    try {
      xml = await readFile(full, "utf8");
    } catch {
      io.err(`Can't read ${o.view}`);
      return 2;
    }
    const op = await loadOrgPack(join(orgPackDirOf(root)));
    const diagram = readDrawio(xml, op.profiles[0]?.profile?.legend);
    for (const p of diagram.problems) io.err(`cell ${p.cell}: ${p.message}`);
    const view = viewFromDiagram(diagram, relative(root, full).split(sep).join("/"));
    await emit(root, toMermaid(view), o.out, io);
    return 0;
  }
  if (!VIEW_NAMES.includes(o.view as ViewName)) {
    io.err(
      `Unknown view "${o.view}": use ${VIEW_NAMES.join(", ")}, or name a .drawio file to show it as Mermaid.`,
    );
    return 2;
  }
  const name = o.view as ViewName;
  if ((name === "container" || name === "sequence") && !o.focus) {
    io.err(
      name === "container"
        ? "A container view needs a system: --focus <system>."
        : "A sequence view needs record ids in order: --focus <id>,<id>,...",
    );
    return 2;
  }
  if (name === "sequence" && format === "drawio") {
    io.err("A sequence view renders as Mermaid only.");
    return 2;
  }
  const { records, generated } = await loadCatalog(root, io);
  if (generated === 0) {
    io.err("The catalog is empty: run atticus scan first.");
    return 1;
  }
  let view;
  try {
    view = buildView(records, name, o.focus);
  } catch (e) {
    if (e instanceof ViewError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  if (view.type !== "sequence" && view.nodes.length === 0) {
    io.err(
      `Nothing to draw: the catalog has nothing for the ${name} view${o.focus ? ` of ${o.focus}` : ""}.`,
    );
    return 1;
  }
  await emit(
    root,
    view.type !== "sequence" && format === "drawio" ? toDrawio(view) : toMermaid(view),
    o.out,
    io,
  );
  return 0;
}

/** atticus diagram library <file>: write the draw.io shape library (system, component, ...). */
export async function diagramLibrary(out: string, io: Output): Promise<number> {
  const full = resolve(out);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, shapeLibrary(), "utf8");
  io.out(`Wrote ${out}. In draw.io, open it with File > Open Library from > Device.`);
  return 0;
}
