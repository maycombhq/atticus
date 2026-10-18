import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  AdapterError,
  type Approval,
  type ServiceDesk,
  type WorkItemType,
  type WorkTracker,
} from "@maycombhq/adapters";
import { writeFileAtomic } from "@maycombhq/changes";
import { toCanonicalYaml } from "@maycombhq/core";
import { readTasks } from "@maycombhq/naysayer";
import { loadPlanContext, type PlanContext } from "./context.js";
import { PlannerError } from "./errors.js";
import { readStories } from "./bar.js";
import { readDrafts } from "./snow.js";

/**
 * Work-tracker and service-desk sync. What Atticus wrote outside is remembered in the change's
 * `sync.yaml` (external id, a hash of what was sent), so a second run creates nothing twice:
 * unchanged items are left alone, changed ones are updated, and items no longer planned are
 * reported, never deleted. A dry run shows the diff first; every write then needs its own
 * approval, and the file is saved after each write so a crash can't duplicate an item. With
 * a manual adapter the ids are provisional (`manual:<step>`) until the person records them.
 */

export const SYNC_FILE = "sync.yaml";

const Entry = z.strictObject({
  key: z.string().min(1),
  type: z.string().min(1),
  id: z.string().min(1),
  hash: z.string().min(1),
  title: z.string().optional(),
  syncedAt: z.string().min(1),
});
export const SyncFile = z.strictObject({
  schemaVersion: z.literal(1),
  change: z.string().min(1),
  workItems: z.array(Entry).default([]),
  requests: z.array(Entry).default([]),
});
export type SyncFile = z.infer<typeof SyncFile>;

