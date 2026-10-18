import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeFolder, changeStore, loadChangeContext } from "@maycombhq/changes";
import {
  Finding,
  normalizePath,
  type CatalogRecord,
  type ChecklistRule,
  type RecordOf,
} from "@maycombhq/core";
import { readSpecKitFeatures, type SpecKitFeature } from "@maycombhq/extractors";
import {
  docOf,
  readChangeFiles,
  readDataChanges,
  readHops,
  type DataChange,
  type Hop,
} from "@maycombhq/naysayer";
import { fsRepo } from "@maycombhq/sdk";
import { loadRepos, readChangeRepos } from "@maycombhq/workspace";
import { readChangeTasks, SpecKitError, viaOf } from "./change.js";
import { loadDriftRules, writeFullRound, type RoundWrite } from "./rounds.js";
import { taskWorktreePath } from "./worktree.js";

/**
 * The three-way drift check (ADR 0030 point 4): the approved design (the OpenSpec change's
 * interfaces.md and data.md), the repo plans (Spec Kit features read by the speckit
 * extractor from the change's and its tasks' worktrees) and the code (the scanned catalog,
 * leaving out anything only a Spec Kit plan says).
 *
 * - plan vs design: a call to a system the design doesn't include, an interface or a table the
 *   design lacks (warnings to the architect), and a plan that uses a design element differently
 *   (blocking until the design is amended or the plan is fixed);
 * - plan vs code: an existing interface or column the plan describes differently, and, past
 *   build, what the plan adds that the code doesn't have;
 * - design vs code: the design changes an interface the code doesn't have, or, past build,
 *   plans what the code lacks or retires what it still has.
 *
 * Findings are C3 Findings under `review/drift/<round>/`, so the lifecycle and the critic read
 * them like any gate. Deterministic: files only, no AI, no network.
 */

export const DRIFT_GATE = "drift";
const PAST_BUILD = new Set(["qa", "release-ready", "released", "post-release-review"]);

export interface RepoPlan {
  repo: string;
  component: string;
  /** Worktree the feature was read from, relative to the metarepo. */
  from: string;
  feature: SpecKitFeature;
}

export interface DriftResult extends RoundWrite {
  change: string;
  plans: RepoPlan[];
  /** The findings this run found (before carrying states over). */
  found: Finding[];
}

type Rec = CatalogRecord & Record<string, unknown>;
const isPlanOnly = (r: CatalogRecord) =>
  r.evidence.length > 0 && r.evidence.every((e) => (e.extractor ?? "").startsWith("speckit@"));
const norm = (p: string | undefined) => normalizePath(p ?? "");
const typeKey = (t: string) => t.toLowerCase().replace(/\s+/g, "");
const topicOf = (op: string) => /^(publish|subscribe|send|receive)\s+(\S+)/i.exec(op.trim())?.[2];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Read every Spec Kit feature of this change: change worktrees, then task worktrees (newer). */
export async function readChangePlans(root: string, changeId: string): Promise<RepoPlan[]> {
  const repos = (await readChangeRepos(root, changeId))?.repos ?? [];
  if (repos.length === 0) return [];
  const manifest = new Map((await loadRepos(root)).map((r) => [r.id, r]));
  const files = await readChangeFiles(changeFolder(root, changeId));
  const tasks = readChangeTasks(files);
  const out = new Map<string, RepoPlan>();
  for (const r of repos) {
    const m = manifest.get(r.id);
    const component = m?.component ?? r.id;
    const mine = tasks.filter((t) => t.repo === r.id).map((t) => t.id);
    const dirs = [
      join(root, r.worktree),
      ...mine.map((t) => taskWorktreePath(root, changeId, t, r.id)),
    ].filter((d) => existsSync(d));
    for (const dir of dirs) {
      const features = await readSpecKitFeatures(fsRepo(r.id, dir, "0".repeat(40)), {
        component,
        ...(m?.system ? { system: m.system } : {}),
        dialects: [],
        scannedAt: "1970-01-01T00:00:00Z",
        warn: () => undefined,
      });
      for (const f of features)
        if (mine.includes(f.feature))
          out.set(`${r.id}/${f.feature}`, {
            repo: r.id,
            component,
            from: dir
              .slice(root.length + 1)
              .split("\\")
              .join("/"),
            feature: f,
          });
    }
  }
  return [...out.values()].sort((a, b) =>
    `${a.repo}/${a.feature.feature}`.localeCompare(`${b.repo}/${b.feature.feature}`),
  );
}

