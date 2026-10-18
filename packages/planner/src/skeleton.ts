import type { BuildEngine, RecordOf, TestType as TestTypeSchema } from "@maycombhq/core";
import type { z } from "zod";

type TestType = z.infer<typeof TestTypeSchema>;
import { normalizePath, type DataChange, type Hop } from "@maycombhq/naysayer";
import type { OpenQuestion, PlanContext, SpecRequirement, SpecScenario } from "./context.js";
import { coverage, overlap, slug } from "./words.js";

/**
 * The deterministic part of planning: which stories there are, what each one links to
 * (spec requirement, interfaces, records, features), which systems and repos it touches,
 * which test kinds it needs, what it depends on and which open questions it carries. AI only
 * writes the prose on top (title, who, outcome, criteria wording); it can't add a link.
 *
 * Stories: one per spec requirement; then one per new or changed hop no requirement covers;
 * then one per data change no story covers. A hop to a system the catalog doesn't know is not
 * planned: the critic raises it, and the plan says why it was left out.
 */

export type StorySource = "requirement" | "interface" | "data";

export interface PlannedInterface {
  /** A catalog Interface id, or "new". */
  id: string;
  caller: string;
  callee: string;
  operation: string;
  status: string;
  line: number;
}

export interface StorySkeleton {
  id: string;
  key: string;
  source: StorySource;
  requirement?: SpecRequirement;
  scenarios: SpecScenario[];
  hops: Hop[];
  data: DataChange[];
  interfaces: PlannedInterface[];
  /** Tables (and new columns as <table>.<column>) the story changes. */
  records: string[];
  /** Capability records (features found in code) the story's records belong to. */
  features: string[];
  systems: string[];
  components: string[];
  repos: string[];
  tests: TestType[];
  dependsOn: string[];
  openQuestions: { text: string; owner?: string; from?: string }[];
  /** The artifact line the story traces to: its spec requirement, else a proposal bullet. */
  trace?: { path: string; line: number; text: string };
  /** Material for the prose: hop notes and mapping lines, the data change. */
  material: string[];
}

export interface TaskPlan {
  id: string;
  repo: string;
  story: string;
  title: string;
  /** Service-desk requests the task waits for (template name and record). */
  waitsFor: string[];
}

export interface PlanSkeleton {
  change: string;
  stories: StorySkeleton[];
  notPlanned: { what: string; why: string; line: number }[];
  repos: { id: string; engine: BuildEngine }[];
  tasks: TaskPlan[];
  /** Test kinds the change needs that no story needs (the plan says so). */
  uncoveredTests: TestType[];
}

const PLANNED = new Set(["planned-new", "planned-modify"]);
const NO_CONTRACT = new Set(["", "none", "n/a", "-", "tbd"]);
const UPPER_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();
const words = (s: string) => s.replace(/_/g, " ").toLowerCase();

function hopText(ctx: PlanContext, h: Hop): string {
  return [h.operation, ...ctx.notes(h).map((n) => n.text), ctx.mapping(h)].join("\n");
}

/** Does a requirement talk about this hop: its path, or an error code its notes also name? */
function requirementMentionsHop(ctx: PlanContext, r: SpecRequirement, h: Hop): boolean {
  const norm = (s: string) => s.replace(/\{[^}]*\}/g, "{}");
  if (h.path && norm(r.text).includes(normalizePath(h.path))) return true;
  const tokens = new Set(r.text.match(UPPER_TOKEN) ?? []);
  if (tokens.size === 0) return false;
  return (hopText(ctx, h).match(UPPER_TOKEN) ?? []).some((t) => tokens.has(t));
}