export async function readSyncFile(ctx: PlanContext): Promise<SyncFile> {
  try {
    return SyncFile.parse(parse(await readFile(join(ctx.dir, SYNC_FILE), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, change: ctx.change.id, workItems: [], requests: [] };
    throw new PlannerError(
      "invalid",
      `${SYNC_FILE} of ${ctx.change.id} can't be read: ${(e as Error).message}`,
    );
  }
}

async function saveSyncFile(ctx: PlanContext, f: SyncFile): Promise<void> {
  await writeFileAtomic(
    join(ctx.dir, SYNC_FILE),
    toCanonicalYaml(f, ["schemaVersion", "change", "key", "type", "id"]),
  );
}

const sha = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex").slice(0, 16);

export interface DesiredItem {
  key: string;
  type: WorkItemType;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** Key of the parent item. */
  parent?: string;
  tags: string[];
}

export interface PlannedWrite {
  key: string;
  type: string;
  action: "create" | "update" | "unchanged" | "orphaned";
  title: string;
  /** The external id, once known. */
  id?: string;
  changes?: string[];
}

export interface SyncResult {
  change: string;
  dryRun: boolean;
  writes: PlannedWrite[];
  done: { key: string; action: "create" | "update"; id: string }[];
  skipped: { key: string; reason: string }[];
  failed: { key: string; reason: string }[];
}

/** What the tracker should hold for this change: feature, stories, tasks (and an epic if asked). */
export async function desiredItems(
  ctx: PlanContext,
  o: { epic?: string | { title: string } } = {},
): Promise<DesiredItem[]> {
  const tag = (k: string) => `atticus:${ctx.change.id}:${k}`;
  const why = ctx.files.docs.get("proposal.md");
  const whyText = (() => {
    const s = why?.sections.find((x) => /^why$/i.test(x.heading));
    return s && why ? why.lines.slice(s.line, s.end).join("\n").trim() : "";
  })();
  const out: DesiredItem[] = [];
  if (o.epic && typeof o.epic === "object")
    out.push({
      key: "epic",
      type: "epic",
      title: o.epic.title,
      description: "",
      acceptanceCriteria: "",
      tags: ["atticus", tag("epic")],
    });
  out.push({
    key: "feature",
    type: "feature",
    title: ctx.change.title,
    description: [
      whyText,
      `Change ${ctx.change.id} in the metarepo: openspec/changes/${ctx.change.id}/.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    acceptanceCriteria: "",
    ...(o.epic && typeof o.epic === "object" ? { parent: "epic" } : {}),
    tags: ["atticus", tag("feature")],
  });
  for (const s of await readStories(ctx.dir)) {
    out.push({
      key: `story:${s.id}`,
      type: "story",
      title: s.title ?? s.id,
      description: s.who ? `As a ${s.who.asA} I want ${s.who.iWant} so that ${s.who.soThat}` : "",
      acceptanceCriteria: s.criteria.map((c) => `- ${c}`).join("\n"),
      parent: "feature",
      tags: ["atticus", tag(`story:${s.id}`), ...s.repos],
    });
  }
  const storyKeys = new Set(out.map((x) => x.key));
  for (const t of readTasks(ctx.files)) {
    const id = /^\s*[-*]\s+\[[ xX]?\]\s+(\S+)/.exec(t.text)?.[1] ?? String(t.line);
    const story = t.stories.find((s) => storyKeys.has(`story:${s}`));
    out.push({
      key: `task:${id}`,
      type: "task",
      title: `${t.repo}: ${t.text.replace(/^\s*[-*]\s+\[[ xX]?\]\s+\S+\s+/, "").replace(/\s*\(stor(?:y|ies)\b[^)]*\)\s*$/i, "")}`,
      description: `Build engine: ${ctx.engineOf(t.repo)}. Task ${id} of change ${ctx.change.id}.`,
      acceptanceCriteria: "",
      parent: story ? `story:${story}` : "feature",
      tags: ["atticus", tag(`task:${id}`), t.repo],
    });
  }
  return out;
}

const hashOf = (d: DesiredItem) =>
  sha({
    type: d.type,
    title: d.title,
    description: d.description,
    acceptanceCriteria: d.acceptanceCriteria,
    parent: d.parent ?? "",
  });

/** A tracker that can turn provisional (manual) ids into the ones a person recorded. */
type Resolving = WorkTracker & { resolveId?: (id: string) => Promise<string> };

export interface SyncWorkItemsOptions {
  workTracker: WorkTracker;
  /** Approve one write (each gets its own approval); undefined skips it. */
  approve?: (w: PlannedWrite) => Approval | undefined;
  dryRun?: boolean;
  /** An existing epic id to put the feature under, or an epic to create. */
  epic?: string | { title: string };
  now?: string;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export async function syncWorkItems(
  root: string,
  changeId: string,
  o: SyncWorkItemsOptions,
): Promise<SyncResult> {
  const ctx = await loadPlanContext(root, changeId, { requireApprovedDesign: false });
  const file = await readSyncFile(ctx);
  const wt = o.workTracker as Resolving;
  let resolved = false;
  if (wt.resolveId)
    for (const e of file.workItems) {
      const real = await wt.resolveId(e.id);
      if (real !== e.id) {
        e.id = real;
        resolved = true;
      }
    }
  if (resolved && !o.dryRun) await saveSyncFile(ctx, file);
  const desired = await desiredItems(ctx, o.epic ? { epic: o.epic } : {});
  const byKey = new Map(file.workItems.map((e) => [e.key, e]));
  const writes: PlannedWrite[] = desired.map((d) => {
    const e = byKey.get(d.key);
    if (!e) return { key: d.key, type: d.type, action: "create", title: d.title };
    if (e.hash === hashOf(d))
      return { key: d.key, type: d.type, action: "unchanged", title: d.title, id: e.id };
    return {
      key: d.key,
      type: d.type,
      action: "update",
      title: d.title,
      id: e.id,
      changes: ["title", "description", "acceptance criteria", "parent"],
    };
  });
  for (const e of file.workItems)
    if (!desired.some((d) => d.key === e.key))
      writes.push({
        key: e.key,
        type: e.type,
        action: "orphaned",
        title: e.title ?? e.key,
        id: e.id,
      });
  const result: SyncResult = {
    change: ctx.change.id,
    dryRun: !!o.dryRun,
    writes,
    done: [],
    skipped: [],
    failed: [],
  };
  if (o.dryRun) return result;

  const idOf = (key: string | undefined) => {
    if (!key) return undefined;
    if (key === "epic" && typeof o.epic === "string") return o.epic;
    return file.workItems.find((e) => e.key === key)?.id;
  };
  const featureParent = typeof o.epic === "string" ? o.epic : undefined;
  for (const d of desired) {
    const w = writes.find((x) => x.key === d.key)!;
    if (w.action === "unchanged") continue;
    const approval = o.approve?.(w);
    if (!approval) {
      result.skipped.push({ key: d.key, reason: "not approved" });
      continue;
    }
    const parent = d.key === "feature" && featureParent ? featureParent : idOf(d.parent);
    if (d.parent && !parent) {
      result.skipped.push({
        key: d.key,
        reason: `its parent ${d.parent} isn't in the tracker yet`,
      });
      continue;
    }
    const input = {
      type: d.type,
      title: d.title,
      description: d.description,
      acceptanceCriteria: d.acceptanceCriteria,
      ...(parent ? { parent } : {}),
      tags: d.tags,
    };
    try {
      const item =
        w.action === "create"
          ? await o.workTracker.createItem(input, approval)
          : await o.workTracker.updateItem(w.id!, input, approval);
      const entry = {
        key: d.key,
        type: d.type,
        id: item.id,
        hash: hashOf(d),
        title: d.title,
        syncedAt: o.now ?? nowIso(),
      };
      file.workItems = [...file.workItems.filter((e) => e.key !== d.key), entry];
      await saveSyncFile(ctx, file);
      result.done.push({ key: d.key, action: w.action as "create" | "update", id: item.id });
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      result.failed.push({ key: d.key, reason: e.message });
    }
  }
  return result;
}

