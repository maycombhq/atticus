import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  CatalogBaseline,
  catalogDirOf,
  inputsDirOf,
  loadOrgPack,
  orgPackDirOf,
  WORKSPACE_SCHEMA_VERSION,
} from "@maycombhq/core";
import { buildSite } from "@maycombhq/site";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { catalogRecords, openChanges } from "./site-commands.js";
import { doctorChecks, type DoctorCheck } from "./doctor.js";

/**
 * Guided setup (ADR 0047): the checklist from install to an accepted catalog, each step with a
 * plain fix, and `atticus baseline`, the architect's acceptance of the as-is catalog. Until a
 * baseline exists, Home shows the checklist.
 */

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  detail: string;
  /** What to do when the step isn't done, in words a lead can follow. */
  fix?: string;
  optional?: boolean;
}

export const BASELINE_FILE = "baseline.yaml";

export async function readBaseline(root: string): Promise<CatalogBaseline | undefined> {
  try {
    const r = CatalogBaseline.safeParse(
      parse(await readFile(join(catalogDirOf(root), BASELINE_FILE), "utf8")),
    );
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    const all = await readdir(dir, { recursive: true, withFileTypes: true });
    return all.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

export async function setupSteps(
  root: string,
  o: { doctor?: DoctorCheck[] } = {},
): Promise<{ steps: SetupStep[]; baselined: boolean }> {
  const doctor = o.doctor ?? (await doctorChecks(root));
  const failing = doctor.filter((c) => c.status === "fail");
  const op = await loadOrgPack(orgPackDirOf(root));
  const repos = await loadRepos(root).catch(() => []);
  let cloned = 0;
  for (const r of repos)
    if (
      await stat(join(baseClonePath(root, r.id), ".git")).then(
        () => true,
        () => false,
      )
    )
      cloned += 1;
  const records = await catalogRecords(root);
  const generated = records.filter((r) => r.evidence.some((e) => e.source !== "manual")).length;
  const inputs = await countFiles(inputsDirOf(root));
  const wikis = op.sources.wikis.length;
  const baseline = await readBaseline(root);
  const steps: SetupStep[] = [
    {
      id: "machine",
      label: "This machine has what Atticus needs",
      done: failing.length === 0,
      detail: failing.length
        ? `to fix: ${failing.map((c) => c.label).join(", ")}`
        : `${doctor.filter((c) => c.status === "warn").length} to look at`,
      fix: failing.length
        ? `Run atticus doctor: ${failing.map((c) => c.fix ?? c.label).join(" ")}`
        : "Run atticus doctor for the details.",
    },
    {
      id: "org-pack",
      label: "The org pack is valid",
      done: op.problems.length === 0,
      detail: op.problems.length
        ? `${op.problems.length} problem${op.problems.length === 1 ? "" : "s"}`
        : "no problems",
      fix: "Run atticus orgpack validate and fix each problem it names (each says the file and field).",
    },
    {
      id: "repos",
      label: "Repos are listed",
      done: repos.length > 0,
      detail: `${repos.length} repo${repos.length === 1 ? "" : "s"} in the manifests`,
      fix: "Run atticus repos discover <folder> (or --org <org>) and add what it proposes to repos.manifest.yaml.",
    },
    {
      id: "clones",
      label: "Repos are cloned here",
      done: repos.length > 0 && cloned === repos.length,
      detail: `${cloned} of ${repos.length} cloned`,
      fix: "Run atticus workspace sync (or Sync repos on the Scans screen); it clones what's missing.",
    },
    {
      id: "scan",
      label: "The first scan is done",
      done: generated > 0,
      detail: `${records.length} records in the catalog`,
      fix: "Run atticus scan (or Scan now on the Scans screen). It reads files only: no network, no AI.",
    },
    {
      id: "roles",
      label: "Groups are mapped to roles",
      done: op.roles.mappings.length > 0,
      detail: `${op.roles.mappings.length} group mapping${op.roles.mappings.length === 1 ? "" : "s"}`,
      fix: "Map your directory or team groups to views in org-pack/roles.yaml (mappings), so each person starts in the right view.",
    },
    {
      id: "knowledge",
      label: "Existing knowledge is added",
      done: inputs > 0 || wikis > 0,
      detail: `${inputs} file${inputs === 1 ? "" : "s"} in inputs/, ${wikis} wiki source${wikis === 1 ? "" : "s"}`,
      fix: "Drop diagrams, partner specs and exports into inputs/ (atticus intake add <files>), and add wikis to sources.yaml (atticus sources add).",
      optional: true,
    },
    {
      id: "baseline",
      label: "The catalog is accepted",
      done: !!baseline,
      detail: baseline
        ? `accepted by ${baseline.acceptedBy} on ${baseline.acceptedAt.slice(0, 10)}`
        : "not yet",
      fix: "Walk the ecosystem map with the architect, then accept it: atticus baseline --by <you> (or Accept the catalog on Home).",
    },
  ];
  return { steps, baselined: !!baseline };
}

/** atticus setup [--json]: the checklist. Exit 0 when every required step is done, else 1. */
export async function setupCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const s = await setupSteps(root);
  const open = s.steps.filter((x) => !x.done && !x.optional);
  if (o.json) io.out(JSON.stringify(s, null, 2));
  else {
    for (const x of s.steps) {
      io.out(`${x.done ? "[x]" : "[ ]"} ${x.label}: ${x.detail}${x.optional ? " (optional)" : ""}`);
      if (!x.done && x.fix) io.out(`    ${x.fix}`);
    }
    io.out(
      open.length
        ? `${open.length} step${open.length === 1 ? "" : "s"} to go.`
        : "Setup is done: the catalog is accepted.",
    );
  }
  return open.length ? 1 : 0;
}

/** atticus baseline --by <you> [--note text] [--site dir]: accept the as-is catalog. */
export async function baselineCommand(
  root: string,
  o: { by?: string; note?: string; site?: string; now?: string },
  io: Output,
): Promise<number> {
  if (!o.by) {
    io.err("Usage: atticus baseline --by <you> [--note <text>] [--site <dir>]");
    return 2;
  }
  const records = await catalogRecords(root, io);
  if (records.length === 0) {
    io.err("The catalog is empty: scan first (atticus scan), then walk the map and accept it.");
    return 1;
  }
  const kinds: Record<string, number> = {};
  for (const r of records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const systems = records
    .filter((r) => r.kind === "System")
    .map((r) => r.id)
    .sort();
  const b = CatalogBaseline.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    acceptedBy: o.by,
    acceptedAt: o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
    systems,
    ...(o.note ? { note: o.note } : {}),
  });
  await writeFile(join(catalogDirOf(root), BASELINE_FILE), stringify(b), "utf8");
  io.out(
    `Accepted the catalog as the baseline: ${records.length} records in ${Object.keys(kinds).length} kinds, ${systems.length} systems. Wrote catalog/${BASELINE_FILE}; commit it with the catalog.`,
  );
  if (o.site) {
    const dir = resolve(o.site);
    const s = await buildSite(records, dir, {
      title: "Catalog",
      builtAt: b.acceptedAt.slice(0, 10),
      changes: await openChanges(root),
    });
    io.out(`Wrote the read-only catalog site to ${dir} (${s.systems.length} systems).`);
  }
  return 0;
}
