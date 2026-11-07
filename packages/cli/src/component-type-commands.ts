import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  Api,
  COMPONENT_TYPE_SCHEMA_VERSION,
  ComponentType,
  loadOrgPack,
  orgPackDirOf,
  orgPackRelOf,
  TYPE_SHAPES,
  writeFileAtomic,
  type LoadedComponentType,
} from "@maycombhq/core";
import type { Router, ServerContext } from "@maycombhq/server";
import type { Output } from "./commands.js";
import { componentTypesAt } from "./component-types.js";

/**
 * ADR 0180: the organisation's component types, listed, added and read from the command line
 * and the app. A type is a file an architect owns (org-pack/component-types/<id>/type.yaml, with
 * notes.md beside it), reviewed in a pull request like the rest of the org pack.
 */

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function componentTypeView(
  root: string,
  t: LoadedComponentType,
  pack: readonly LoadedComponentType[],
): Api.ComponentTypeViewT {
  const own = pack.find((p) => p.id === t.id);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    ...(t.owner ? { owner: t.owner } : {}),
    source: t.source,
    signals: t.signals.map((s) => ({
      kind: s.kind,
      value: s.value,
      ...(s.why ? { why: s.why } : {}),
    })),
    ...(t.runsOn ? { runsOn: t.runsOn } : {}),
    ...(t.draws ? { draws: t.draws } : {}),
    must: [...(t.must ?? [])],
    mustNot: [...(t.mustNot ?? [])],
    ...(t.notesText ? { notes: t.notesText } : {}),
    ...(own ? { file: `${orgPackRelOf(root)}/component-types/${t.id}/type.yaml` } : {}),
  };
}

export async function componentTypesView(root: string): Promise<Api.ComponentTypesViewT> {
  const op = await loadOrgPack(orgPackDirOf(root)).catch(() => undefined);
  const types = await componentTypesAt(root, op);
  return {
    types: types.map((t) => componentTypeView(root, t, op?.componentTypes ?? [])),
    folder: `${orgPackRelOf(root)}/component-types`,
  };
}

export function uiComponentTypeRoutes(r: Router, ctx: ServerContext): Router {
  return r.add("GET", "/api/component-types", async () => ({
    status: 200,
    body: await componentTypesView(ctx.root),
  }));
}

/** atticus types list [--json]. */
export async function typesListCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const v = await componentTypesView(root);
  if (o.json) {
    io.out(JSON.stringify(v, null, 2));
    return 0;
  }
  io.out(
    `${v.types.length} component types (${v.types.filter((t) => t.source === "org-pack").length} the organisation's own or reworded, in ${v.folder}/):`,
  );
  for (const t of v.types)
    io.out(
      `  ${t.id}${t.draws?.badge ? ` [${t.draws.badge}]` : ""}  ${t.name}: ${t.description}${t.source === "org-pack" ? "  (org pack)" : ""}${t.notes ? "  (notes)" : ""}`,
    );
  io.out(
    `Add one: atticus types add <id> --name "..." --description "..." [--badge xp] [--shape rounded] [--colour "#2bb3a3"]; its notes go in ${v.folder}/<id>/notes.md.`,
  );
  return 0;
}

/** atticus types add <id> --name --description [--badge] [--shape] [--colour] [--owner]. */
export async function typesAddCommand(
  root: string,
  id: string | undefined,
  o: {
    name?: string;
    description?: string;
    badge?: string;
    shape?: string;
    colour?: string;
    owner?: string;
  },
  io: Output,
): Promise<number> {
  if (!id || !o.name || !o.description) {
    io.err(
      'Usage: atticus types add <id> --name "..." --description "..." [--badge <1-3 chars>] [--shape box|rounded|hexagon|cylinder|diamond|parallelogram|circle] [--colour <css colour>] [--owner <team>]',
    );
    return 2;
  }
  if (!ID.test(id)) {
    io.err(`${id} isn't a type id: lower case letters, digits and - only.`);
    return 2;
  }
  if (o.shape && !(TYPE_SHAPES as readonly string[]).includes(o.shape)) {
    io.err(`--shape is one of ${TYPE_SHAPES.join(", ")}.`);
    return 2;
  }
  const dir = join(orgPackDirOf(root), "component-types", id);
  const file = join(dir, "type.yaml");
  const rel = `${orgPackRelOf(root)}/component-types/${id}`;
  if (existsSync(file)) {
    io.err(`${rel}/type.yaml is there already: edit it, or pick another id.`);
    return 2;
  }
  const draws = {
    ...(o.shape ? { shape: o.shape } : {}),
    ...(o.colour ? { colour: o.colour } : {}),
    ...(o.badge ? { badge: o.badge } : {}),
  };
  const type = ComponentType.safeParse({
    schemaVersion: COMPONENT_TYPE_SCHEMA_VERSION,
    id,
    name: o.name,
    description: o.description,
    ...(o.owner ? { owner: o.owner } : {}),
    signals: [],
    ...(Object.keys(draws).length ? { draws } : {}),
    notes: "notes.md",
  });
  if (!type.success) {
    io.err(type.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return 2;
  }
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(
    file,
    `# A component type of the organisation (ADR 0180): what a ${o.name} is, how a read recognises one (signals), how the canvas draws it, and what one must and must not do. Reviewed in a pull request like the rest of the org pack.\n${stringify(type.data, { lineWidth: 0 })}`,
  );
  const notes = join(dir, "notes.md");
  if (!existsSync(notes))
    await writeFileAtomic(
      notes,
      `# ${o.name}\n\n${o.description}\n\n## Conventions\n\n- (what every ${o.name} does the same way)\n\n## Review questions\n\n- (what a reviewer asks of one)\n`,
    );
  io.out(
    `Added ${rel}/type.yaml and ${rel}/notes.md. Fill in its signals (how a read recognises one) and its must / mustNot, write the notes, and review them in a pull request; the next atticus map --all hands the type to every read.`,
  );
  return 0;
}

/** atticus types notes <id>: the type's notes, or where to write them. */
export async function typesNotesCommand(
  root: string,
  id: string | undefined,
  io: Output,
): Promise<number> {
  if (!id) {
    io.err("Usage: atticus types notes <id>");
    return 2;
  }
  const types = await componentTypesAt(root);
  const t = types.find((x) => x.id === id);
  if (!t) {
    io.err(`No component type is ${id}. atticus types list shows them.`);
    return 2;
  }
  const rel = `${orgPackRelOf(root)}/component-types/${id}`;
  if (t.notesText) {
    io.out(t.notesText.trimEnd());
    return 0;
  }
  const file = join(orgPackDirOf(root), "component-types", id, "notes.md");
  const there = existsSync(file) ? await readFile(file, "utf8") : undefined;
  if (there) {
    io.out(there.trimEnd());
    return 0;
  }
  io.out(
    `${t.name} has no notes yet${t.source === "builtin" ? ` (an Atticus built-in: reword it in ${rel}/type.yaml to make it the organisation's)` : ""}. Write them in ${rel}/notes.md.`,
  );
  return 0;
}
