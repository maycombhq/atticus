import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { fileStepStore, stepOfProvisional } from "@maycombhq/adapters";
import {
  changeFolder,
  changeStore,
  loadChangeContext,
  type ChangePolicy,
} from "@maycombhq/changes";
import {
  inputsDirOf,
  type CatalogRecord,
  type ChangeLifecycle,
  type ChangeRepos,
  type Finding,
  type ManualStep,
  type OrgPack,
  type RecordOf,
} from "@maycombhq/core";
import { dayOf, leadTimeFor } from "@maycombhq/initiatives";
import { readServiceRequestExports, type ExportedServiceRequest } from "@maycombhq/intake";
import {
  readChangeFiles,
  readRound,
  readRoundMeta,
  readSnowDrafts,
  reviewedGates,
  roundsOf,
  type ChangeFiles,
  type RoundMeta,
} from "@maycombhq/naysayer";
import { SYNC_FILE } from "@maycombhq/planner";
import { readChangeRepos } from "@maycombhq/workspace";
import { ReleaseError } from "./errors.js";

/**
 * Everything the release views read, loaded once per view: the change, its folder's artifacts,
 * the catalog, the org pack, repos, manual steps, service requests and critic rounds. Files
 * only: no network, no AI. The views are computed from this on every read, so they never go
 * stale.
 */

/** The change folder's file of service-request drafts (the org-flow artifact, ADR 0029). */
export const REQUESTS_FILE = "snow.md";

export interface ServiceRequestView {
  heading: string;
  /** Line of the request's heading in the drafts file. */
  line: number;
  template?: string;
  requestType: string;
  /** The record the request is for: from the heading ("…: gw-x") or the template's ${record} field. */
  record: string;
  leadTimeDays?: number;
  /** Where the lead time came from, cited. */
  leadTimeSource?: string;
  approvers: string[];
  fields: { name: string; value: string; required: boolean }[];
  missing: string[];
  state: "to-file" | "waiting" | "filed";
  step?: string;
  number?: string;
  url?: string;
  /** When it was filed, if a person recorded it. */
  filedAt?: string;
  /** Task numbers the draft says it unblocks ("Unblocks task 1.3"). */
  unblocks: string[];
}

export interface RoundView {
  gate: string;
  round: number;
  meta?: RoundMeta;
  findings: { finding: Finding; path: string }[];
}

export interface Repo {
  id: string;
  type: string;
  component?: string;
  system?: string;
  owner: string;
}

export interface ReleaseContext {
  root: string;
  /** ISO timestamp the views are made at. */
  now: string;
  /** Its day (YYYY-MM-DD). */
  today: string;
  change: ChangeLifecycle;
  /** Absolute change folder. */
  dir: string;
  files: ChangeFiles;
  orgPack: OrgPack;
  policy: ChangePolicy;
  records: CatalogRecord[];
  get<K extends CatalogRecord["kind"]>(kind: K, id: string): RecordOf<K> | undefined;
  all<K extends CatalogRecord["kind"]>(kind: K): RecordOf<K>[];
  /** Every repo in the platform profiles' manifests. */
  repos: Repo[];
  changeRepos?: ChangeRepos;
  steps: ManualStep[];
  requests: ServiceRequestView[];
  /** Every critic round of every gate, oldest first per gate. */
  rounds: RoundView[];
  /** Findings of the newest round of each gate. */
  latest: { finding: Finding; path: string }[];
  exportedRequests: ExportedServiceRequest[];
  problems: string[];
}

const SyncEntries = z.object({
  requests: z.array(z.object({ key: z.string(), id: z.string() })).default([]),
});

type Template = OrgPack["serviceRequests"][number];