/** Does a requirement talk about this data change: a new column's or the table's name? */
function requirementMentionsData(r: SpecRequirement, d: DataChange): boolean {
  const flat = (s: string) =>
    ` ${words(s)
      .replace(/[^a-z0-9]+/g, " ")
      .trim()} `;
  const text = flat(r.text);
  // A new table is about its name; added columns are about theirs.
  const names = d.newTable ? [d.table] : d.newColumns.map((c) => c.name);
  return names.some((n) => text.includes(flat(n)));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hopKey(ctx: PlanContext, h: Hop): string {
  const sys = ctx.systemOf(h.callee) ?? h.callee;
  const seg = (h.path ?? h.operation)
    .split("/")
    .filter((p) => p && !p.startsWith("{") && !/^v\d+$/i.test(p))
    .pop();
  const last = seg ? slug(seg) : slug(h.operation);
  return last.startsWith(slug(sys)) ? last : `${slug(sys)}-${last}`;
}

/** The proposal bullet a story is about (at least two content words shared), earliest on a tie. */
function traceToProposal(ctx: PlanContext, text: string): StorySkeleton["trace"] {
  let best: { line: number; text: string; n: number } | undefined;
  for (const b of ctx.changes) {
    const n = overlap(text, b.text);
    if (n >= 2 && (!best || n > best.n)) best = { ...b, n };
  }
  return best ? { path: "proposal.md", line: best.line, text: best.text } : undefined;
}

function isSync(ctx: PlanContext, h: Hop): boolean {
  const rec = h.id.startsWith("if-") ? ctx.get("Interface", h.id) : undefined;
  if (rec?.sync) return rec.sync === "sync";
  const p = ctx.patterns.get(h.pattern);
  if (p) return p.interaction === "sync";
  return !!h.method;
}

/** The test kinds a story needs, from the change's required kinds only (C6 test strategy). */
function testsOf(ctx: PlanContext, s: StorySkeleton, uiRepos: Set<string>): TestType[] {
  const want = new Set<TestType>(["unit"]);
  const vendor = s.hops.some((h) => ctx.boundaryOf(ctx.systemOf(h.callee) ?? "") === "vendor");
  if (s.hops.some((h) => !NO_CONTRACT.has(h.contract.trim().toLowerCase()))) want.add("contract");
  if (s.hops.length > 0 || s.data.length > 0) want.add("integration");
  if (s.repos.some((r) => uiRepos.has(r))) {
    want.add("e2e");
    want.add("accessibility");
  }
  if (s.hops.some((h) => h.status === "planned-modify") || s.data.some((d) => !d.newTable))
    want.add("regression");
  if (
    s.hops.some((h) => h.status === "planned-new" && isSync(ctx, h)) ||
    s.data.some((d) => !d.newTable)
  )
    want.add("performance");
  if (vendor || s.records.some((r) => ctx.footprint.personal.some((p) => p.id.startsWith(r))))
    want.add("security");
  if (s.data.length > 0) want.add("data-migration");
  return ctx.tests.required.filter((t) => want.has(t));
}

function questionOwner(q: OpenQuestion) {
  return { text: q.text, ...(q.owner ? { owner: q.owner } : {}), from: `${q.file}:${q.line}` };
}

export function buildSkeleton(ctx: PlanContext): PlanSkeleton {
  const stories: StorySkeleton[] = [];
  const notPlanned: PlanSkeleton["notPlanned"] = [];
  const hops = ctx.hops.filter((h) => PLANNED.has(h.status));
  const used = new Set<Hop>();
  const usedData = new Set<DataChange>();

  const blank = (key: string, source: StorySource): StorySkeleton => ({
    id: "",
    key,
    source,
    scenarios: [],
    hops: [],
    data: [],
    interfaces: [],
    records: [],
    features: [],
    systems: [],
    components: [],
    repos: [],
    tests: [],
    dependsOn: [],
    openQuestions: [],
    material: [],
  });

  // 1. One story per spec requirement.
  for (const r of ctx.requirements) {
    const s = blank(slug(r.name), "requirement");
    s.requirement = r;
    s.scenarios = r.scenarios;
    s.trace = { path: r.file, line: r.line, text: `Requirement: ${r.name}` };
    for (const h of hops)
      if (ctx.isKnown(h.callee) && ctx.isKnown(h.caller) && requirementMentionsHop(ctx, r, h)) {
        s.hops.push(h);
        used.add(h);
      }
    for (const d of ctx.data)
      if (requirementMentionsData(r, d)) {
        s.data.push(d);
        usedData.add(d);
      }
    stories.push(s);
  }

  // 2. One story per new or changed hop that no requirement covers.
  for (const h of hops) {
    if (used.has(h)) continue;
    const unknown = [h.caller, h.callee].filter((x) => !ctx.isKnown(x));
    if (unknown.length) {
      notPlanned.push({
        what: `${h.operation || h.id} (${h.caller} → ${h.callee})`,
        why: `${unknown.join(" and ")} ${unknown.length > 1 ? "are" : "is"} not in the catalog; the critic raises it, and the hop is planned once the catalog knows it`,
        line: h.line,
      });
      continue;
    }
    const s = blank(hopKey(ctx, h), "interface");
    s.hops.push(h);
    used.add(h);
    const calleeSystem = ctx.systemOf(h.callee) ?? h.callee;
    s.trace = traceToProposal(
      ctx,
      [
        ctx.systemName(calleeSystem),
        h.callee,
        h.path ?? "",
        ...ctx.notes(h).map((n) => n.text),
      ].join(" "),
    );
    stories.push(s);
  }

  // 3. One story per data change no story covers.
  const dataDoc = ctx.files.docs.get("data.md");
  const catalogNames = [
    ...ctx.records
      .filter((r) => ["Component", "System", "DataStore"].includes(r.kind))
      .map((r) => r.id),
    ...ctx.records.filter((r) => r.kind === "Table").map((r) => r.id.split(".").pop()!),
  ];
  for (const d of ctx.data) {
    if (usedData.has(d)) continue;
    const s = blank(slug(d.table), "data");
    s.data.push(d);
    usedData.add(d);
    // What the data prose says about the table, without the names of who reads or writes it.
    const names = [...catalogNames, ...ctx.data.map((x) => x.table)].filter(
      (n) => n && n.toLowerCase() !== d.table.toLowerCase(),
    );
    const others = new RegExp(
      `(?<![\\w-])(${names.map(escapeRe).join("|") || "$^"})(?![\\w-])`,
      "gi",
    );
    const prose = (dataDoc?.lines ?? [])
      .filter((l) => !l.includes("|") && l.includes(d.table))
      .map((l) => l.replace(others, " "));
    s.trace = traceToProposal(ctx, [words(d.table), ...prose].join(" "));
    stories.push(s);
  }

  stories.forEach((s, i) => (s.id = `s${i + 1}-${s.key}`));

  // Links, systems, components, repos.
  const uiRepos = new Set<string>();
  const spaComponents = ctx.records.filter(
    (r) => r.kind === "Component" && (r as RecordOf<"Component">).type === "spa",
  ) as RecordOf<"Component">[];
  const hasUx = ctx.files.docs.has("ux.md");
  for (const s of stories) {
    const comps = new Set<string>();
    const systems = new Set<string>();
    const repos = new Set<string>();
    for (const h of s.hops) {
      s.interfaces.push({
        id: h.id,
        caller: h.caller,
        callee: h.callee,
        operation: h.operation,
        status: h.status,
        line: h.line,
      });
      for (const end of [h.caller, h.callee]) {
        const sys = ctx.systemOf(end);
        if (sys) systems.add(sys);
        if (ctx.get("Component", end)) comps.add(end);
        const repo = ctx.repoOf(end);
        if (repo) repos.add(repo);
        else if (ctx.get("Component", end) && ctx.boundaryOf(sys ?? "") !== "vendor")
          s.openQuestions.push({
            text: `${end}'s repo is unknown, so its side of this story can't get a task yet.`,
            owner: "architect",
          });
      }
      for (const n of ctx.notes(h)) s.material.push(`interfaces.md:${n.n}: ${n.text.trim()}`);
      const m = ctx.mapping(h).trim();
      if (m) s.material.push(`mappings.md (${h.operation}):\n${m}`);
      // A user-facing requirement served through a BFF: the UI that calls it shows the result.
      if (s.source === "requirement" && hasUx)
        for (const ui of spaComponents)
          if (
            ui.system === ctx.systemOf(h.caller) &&
            ctx.records.some(
              (r) =>
                r.kind === "Interface" &&
                (r as RecordOf<"Interface">).from === ui.id &&
                (r as RecordOf<"Interface">).to === h.caller,
            ) &&
            ui.repo
          ) {
            comps.add(ui.id);
            repos.add(ui.repo);
            uiRepos.add(ui.repo);
          }
    }
    for (const d of s.data) {
      s.records.push(d.tableId);
      const owner = ctx.get("DataStore", d.store)?.ownerComponent;
      const sys = ctx.systemOf(d.store);
      if (sys) systems.add(sys);
      if (owner) {
        comps.add(owner);
        const repo = ctx.repoOf(owner);
        if (repo) repos.add(repo);
      }
      s.material.push(`data.md:${d.line}: ${d.store} ${d.table}: ${d.change}`);
    }
    s.components = sortedUnique(comps);
    s.systems = sortedUnique(systems);
    s.repos = sortedUnique(repos);
    s.records = sortedUnique(s.records);
    s.features = sortedUnique(
      ctx.records
        .filter((r) => r.kind === "Capability")
        .filter((r) => {
          const c = r as RecordOf<"Capability">;
          const ids = new Set([...c.records, ...c.entryPoints]);
          return (
            s.interfaces.some((i) => ids.has(i.id)) ||
            s.components.some((x) => ids.has(x)) ||
            s.records.some((x) => ids.has(x))
          );
        })
        .map((r) => r.id),
    );
    s.openQuestions = s.openQuestions.filter(
      (q, i, all) => all.findIndex((x) => x.text === q.text) === i,
    );
  }
  for (const r of ctx.records)
    if (r.kind === "Component" && (r as RecordOf<"Component">).type === "spa") {
      const repo = (r as RecordOf<"Component">).repo;
      if (repo) uiRepos.add(repo);
    }

  // Depends on: a story whose mappings read a column another story adds.
  for (const s of stories) {
    const text = s.hops
      .map((h) => ctx.mapping(h))
      .join("\n")
      .toLowerCase();
    for (const o of stories) {
      if (o === s) continue;
      const adds = o.data.flatMap((d) =>
        d.newColumns.map((c) => `${d.table.toLowerCase()}.${c.name.toLowerCase()}`),
      );
      if (adds.some((a) => text.includes(a))) s.dependsOn.push(o.id);
    }
  }

  // Open questions: the brief's and proposal's (once each), on the story they are most about.
  const asked: OpenQuestion[] = [];
  for (const q of ctx.questions)
    if (!asked.some((a) => coverage(q.text, a.text) >= 0.5 || coverage(a.text, q.text) >= 0.5))
      asked.push(q);
  for (const q of asked) {
    let best: StorySkeleton | undefined;
    let n = 0;
    for (const s of stories) {
      const k = overlap(q.text, storyWords(s));
      if (k > n) {
        best = s;
        n = k;
      }
    }
    (best ?? stories[0])?.openQuestions.push(questionOwner(q));
  }
  for (const s of stories) {
    for (const h of s.hops) {
      const sys = ctx.systemOf(h.callee);
      if (h.status === "planned-new" && sys && ctx.boundaryOf(sys) === "vendor")
        s.openQuestions.push({
          text: `What should ${h.caller} do when ${sys} rejects ${h.operation}, answers with an error, or doesn't answer in time?`,
          owner: "product-owner",
        });
    }
    if (s.source !== "requirement")
      s.openQuestions.push({
        text: "No spec requirement covers this story: add one to the specs, or say why none is needed.",
        owner: "product-owner",
      });
  }

  for (const s of stories) s.tests = testsOf(ctx, s, uiRepos);
  const covered = new Set(stories.flatMap((s) => s.tests));
  const uncoveredTests = ctx.tests.required.filter((t) => !covered.has(t));

  const repoIds = sortedUnique(stories.flatMap((s) => s.repos));
  const tasks = planTasks(ctx, stories, repoIds);
  return {
    change: ctx.change.id,
    stories,
    notPlanned,
    repos: repoIds.map((id) => ({ id, engine: ctx.engineOf(id) })),
    tasks,
    uncoveredTests,
  };
}

function storyWords(s: StorySkeleton): string {
  return [
    s.requirement?.text ?? "",
    ...s.hops.map((h) => `${h.operation} ${h.callee}`),
    ...s.data.map((d) => `${words(d.table)} ${d.newColumns.map((c) => words(c.name)).join(" ")}`),
  ].join(" ");
}

/** One task per story in each repo it touches, worded from what that repo does in it. */
function planTasks(ctx: PlanContext, stories: StorySkeleton[], repos: string[]): TaskPlan[] {
  const out: TaskPlan[] = [];
  repos.forEach((repo, ri) => {
    let n = 0;
    const component = ctx.componentOfRepo(repo);
    for (const s of stories) {
      if (!s.repos.includes(repo)) continue;
      const parts: string[] = [];
      for (const h of s.hops) {
        const verb = h.status === "planned-new" ? "Add" : "Change";
        if (component && h.callee === component) parts.push(`${verb} ${h.operation}`);
        if (component && h.caller === component)
          parts.push(
            h.status === "planned-new"
              ? `Call ${h.operation} on ${h.callee}`
              : `Update the call to ${h.operation} on ${h.callee}`,
          );
      }
      for (const d of s.data) {
        if (ctx.repoOf(ctx.get("DataStore", d.store)?.ownerComponent ?? "") !== repo) continue;
        if (d.newTable) parts.push(`Create table ${d.table} with a migration`);
        else
          for (const c of d.newColumns)
            parts.push(`Add column ${d.table}.${c.name} with a migration`);
        if (!d.newTable && d.newColumns.length === 0)
          parts.push(`Change table ${d.table} with a migration`);
      }
      if (parts.length === 0) parts.push(`Update the screens as ux.md describes`);
      n++;
      out.push({
        id: `${ri + 1}.${n}`,
        repo,
        story: s.id,
        title: `${parts.map((p, i) => (i ? p[0]!.toLowerCase() + p.slice(1) : p)).join("; ")}, with tests`,
        waitsFor: [],
      });
    }
  });
  return out;
}
