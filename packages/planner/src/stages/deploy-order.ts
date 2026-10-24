import { endpointKey, type Estate } from "./estate.js";
import { endpointName } from "./contracts.js";
import type { StageIssue } from "./loop.js";
import type { DeployStep, FlowDelta } from "./schema.js";

/**
 * The deploy order the architecture stage drafts across a change's repos (ADR 0124 addendum
 * B-arch), checked in code against what the target flows need: a migration runs before the code
 * of every repo whose target flows read or write the table it changes, and a callee deploys
 * before its caller when the call is new or the callee's flow for that entry changes. Every repo
 * the target flows change and every migration they name has its step. The needs are facts read
 * off the deltas and the catalog; the drafter writes the order, and a wrong one goes back to it.
 */

type Rec = Estate["records"][number] & Record<string, unknown>;
const fileOf = (path: string) => path.trim().split(/[\\/]/).at(-1)!;
const entryKey = (entry: string) =>
  /^\s*[A-Za-z]+\s+\S/.test(entry) ? endpointKey(entry) : entry.trim();

interface Unit {
  key: string;
  kind: "migration" | "code";
  repo: string;
  /** The repo, or the migration's file name. */
  name: string;
  /** A migration's tables. */
  tables: string[];
}

interface Need {
  first: string;
  then: string;
  why:
    | { kind: "migration"; table: string }
    | { kind: "callee"; callee: string; entry: string; verb: "new" | "changed" };
}

const codeKey = (repo: string) => `code:${repo}`;
const migrationKey = (file: string) => `migration:${file}`;

/** The entry that starts a delta's flow, as the catalog keys it, and the flow's component. */
function flowEntry(d: FlowDelta, e: Estate): { key?: string; component: string } {
  const today = e.flowById.get(d.flow)?.flow;
  const component = today?.component ?? d.flow.split(".")[0]!;
  if (d.change === "new")
    return { ...(d.trigger?.entry ? { key: entryKey(d.trigger.entry) } : {}), component };
  const ref = today?.trigger.ref;
  return ref && e.byId.get(ref)?.kind === "Endpoint"
    ? { key: entryKey(endpointName(e, ref)), component }
    : { component };
}

/** The units a change deploys (each repo's code, each migration) and what must go first. */
export function deployNeeds(deltas: FlowDelta[], e: Estate): { units: Unit[]; needs: Need[] } {
  const units = new Map<string, Unit>();
  for (const d of deltas)
    if (!units.has(codeKey(d.repo)))
      units.set(codeKey(d.repo), {
        key: codeKey(d.repo),
        kind: "code",
        repo: d.repo,
        name: d.repo,
        tables: [],
      });
  for (const d of deltas)
    for (const s of d.steps) {
      if (s.op === "remove" || !s.store?.migration?.trim()) continue;
      const file = fileOf(s.store.migration);
      const u = units.get(migrationKey(file)) ?? {
        key: migrationKey(file),
        kind: "migration" as const,
        repo: d.repo,
        name: file,
        tables: [],
      };
      if (!u.tables.includes(s.store.table)) u.tables.push(s.store.table);
      units.set(u.key, u);
    }
  const needs: Need[] = [];
  const add = (n: Need) => {
    if (!needs.some((x) => x.first === n.first && x.then === n.then)) needs.push(n);
  };
  // A migration before the code of every repo that reads or writes a table it changes.
  for (const u of units.values()) {
    if (u.kind !== "migration") continue;
    for (const table of u.tables)
      for (const d of deltas)
        if (d.steps.some((s) => s.op !== "remove" && s.store?.table === table))
          add({ first: u.key, then: codeKey(d.repo), why: { kind: "migration", table } });
  }
  // A callee before its caller, when the call is new or the callee's flow for it changes.
  const repoOf = (id: string) => {
    const r = e.byId.get(id) as Rec | undefined;
    return r?.kind === "Component" && typeof r.repo === "string" ? r.repo : undefined;
  };
  for (const d of deltas) {
    const today = e.flowById.get(d.flow)?.flow;
    for (const s of d.steps) {
      if (s.op === "remove") continue;
      const was = s.step ? today?.steps[s.step - 1] : undefined;
      const kind = s.kind ?? was?.kind;
      if (kind !== "call-out" && kind !== "publish") continue;
      const to = s.to ?? (was?.to ? { ...was.to, new: false } : undefined);
      if (!to) continue;
      const callee = repoOf(to.component);
      if (!callee || callee === d.repo || !units.has(codeKey(callee))) continue;
      const key = entryKey(to.entry);
      const changed = deltas.some((x) => {
        if (x.repo !== callee) return false;
        const f = flowEntry(x, e);
        const system = (e.byId.get(f.component) as Rec | undefined)?.system;
        return f.key === key && (f.component === to.component || system === to.component);
      });
      if (to.new || changed)
        add({
          first: codeKey(callee),
          then: codeKey(d.repo),
          why: {
            kind: "callee",
            callee: to.component,
            entry: to.entry,
            verb: to.new ? "new" : "changed",
          },
        });
    }
  }
  return { units: [...units.values()], needs };
}