/** The drafts matched to the org pack's templates, with what was filed (sync.yaml, steps). */
export async function readServiceRequests(
  dir: string,
  files: ChangeFiles,
  templates: readonly Template[],
  steps: readonly ManualStep[],
  exported: readonly ExportedServiceRequest[],
): Promise<ServiceRequestView[]> {
  const drafts = readSnowDrafts(files);
  if (drafts.length === 0) return [];
  let synced: { key: string; id: string }[] = [];
  try {
    synced = SyncEntries.parse(parse(await readFile(join(dir, SYNC_FILE), "utf8"))).requests;
  } catch {
    // nothing filed yet
  }
  return drafts.map((d) => {
    const h = d.heading.toLowerCase();
    const t = templates.find((x) =>
      [x.requestType, x.name, x.id].some((n) => h.includes(n.toLowerCase())),
    );
    const fields = t
      ? t.fields.map((f) => ({
          name: f.name,
          value: d.fields.get(f.name.toLowerCase())?.value ?? "",
          required: f.required,
        }))
      : [...d.fields].map(([name, v]) => ({ name, value: v.value, required: false }));
    const fromHeading = /:\s*(\S+)\s*$/.exec(d.heading)?.[1] ?? "";
    const recordField = t?.fields.find((f) => f.from === "${record}");
    const record =
      fromHeading ||
      (recordField ? (d.fields.get(recordField.name.toLowerCase())?.value ?? "") : "");
    const unblocks = [...d.fields]
      .filter(([k]) => /^unblocks?\b/.test(k))
      .flatMap(([, v]) => v.value.match(/\d+(?:\.\d+)+|\b\d+\b/g) ?? []);
    const lead = t
      ? leadTimeFor(
          { id: t.id, kind: "request", template: t.id, days: t.leadTimeDays },
          undefined,
          { templates, requests: exported, journey: "change" },
        )
      : undefined;
    const base = {
      heading: d.heading,
      line: d.line,
      ...(t ? { template: t.id } : {}),
      requestType: t?.requestType ?? d.heading,
      record,
      ...(lead ? { leadTimeDays: lead.days, leadTimeSource: lead.source } : {}),
      approvers: t?.approvers ?? [],
      fields,
      missing: fields.filter((f) => f.required && !f.value.trim()).map((f) => f.name),
      unblocks,
    };
    const entry = t ? synced.find((e) => e.key === `${t.id}|${fromHeading}`) : undefined;
    if (!entry) return { ...base, state: "to-file" as const };
    const stepId = stepOfProvisional(entry.id);
    if (!stepId) return { ...base, state: "filed" as const, number: entry.id };
    const s = steps.find((x) => x.id === stepId);
    const v = s?.state === "done" ? s.recorded?.values : undefined;
    return typeof v?.requestNumber === "string"
      ? {
          ...base,
          state: "filed" as const,
          step: stepId,
          number: v.requestNumber,
          ...(typeof v.url === "string" ? { url: v.url } : {}),
          ...(s?.recorded ? { filedAt: s.recorded.at } : {}),
        }
      : { ...base, state: "waiting" as const, step: stepId };
  });
}

async function readRounds(root: string, change: string): Promise<RoundView[]> {
  const out: RoundView[] = [];
  for (const gate of await reviewedGates(root, change))
    for (const round of await roundsOf(root, change, gate)) {
      const meta = await readRoundMeta(root, change, gate, round);
      const r = await readRound(root, change, gate, round);
      out.push({ gate, round, ...(meta ? { meta } : {}), findings: r.findings });
    }
  return out;
}

export interface LoadOptions {
  now?: Date | string;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Load what the release views need. Throws ReleaseError("not-found") for an unknown change. */
export async function loadRelease(
  root: string,
  changeId: string,
  o: LoadOptions = {},
): Promise<ReleaseContext> {
  const now = typeof o.now === "string" ? o.now : iso(o.now ?? new Date());
  let change: ChangeLifecycle;
  try {
    change = await changeStore(root).read(changeId);
  } catch {
    throw new ReleaseError(`There is no change ${changeId}.`, "not-found");
  }
  const dir = changeFolder(root, change.id);
  const [ctx, files] = await Promise.all([loadChangeContext(root), readChangeFiles(dir)]);
  const problems = [...ctx.problems];
  // The generated catalog; the forecast reads curated initiatives through the initiatives package.
  const records = ctx.records;
  const key = (k: string, id: string) => `${k}|${id}`;
  const byKey = new Map(records.map((r) => [key(r.kind, r.id), r]));
  const repos: Repo[] = ctx.orgPack.profiles
    .flatMap((p) => p.repos?.repos ?? [])
    .map((r) => ({
      id: r.id,
      type: r.type,
      owner: r.owner,
      ...(r.component ? { component: r.component } : {}),
      ...(r.system ? { system: r.system } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let changeRepos: ChangeRepos | undefined;
  try {
    changeRepos = await readChangeRepos(root, change.id);
  } catch (e) {
    problems.push((e as Error).message);
  }
  let steps: ManualStep[] = [];
  try {
    steps = await fileStepStore(root).list({ change: change.id });
  } catch (e) {
    problems.push(`A step file can't be read: ${(e as Error).message}`);
  }
  const exported = await readServiceRequestExports({ root, inputsDir: inputsDirOf(root) });
  const requests = await readServiceRequests(
    dir,
    files,
    ctx.orgPack.serviceRequests,
    steps,
    exported.requests,
  );
  const rounds = await readRounds(root, change.id);
  const latest: RoundView["findings"] = [];
  for (const gate of [...new Set(rounds.map((r) => r.gate))]) {
    const last = rounds.filter((r) => r.gate === gate).at(-1);
    if (last) latest.push(...last.findings);
  }
  return {
    root,
    now,
    today: dayOf(now),
    change,
    dir,
    files,
    orgPack: ctx.orgPack,
    policy: ctx.policy,
    records,
    get: (kind, id) => byKey.get(key(kind, id)) as never,
    all: (kind) => records.filter((r) => r.kind === kind) as never,
    repos,
    ...(changeRepos ? { changeRepos } : {}),
    steps,
    requests,
    rounds,
    latest,
    exportedRequests: exported.requests,
    problems,
  };
}