// ------------------------------------------------------------------ service-desk requests

export interface SubmitRequestsOptions {
  serviceDesk: ServiceDesk;
  approve?: (w: PlannedWrite) => Approval | undefined;
  dryRun?: boolean;
  now?: string;
}

/**
 * Submit the drafts in snow.md (as a person filled them) through the service desk, one
 * approval per request, remembered in sync.yaml so none is filed twice. A draft with an empty
 * required field is refused by the desk and reported.
 */
export async function submitRequests(
  root: string,
  changeId: string,
  o: SubmitRequestsOptions,
): Promise<SyncResult> {
  const ctx = await loadPlanContext(root, changeId, { requireApprovedDesign: false });
  const file = await readSyncFile(ctx);
  const desk = o.serviceDesk as ServiceDesk & { resolveId?: (id: string) => Promise<string> };
  let resolved = false;
  if (desk.resolveId)
    for (const e of file.requests) {
      const real = await desk.resolveId(e.id);
      if (real !== e.id) {
        e.id = real;
        resolved = true;
      }
    }
  if (resolved && !o.dryRun) await saveSyncFile(ctx, file);
  const drafts = readDrafts(ctx);
  const writes: PlannedWrite[] = drafts.map((d) => {
    const key = `${d.template.id}|${d.record}`;
    const e = file.requests.find((x) => x.key === key);
    return e
      ? { key, type: d.template.id, action: "unchanged", title: d.heading, id: e.id }
      : { key, type: d.template.id, action: "create", title: d.heading };
  });
  const result: SyncResult = {
    change: ctx.change.id,
    dryRun: !!o.dryRun,
    writes,
    done: [],
    skipped: [],
    failed: [],
  };
  if (o.dryRun) return result;
  for (const d of drafts) {
    const w = writes.find((x) => x.key === `${d.template.id}|${d.record}`)!;
    if (w.action !== "create") continue;
    const approval = o.approve?.(w);
    if (!approval) {
      result.skipped.push({ key: w.key, reason: "not approved" });
      continue;
    }
    const empty = d.template.fields
      .filter((f) => f.required && !d.fields[f.name]?.trim())
      .map((f) => f.name);
    if (empty.length) {
      result.failed.push({ key: w.key, reason: `fill ${empty.join(", ")} in snow.md first` });
      continue;
    }
    try {
      const r = await o.serviceDesk.submitRequest(
        {
          templateId: d.template.id,
          type: d.template.requestType,
          changeId: ctx.change.id,
          fields: d.fields,
        },
        approval,
      );
      file.requests = [
        ...file.requests,
        {
          key: w.key,
          type: d.template.id,
          id: r.id,
          hash: sha(d.fields),
          title: d.heading,
          syncedAt: o.now ?? nowIso(),
        },
      ];
      await saveSyncFile(ctx, file);
      result.done.push({ key: w.key, action: "create", id: r.id });
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      result.failed.push({ key: w.key, reason: e.message });
    }
  }
  return result;
}