/** An order that meets every need, migrations first among those ready, then by name. */
function suggestedOrder(units: Unit[], needs: Need[]): Unit[] {
  const left = new Map(units.map((u) => [u.key, u]));
  const out: Unit[] = [];
  const rank = (u: Unit) => (u.kind === "migration" ? 0 : 1);
  const byRank = (a: Unit, b: Unit) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  while (left.size) {
    const ready = [...left.values()].filter(
      (u) => !needs.some((n) => n.then === u.key && left.has(n.first)),
    );
    const next = (ready.length ? ready : [...left.values()]).sort(byRank)[0]!;
    out.push(next);
    left.delete(next.key);
  }
  return out;
}

const unitWords = (u: Unit) => (u.kind === "migration" ? `migration ${u.name}` : u.name);

/**
 * Check 4: the drafted deploy order against what the target flows need. No order is a risk (not
 * blocking: drafts recorded before the order was asked for have none) when the order matters,
 * with an order that meets every need; a wrong one goes back to the drafter.
 */
export function deployIssues(
  deltas: FlowDelta[],
  deploy: DeployStep[] | undefined,
  e: Estate,
): StageIssue[] {
  const { units, needs } = deployNeeds(deltas, e);
  const codes = units.filter((u) => u.kind === "code");
  const migrations = units.filter((u) => u.kind === "migration");
  if (!deploy?.length) {
    if (!needs.length && codes.length < 2) return [];
    const order = suggestedOrder(units, needs)
      .map((u, i) => `${i + 1}. ${unitWords(u)}${u.kind === "migration" ? `, in ${u.repo}` : ""}`)
      .join("; ");
    return [
      {
        rule: "delta.no-deploy-order",
        target: "deploy",
        message: `The target flows give no deploy order, and here the order matters: a migration runs before the code that needs it, and a callee deploys before its caller. Give it under deploy, one step a repo or migration, such as: ${order}.`,
        blocking: false,
      },
    ];
  }
  const out: StageIssue[] = [];
  const known = new Set<string>([
    ...codes.map((u) => u.repo),
    ...e.flows.map((f) => f.repo),
    ...(e.records as Rec[])
      .filter((r) => r.kind === "Component" && typeof r.repo === "string")
      .map((r) => String(r.repo)),
  ]);
  const at: (string | undefined)[] = deploy.map((s, i) => {
    const n = i + 1;
    if (!known.has(s.repo)) {
      out.push({
        rule: "delta.deploy-unknown-repo",
        target: `deploy#${n}`,
        message: `Step ${n} of the deploy order deploys ${s.repo}, which isn't a repo the estate has: name a repo from the index.`,
        blocking: true,
      });
      return undefined;
    }
    if (!s.migration) return codeKey(s.repo);
    const key = migrationKey(fileOf(s.migration));
    if (!units.some((u) => u.key === key)) {
      out.push({
        rule: "delta.deploy-unknown-migration",
        target: `deploy#${n}`,
        message: `Step ${n} of the deploy order runs migration ${s.migration}, which no target flow names: name the migration a step gives under store.migration${migrations.length ? ` (${migrations.map((m) => m.name).join(", ")})` : ""}.`,
        blocking: true,
      });
      return undefined;
    }
    return key;
  });
  const pos = (key: string) => at.indexOf(key);
  for (const u of codes)
    if (pos(u.key) < 0)
      out.push({
        rule: "delta.deploy-missing",
        target: `deploy:${u.name}`,
        message: `The deploy order leaves out ${u.repo}, whose target flows change: add a step for it.`,
        blocking: true,
        repo: u.repo,
      });
  for (const u of migrations)
    if (pos(u.key) < 0)
      out.push({
        rule: "delta.deploy-missing",
        target: `deploy:${u.name}`,
        message: `The deploy order doesn't run migration ${u.name}, which changes ${u.tables.join(", ")}: add a step with migration: ${u.name}, before the code that needs it.`,
        blocking: true,
        repo: u.repo,
      });
  const byKey = new Map(units.map((u) => [u.key, u]));
  for (const n of needs) {
    const f = pos(n.first);
    const t = pos(n.then);
    if (f < 0 || t < 0 || f < t) continue;
    const first = byKey.get(n.first)!;
    const then = byKey.get(n.then)!;
    out.push({
      rule: "delta.deploy-order",
      target: `deploy:${first.name}>${then.name}`,
      message:
        n.why.kind === "migration"
          ? `The deploy order puts ${then.name} (step ${t + 1}) before migration ${first.name} (step ${f + 1}), but ${then.name} reads or writes ${n.why.table}, which that migration changes: run the migration first.`
          : `The deploy order puts ${then.name} (step ${t + 1}) before ${first.name} (step ${f + 1}), but ${then.name} calls ${n.why.callee}'s ${n.why.verb} ${n.why.entry}: deploy ${first.name} first.`,
      blocking: true,
      repo: then.repo,
    });
  }
  return out;
}

/** design.md's deploy order, as drafted, or nothing when there is none. */
export function renderDeploy(deploy: DeployStep[] | undefined): string[] {
  if (!deploy?.length) return [];
  const end = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
  return [
    "## Deploy order",
    "",
    ...deploy.map(
      (s, i) =>
        `${i + 1}. ${s.migration ? `Migration ${s.migration}, in ${s.repo}.` : `${s.repo}.`}${s.why?.trim() ? ` ${end(s.why)}` : ""}`,
    ),
    "",
  ];
}
