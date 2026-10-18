import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  ChangeTouches,
  openspecDirOf,
  RecordId,
  type ChangeLifecycle,
  type ChangeTouches as Touches,
} from "@maycombhq/core";
import type { OpenSpec } from "@maycombhq/openspec-adapter";
import type { z } from "zod";
import { changeTypeOf, loadChangeContext } from "./context.js";
import { ChangeError } from "./errors.js";
import { phaseState } from "./lifecycle.js";
import { changeFolder, changeStore, writeFileAtomic } from "./store.js";
import { pickTemplate, renderTemplate } from "./templates.js";

export interface NewChangeOptions {
  title: string;
  /** A change type id from change-types.yaml. */
  type: string;
  /** A change template id; defaults to the type's template. */
  template?: string;
  /** Who creates the change. */
  by: string;
  /** The change id; defaults to a slug of the title. */
  id?: string;
  /** People by role. The creator is the product owner when none is named and the type has Define. */
  owners?: Record<string, string[]>;
  systems?: string[];
  touches?: z.input<typeof ChangeTouches>;
  now?: string;
  /** Create the change through OpenSpec's CLI; without it the folder is written directly. */
  openspec?: OpenSpec;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const strip = (h: string) => (h.startsWith("@") ? h.slice(1) : h);

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The schema OpenSpec would use: the OpenSpec folder's config.yaml default, else spec-driven. */
async function defaultSchema(root: string): Promise<string> {
  try {
    const cfg = parse(await readFile(join(openspecDirOf(root), "config.yaml"), "utf8")) as {
      schema?: unknown;
    } | null;
    if (cfg && typeof cfg.schema === "string") return cfg.schema;
  } catch {
    // no config
  }
  return "spec-driven";
}

/**
 * Start a change: the OpenSpec change folder, brief.md from the change template, and
 * change.yaml moving from draft into the type's first phase (Define for most types; Build
 * for an emergency fix).
 */
export async function newChange(root: string, opts: NewChangeOptions): Promise<ChangeLifecycle> {
  const ctx = await loadChangeContext(root);
  const type = changeTypeOf(ctx, opts.type);
  const id = opts.id ?? slugify(opts.title);
  if (!RecordId.safeParse(id).success)
    throw new ChangeError(
      "invalid",
      `"${id}" can't be a change id; use a lowercase slug such as add-transfer-limit.`,
    );
  const template = pickTemplate(ctx.templates, type.id, opts.template);
  if (!template)
    throw new ChangeError(
      "invalid",
      `Unknown change template ${opts.template}. Use one of: ${ctx.templates.map((t) => t.id).join(", ")}.`,
    );
  const store = changeStore(root);
  if (await store.tryRead(id).catch(() => true))
    throw new ChangeError("conflict", `Change ${id} already exists.`);

  const now = opts.now ?? nowIso();
  const by = strip(opts.by);
  const dir = changeFolder(root, id);
  if (opts.openspec && !(await exists(join(dir, ".openspec.yaml")))) {
    await opts.openspec.newChange(id, { description: opts.title });
  } else {
    await mkdir(dir, { recursive: true });
    if (!(await exists(join(dir, ".openspec.yaml"))))
      await writeFile(
        join(dir, ".openspec.yaml"),
        `schema: ${await defaultSchema(root)}\ncreated: ${now.slice(0, 10)}\n`,
        "utf8",
      );
  }
  if (!(await exists(join(dir, "brief.md"))))
    await writeFileAtomic(
      join(dir, "brief.md"),
      renderTemplate(template, {
        title: opts.title,
        id,
        type: type.id,
        by,
        date: now.slice(0, 10),
      }),
    );

  const owners: Record<string, string[]> = {};
  for (const [role, people] of Object.entries(opts.owners ?? {}))
    if (people.length) owners[role] = [...new Set(people.map(strip))];
  if (!owners["product-owner"] && type.phases.includes("define")) owners["product-owner"] = [by];

  const first = phaseState(type.phases[0]!);
  const touches: Touches = ChangeTouches.parse(opts.touches ?? {});
  const change: ChangeLifecycle = {
    schemaVersion: 1,
    id,
    title: opts.title,
    type: type.id,
    template: template.id,
    state: first,
    owners,
    systems: [...new Set(opts.systems ?? [])].sort(),
    touches,
    authors: {},
    createdAt: now,
    createdBy: by,
    history: [
      { from: "draft", to: first, at: now, by, reason: `Created from the ${template.id} template` },
    ],
    handoffs: [],
  };
  await store.write(change);
  return change;
}