export async function driftCheck(
  root: string,
  changeId: string,
  o: { now?: string; write?: boolean } = {},
): Promise<DriftResult> {
  const now = o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ctx = await loadChangeContext(root);
  const change = await changeStore(root)
    .read(changeId)
    .catch((e: Error) => {
      throw new SpecKitError("not-found", e.message);
    });
  const rules = await loadDriftRules();
  const files = await readChangeFiles(changeFolder(root, change.id));
  const hops = readHops(files);
  const data = readDataChanges(files);
  const patterns = new Map(ctx.orgPack.patterns.map((p) => [p.code, p]));
  const plans = await readChangePlans(root, change.id);
  const code = ctx.records.filter(
    (r) => !isPlanOnly(r) && !r.status.startsWith("planned-"),
  ) as Rec[];
  const codeOf = <K extends CatalogRecord["kind"]>(k: K) =>
    code.filter((r) => r.kind === k) as unknown as (RecordOf<K> & Rec)[];
  const codeInterfaces = codeOf("Interface");
  const codeEndpoints = codeOf("Endpoint");
  const codeIds = new Set(code.map((r) => `${r.kind}/${r.id}`));
  const systemOf = (id: string) => {
    const c = code.find((r) => r.kind === "Component" && r.id === id) as
      RecordOf<"Component"> | undefined;
    return c?.system;
  };
  const designParties = new Set<string>([
    ...change.systems,
    ...hops.flatMap((h) => [h.caller, h.callee]),
  ]);
  const knownToDesign = (id: string) =>
    designParties.has(id) || (systemOf(id) !== undefined && designParties.has(systemOf(id)!));

  const found: Finding[] = [];
  const doc = (name: string) => docOf(files, name);
  const quote = (lines: string[] | undefined, n: number) => {
    const t = lines?.[n - 1]?.trim();
    return t ? (t.length <= 190 ? t : `${t.slice(0, 187)}...`) : undefined;
  };
  const planText = new Map<string, string[]>();
  for (const p of plans)
    for (const f of p.feature.files)
      planText.set(
        `${p.repo}/${f}`,
        (await readFile(join(root, p.from, f), "utf8")).replace(/\r\n/g, "\n").split("\n"),
      );
  const specEv = (p: RepoPlan, r: CatalogRecord) => {
    const e = r.evidence[0]!;
    const q = e.path && e.line ? quote(planText.get(`${p.repo}/${e.path}`), e.line) : undefined;
    return {
      source: "spec" as const,
      repo: p.repo,
      ...(e.path ? { path: e.path } : {}),
      ...(e.line ? { line: e.line } : {}),
      ...(q ? { quote: q } : {}),
    };
  };
  const artEv = (name: string, line: number) => {
    const q = quote(doc(name)?.rawLines, line);
    return { source: "artifact" as const, path: name, line, ...(q ? { quote: q } : {}) };
  };
  const add = (
    ruleId: string,
    subject: string,
    f: {
      artifact: string;
      locator: Finding["locator"];
      summary: string;
      evidence: Finding["evidence"];
    },
  ) => {
    const rule = rules.get(ruleId) as ChecklistRule;
    found.push(
      Finding.parse({
        schemaVersion: 1,
        id: `${ruleId.replace(/^drift\./, "")}-${slug(subject)}`.slice(0, 120),
        kind: "issue",
        change: change.id,
        gate: DRIFT_GATE,
        round: 1,
        rule: rule.id,
        layer: rule.layer,
        lens: rule.lens,
        severity: rule.severity,
        artifact: f.artifact,
        locator: f.locator,
        summary: f.summary,
        why: rule.description ?? rule.title,
        fix: {
          text:
            rule.lens === "architecture"
              ? "Amend the change's design through its hand-off, or change the repo plan back to the design."
              : "Check which is right, the plan or the code, and fix the other.",
        },
        evidence: f.evidence,
        waivable: false,
        state: "open",
        createdAt: now,
      }),
    );
  };

  const designHopFor = (
    from: string,
    to: string,
    method: string | undefined,
    path: string,
  ): Hop | undefined =>
    hops.find(
      (h) =>
        h.caller === from &&
        h.callee === to &&
        (method
          ? h.method === method && norm(h.path) === norm(path)
          : topicOf(h.operation) === path),
    );
  const designColumn = (
    table: string,
    column: string,
  ): { d: DataChange; type: string } | undefined => {
    for (const d of data)
      if (d.tableId === table)
        for (const c of d.newColumns)
          if (c.name.toLowerCase() === column.toLowerCase())
            return {
              d,
              type: c.type
                .replace(/\s*\bnot null\b.*$/i, "")
                .replace(/\s*\bdefault\b.*$/i, "")
                .trim(),
            };
    return undefined;
  };

  // ---- plan vs design, plan vs code
  for (const p of plans) {
    const where = (r: CatalogRecord) => `${r.evidence[0]?.path ?? p.feature.dir} in ${p.repo}`;
    for (const raw of p.feature.records) {
      const r = raw as Rec;
      if (r.kind === "Interface") {
        const i = r as unknown as RecordOf<"Interface"> & Rec;
        const pathOrTopic = i.normalizedPath;
        const h = designHopFor(i.from, i.to, i.method, pathOrTopic);
        const shown = i.method ? `${i.method} ${h?.path ?? pathOrTopic}` : `publish ${pathOrTopic}`;
        if (h) {
          const dv = viaOf(patterns, h.pattern);
          const reasons: string[] = [];
          if (dv && i.via !== "other" && i.via !== dv)
            reasons.push(`${i.via}; the approved design says ${dv} (${h.pattern})`);
          else if (i.pattern?.code && h.pattern && i.pattern.code !== h.pattern)
            reasons.push(`with pattern ${i.pattern.code}; the approved design says ${h.pattern}`);
          if (reasons.length)
            add("drift.plan-contradicts-design", i.id, {
              artifact: "interfaces.md",
              locator: { line: h.line },
              summary: `${where(i)} calls ${i.to} ${shown} ${reasons[0]}.`,
              evidence: [artEv("interfaces.md", h.line), specEv(p, i)],
            });
        } else {
          const c = codeInterfaces.find(
            (x) =>
              x.from === i.from &&
              x.to === i.to &&
              (x.method ?? "") === (i.method ?? "") &&
              norm(x.normalizedPath) === norm(pathOrTopic),
          );
          if (c) {
            if (i.via !== "other" && c.via !== i.via)
              add("drift.plan-vs-code", i.id, {
                artifact: "catalog",
                locator: { record: c.id },
                summary: `${where(i)} calls ${i.to} ${shown} ${i.via}; the code calls it ${c.via}.`,
                evidence: [specEv(p, i), { source: "catalog", record: c.id }],
              });
          } else if (!knownToDesign(i.to))
            add("drift.plan-adds-system", i.id, {
              artifact: "interfaces.md",
              locator: { record: i.id },
              summary: `${where(i)} calls ${i.to} (${shown}), a system the design doesn't include.`,
              evidence: [specEv(p, i)],
            });
          else
            add("drift.plan-adds-interface", i.id, {
              artifact: "interfaces.md",
              locator: { record: i.id },
              summary: `${where(i)} adds ${i.from} to ${i.to} (${shown}), which the design doesn't have.`,
              evidence: [specEv(p, i)],
            });
        }
        if (
          PAST_BUILD.has(change.state) &&
          i.status === "planned-new" &&
          !codeInterfaces.some((x) => x.id === i.id)
        )
          add("drift.plan-not-built", i.id, {
            artifact: "catalog",
            locator: { record: i.id },
            summary: `${where(i)} plans ${i.from} to ${i.to} (${shown}); the code doesn't have it.`,
            evidence: [specEv(p, i)],
          });
      } else if (r.kind === "Endpoint") {
        const e = r as unknown as RecordOf<"Endpoint"> & Rec;
        if (e.component !== p.component) continue;
        const rest = e.endpointType === "rest";
        const inDesign = rest
          ? hops.some(
              (h) =>
                h.callee === p.component &&
                h.method === e.method &&
                norm(h.path) === norm(e.pathOrTopic),
            )
          : hops.some((h) => h.caller === p.component && topicOf(h.operation) === e.pathOrTopic);
        const inCode = codeEndpoints.some((x) =>
          rest
            ? x.component === e.component &&
              x.method === e.method &&
              norm(x.normalizedPath ?? x.pathOrTopic) === norm(e.pathOrTopic)
            : x.endpointType === "event-topic" && x.pathOrTopic === e.pathOrTopic,
        );
        const shown = rest ? `${e.method} ${e.pathOrTopic}` : `topic ${e.pathOrTopic}`;
        if (!inDesign && (!inCode || e.status !== "planned-new"))
          add("drift.plan-adds-interface", e.id, {
            artifact: "interfaces.md",
            locator: { record: e.id },
            summary: inCode
              ? `${where(e)} changes ${shown}, which the design doesn't plan to change.`
              : `${where(e)} serves ${shown}, which the design doesn't have.`,
            evidence: [specEv(p, e)],
          });
        if (PAST_BUILD.has(change.state) && e.status === "planned-new" && !inCode)
          add("drift.plan-not-built", e.id, {
            artifact: "catalog",
            locator: { record: e.id },
            summary: `${where(e)} plans ${shown}; the code doesn't have it.`,
            evidence: [specEv(p, e)],
          });
      } else if (r.kind === "Table") {
        const t = r as unknown as RecordOf<"Table"> & Rec;
        const inDesign = data.some((d) => d.tableId === t.id);
        const inCode = codeIds.has(`Table/${t.id}`);
        if (!inDesign && (!inCode || t.status !== "planned-new"))
          add("drift.plan-adds-data", t.id, {
            artifact: "data.md",
            locator: { record: t.id },
            summary: inCode
              ? `${where(t)} changes table ${t.id}, which data.md doesn't.`
              : `${where(t)} adds table ${t.id}, which data.md doesn't have.`,
            evidence: [specEv(p, t)],
          });
      } else if (r.kind === "Column") {
        const c = r as unknown as RecordOf<"Column"> & Rec;
        const tableName = c.table.split(".").slice(1).join(".");
        const dc = designColumn(c.table, c.name);
        const codeCol = code.find((x) => x.kind === "Column" && x.id === c.id) as
          RecordOf<"Column"> | undefined;
        if (dc) {
          if (typeKey(dc.type) !== typeKey(c.type))
            add("drift.plan-contradicts-design", c.id, {
              artifact: "data.md",
              locator: { line: dc.d.line },
              summary: `${where(c)} makes ${dc.d.table || tableName}.${c.name} ${c.type}; data.md says ${dc.type}.`,
              evidence: [artEv("data.md", dc.d.line), specEv(p, c)],
            });
        } else if (codeCol) {
          if (typeKey(codeCol.type) !== typeKey(c.type))
            add("drift.plan-vs-code", c.id, {
              artifact: "catalog",
              locator: { record: codeCol.id },
              summary: `${where(c)} makes ${tableName}.${c.name} ${c.type}; the code has ${codeCol.type}.`,
              evidence: [specEv(p, c), { source: "catalog", record: codeCol.id }],
            });
        } else if (data.some((d) => d.tableId === c.table) || codeIds.has(`Table/${c.table}`)) {
          // A new column on a table the design or the code knows; a column of a table the plan
          // adds on its own is already covered by that table's finding.
          add("drift.plan-adds-data", c.id, {
            artifact: "data.md",
            locator: { record: c.id },
            summary: `${where(c)} adds column ${tableName}.${c.name}, which data.md doesn't have.`,
            evidence: [specEv(p, c)],
          });
        }
      }
    }
  }

  // ---- design vs code
  const codeIfIds = new Set(codeInterfaces.map((i) => i.id));
  for (const h of hops) {
    const shown = `${h.caller} to ${h.callee} (${h.operation.trim()})`;
    if (/^if-/.test(h.id) && /planned-(modify|retire)/.test(h.status) && !codeIfIds.has(h.id))
      add("drift.design-vs-code", h.id, {
        artifact: "interfaces.md",
        locator: { line: h.line },
        summary: `interfaces.md changes ${h.id}, ${shown}, which the code doesn't have.`,
        evidence: [artEv("interfaces.md", h.line)],
      });
    if (!PAST_BUILD.has(change.state)) continue;
    const there = codeInterfaces.some(
      (x) =>
        x.from === h.caller &&
        x.to === h.callee &&
        (h.method
          ? x.method === h.method && norm(x.normalizedPath) === norm(h.path)
          : x.normalizedPath === topicOf(h.operation)),
    );
    if (h.status === "planned-new" && !there)
      add("drift.design-vs-code", `${h.caller}-${h.callee}-${h.line}`, {
        artifact: "interfaces.md",
        locator: { line: h.line },
        summary: `The design plans ${shown}; the code doesn't have it.`,
        evidence: [artEv("interfaces.md", h.line)],
      });
    if (h.status === "planned-retire" && there)
      add("drift.design-vs-code", `${h.caller}-${h.callee}-${h.line}`, {
        artifact: "interfaces.md",
        locator: { line: h.line },
        summary: `The design retires ${shown}; the code still has it.`,
        evidence: [artEv("interfaces.md", h.line)],
      });
  }

  // One finding per id (a column contradiction can also be reached twice through two features).
  const unique = [...new Map(found.map((f) => [f.id, f])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (o.write === false)
    return {
      change: change.id,
      gate: DRIFT_GATE,
      unchanged: true,
      findings: [],
      plans,
      found: unique,
    };
  const w = await writeFullRound(root, change.id, DRIFT_GATE, unique, {
    now,
    meta: { plans: plans.map((p) => ({ repo: p.repo, feature: p.feature.feature, from: p.from })) },
  });
  return { ...w, change: change.id, plans, found: unique };
}
