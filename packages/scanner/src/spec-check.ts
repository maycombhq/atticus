import {
  flowFiles,
  NEVER_CHECKED_STEPS,
  specFileHash,
  normalizePath,
  specFindingFingerprint,
  type CatalogRecord,
  type EvidenceT,
  type FlowRecord,
  type RecordOf,
  type SpecTemplate,
  type StepRequirement,
} from "@maycombhq/core";
import type { RepoHandle } from "@maycombhq/sdk";

/**
 * The spec critic (ADR 0079), deterministic: it checks a repo's flows against the catalog,
 * the spec template and the code. Every trigger the template finds in the catalog has a flow;
 * every cited line exists; a call-out names a target in the catalog; a field a step uses
 * appears in an earlier step; a write names a table and columns the catalog has; and a step's
 * claim is checked on its cited lines, which sets `confirmedBy: check` where it holds.
 */

export type SpecRule =
  | "no-flow"
  | "line-missing"
  | "ref-unknown"
  | "call-out-target"
  | "write-store"
  | "column-unknown"
  | "template-requires"
  | "field-from-nowhere"
  | "family-mismatch"
  | "check-fails"
  | "stale";

export interface SpecCheckFinding {
  rule: SpecRule;
  /** What it is about: `<flow id> <where>`, or `trigger <id>` for a trigger with no flow. */
  target: string;
  /** path:line it is about, when there is one. */
  evidence?: string;
  message: string;
  fingerprint: string;
  /** The flow it is in, when it is in one. */
  flow?: string;
}

export interface SpecTrigger {
  id: string;
  kind: string;
  /** METHOD /path, or the topic or job. */
  label: string;
  evidence?: string;
  /** The flow that covers it, as its trigger or in its family. */
  flow?: string;
}

export interface SpecCheckResult {
  findings: SpecCheckFinding[];
  /** The flows, with `confirmedBy: check` set on each step whose claim holds. */
  flows: FlowRecord[];
  /** The triggers the template finds in the catalog for this repo, and the flow of each. */
  triggers: SpecTrigger[];
  /** Steps whose claim the check confirmed. */
  confirmed: number;
  /** Steps it can never confirm (transforms, branches, validations) or that name nothing to look for. */
  unconfirmable: number;
}

type Endpoint = RecordOf<"Endpoint">;
type Table = RecordOf<"Table">;

const at = (e: EvidenceT | undefined) =>
  e?.path ? `${e.path}${e.line !== undefined ? `:${e.line}` : ""}` : undefined;

/** A field as compared: the last dotted part, lower case, without _ - or spaces. */
export const fieldKey = (f: string) =>
  f
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The repo's components: those whose repo is it, or that cite it. */
export function repoComponents(records: readonly CatalogRecord[], repoId: string): Set<string> {
  return new Set(
    records
      .filter(
        (r) =>
          r.kind === "Component" &&
          (r.repo === repoId || r.evidence.some((e) => e.repo === repoId)),
      )
      .map((r) => r.id),
  );
}

/** A trigger's resource: its path once trailing parameters are dropped (families by resource). */
export const resourceKey = (path: string) => {
  let p = normalizePath(path).toLowerCase();
  while (p.endsWith("/{}")) p = p.slice(0, -3);
  return p || "/";
};

const endpointLabel = (e: Endpoint) =>
  `${e.method ? `${e.method.toUpperCase()} ` : ""}${e.pathOrTopic}`;

/** The triggers the template's trigger kinds find in the catalog for the repo's components. */
export function specTriggers(
  records: readonly CatalogRecord[],
  repoId: string,
  template: SpecTemplate,
): SpecTrigger[] {
  const comps = repoComponents(records, repoId);
  const out: SpecTrigger[] = [];
  const seen = new Set<string>();
  for (const t of template.triggers) {
    if (!t.from) continue;
    for (const r of records) {
      if (seen.has(r.id)) continue;
      const from = t.from;
      if (
        from.kind === "Endpoint" &&
        r.kind === "Endpoint" &&
        comps.has(r.component) &&
        from.endpointType.includes(r.endpointType)
      ) {
        seen.add(r.id);
        out.push({
          id: r.id,
          kind: t.kind,
          label: endpointLabel(r),
          ...(at(r.evidence[0]) ? { evidence: at(r.evidence[0])! } : {}),
        });
      } else if (
        from.kind === "Interface" &&
        r.kind === "Interface" &&
        comps.has(r.to) &&
        from.via.includes(r.via) &&
        from.direction.includes(r.direction)
      ) {
        seen.add(r.id);
        out.push({
          id: r.id,
          kind: t.kind,
          label: `${r.method ? `${r.method} ` : ""}${r.normalizedPath}`,
          ...(at(r.evidence[0]) ? { evidence: at(r.evidence[0])! } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PARAM = /^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/;
const PARAM_RE = "(?:\\{[^}]*\\}|:[A-Za-z_]\\w*|<[^>]+>|\\$\\{[^}]*\\})";

/**
 * Whether a line names a route: the path, or its tail once leading segments are dropped (a
 * class-level prefix sits elsewhere), with at least one plain segment left. Parameters match
 * in any style ({id}, :id, <id>, ${id}).
 */
export function lineNamesRoute(line: string, path: string): boolean {
  const segs = path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  for (let k = 0; k < segs.length; k++) {
    const tail = segs.slice(k);
    if (!tail.some((s) => !PARAM.test(s))) break;
    const re = new RegExp(
      `/${tail.map((s) => (PARAM.test(s) ? PARAM_RE : escape(s))).join("/")}(?![A-Za-z0-9_-])`,
      "i",
    );
    if (re.test(line)) return true;
  }
  return false;
}

/** Whether a line names a word (a table, a topic): case aside, not inside a longer word. */
export const lineNamesWord = (line: string, word: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${escape(word)}($|[^A-Za-z0-9_])`, "i").test(line);

/** Whether a line names a field, letter case and _ or - aside (first_name matches firstName). */
export const lineNamesField = (line: string, field: string) => {
  const k = fieldKey(field);
  return (
    k.length > 0 &&
    line
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/ /g, "")
      .includes(k)
  );
};

interface Claim {
  kind: "route" | "word" | "field";
  value: string;
}

/** Parse a `to.entry` written as "METHOD /path": the method and path, else undefined. */
const methodPath = (s: string) => {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s.trim());
  return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : undefined;
};

/** Check a repo's spec. Reads only the cited files of the repo. */
export async function checkSpec(o: {
  repo: RepoHandle;
  repoId: string;
  flows: readonly FlowRecord[];
  /** The whole catalog (other repos' entry points are call-out targets). */
  records: readonly CatalogRecord[];
  template: SpecTemplate;
  /** Leave out the trigger-coverage rule (the drafter's per-flow checks). */
  perFlowOnly?: boolean;
}): Promise<SpecCheckResult> {
  const byId = new Map(o.records.map((r) => [r.id, r]));
  const comps = repoComponents(o.records, o.repoId);
  const endpoints = o.records.filter((r): r is Endpoint => r.kind === "Endpoint");
  const interfaces = o.records.filter((r): r is RecordOf<"Interface"> => r.kind === "Interface");
  const columnsOf = new Map<string, Set<string>>();
  for (const r of o.records)
    if (r.kind === "Column") {
      const s = columnsOf.get(r.table) ?? new Set<string>();
      s.add(r.name.toLowerCase());
      columnsOf.set(r.table, s);
    }
  const findings: SpecCheckFinding[] = [];
  const add = (f: Omit<SpecCheckFinding, "fingerprint">) => {
    const fingerprint = specFindingFingerprint(f.rule, f.target, f.evidence ?? "");
    if (!findings.some((x) => x.fingerprint === fingerprint)) findings.push({ ...f, fingerprint });
  };

  const texts = new Map<string, string[] | null>();
  const linesOf = async (path: string) => {
    if (!texts.has(path)) {
      const t = await o.repo.readText(path).catch(() => undefined);
      // A last newline ends the last line; it doesn't start another.
      texts.set(
        path,
        t === undefined ? null : t.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"),
      );
    }
    return texts.get(path)!;
  };
  /** The cited lines' text, and a finding for each citation that isn't there. */
  const cited = async (ev: readonly EvidenceT[], flow: string, where: string) => {
    const out: string[] = [];
    for (const e of ev) {
      const a = at(e);
      if (!e.path || e.line === undefined) {
        add({
          rule: "line-missing",
          target: `${flow} ${where}`,
          ...(a ? { evidence: a } : {}),
          message: `${flow} ${where} cites ${a ?? "nothing"}, not a file and line`,
          flow,
        });
        continue;
      }
      const lines = await linesOf(e.path);
      if (!lines)
        add({
          rule: "line-missing",
          target: `${flow} ${where}`,
          evidence: a!,
          message: `${flow} ${where} cites ${a}: ${e.path} isn't in the repo`,
          flow,
        });
      else if (e.line < 1 || e.line > lines.length)
        add({
          rule: "line-missing",
          target: `${flow} ${where}`,
          evidence: a!,
          message: `${flow} ${where} cites ${a}: ${e.path} has ${lines.length} lines`,
          flow,
        });
      else out.push(lines[e.line - 1]!);
    }
    return out;
  };
  const known = (id: string, flow: string, where: string, ev?: string) => {
    if (byId.has(id)) return true;
    add({
      rule: "ref-unknown",
      target: `${flow} ${where} ${id}`,
      ...(ev ? { evidence: ev } : {}),
      message: `${flow} ${where} names ${id}, which isn't in the catalog`,
      flow,
    });
    return false;
  };
  const requires = new Map(o.template.steps.map((s) => [s.kind, s.requires]));
  const has = (s: FlowRecord["steps"][number], req: StepRequirement): boolean => {
    switch (req) {
      case "to":
        return !!s.to;
      case "store.table":
        return !!s.store?.table;
      case "store.columns":
        return (s.store?.columns.length ?? 0) > 0;
      default: {
        const k = req.slice(5) as keyof NonNullable<typeof s.data>;
        return (s.data?.[k]?.length ?? 0) > 0;
      }
    }
  };
  /** The route or topic a call-out names, and whether the catalog has it. */
  const target = (component: string, entry: string): { path?: string; found: boolean } => {
    const rec = byId.get(entry);
    if (rec?.kind === "Endpoint") return { path: rec.pathOrTopic, found: true };
    if (rec?.kind === "Interface") return { path: rec.normalizedPath, found: true };
    const mp = methodPath(entry);
    const path = mp?.path ?? entry.trim();
    const norm = normalizePath(path).toLowerCase();
    const sameMethod = (m: string | undefined) => !mp || !m || m.toUpperCase() === mp.method;
    const found =
      endpoints.some(
        (e) =>
          e.component === component &&
          sameMethod(e.method) &&
          normalizePath(e.normalizedPath ?? e.pathOrTopic).toLowerCase() === norm,
      ) ||
      interfaces.some(
        (i) =>
          comps.has(i.from) &&
          i.to === component &&
          sameMethod(i.method) &&
          normalizePath(i.normalizedPath).toLowerCase() === norm,
      );
    return { path, found };
  };

  let confirmed = 0;
  let unconfirmable = 0;
  const flows: FlowRecord[] = [];
  for (const f of o.flows) {
    const fid = f.id;
    await cited(f.trigger.evidence, fid, "trigger");
    const trig = f.trigger.ref ? byId.get(f.trigger.ref) : undefined;
    if (f.trigger.ref) known(f.trigger.ref, fid, "trigger", at(f.trigger.evidence[0]));
    if (!comps.has(f.component) && comps.size > 0)
      known(f.component, fid, "component", at(f.trigger.evidence[0]));
    // Families: every member shares the trigger's component and resource.
    if (f.family.length) {
      const key = trig?.kind === "Endpoint" ? resourceKey(trig.pathOrTopic) : undefined;
      for (const m of f.family) {
        if (!known(m, fid, "family", at(f.trigger.evidence[0]))) continue;
        const r = byId.get(m)!;
        if (
          !o.template.families.length ||
          r.kind !== "Endpoint" ||
          trig?.kind !== "Endpoint" ||
          r.component !== trig.component ||
          resourceKey(r.pathOrTopic) !== key
        )
          add({
            rule: "family-mismatch",
            target: `${fid} family ${m}`,
            message: o.template.families.length
              ? `${fid} stands for ${m}, which isn't on the same resource (${key ?? "its trigger has no path"}) of the same component`
              : `${fid} stands for ${m}, but the template ${o.template.repoType}@${o.template.version} has no families`,
            flow: fid,
          });
      }
    }
    for (const [i, e] of f.errors.entries()) await cited(e.evidence, fid, `error ${i + 1}`);

    // Fields known before each step: the trigger's words, and every field an earlier step names.
    const seenFields = new Set<string>(
      f.trigger.what
        .split(/[^A-Za-z0-9_]+/)
        .filter(Boolean)
        .map(fieldKey),
    );
    if (trig?.kind === "Endpoint")
      for (const m of trig.pathOrTopic.matchAll(/[{:<]\$?\{?([A-Za-z_]\w*)/g))
        seenFields.add(fieldKey(m[1]!));
    const steps: FlowRecord["steps"] = [];
    for (const [i, s] of f.steps.entries()) {
      const where = `step ${i + 1} (${s.kind})`;
      const ev = at(s.evidence[0]);
      const lines = await cited(s.evidence, fid, where);
      for (const r of s.refs) known(r, fid, where, ev);
      for (const req of requires.get(s.kind) ?? [])
        if (!has(s, req))
          add({
            rule: "template-requires",
            target: `${fid} ${where} ${req}`,
            ...(ev ? { evidence: ev } : {}),
            message: `${fid} ${where}: the template ${o.template.repoType}@${o.template.version} asks a ${s.kind} for ${req}`,
            flow: fid,
          });
      // A call-out or publish names a target the catalog has.
      let route: string | undefined;
      if (s.to) {
        const comp = byId.get(s.to.component);
        if (!comp || comp.kind !== "Component")
          add({
            rule: "call-out-target",
            target: `${fid} ${where} ${s.to.component}`,
            ...(ev ? { evidence: ev } : {}),
            message: `${fid} ${where} goes to ${s.to.component}, which isn't a component in the catalog`,
            flow: fid,
          });
        const t = target(s.to.component, s.to.entry);
        route = t.path;
        if (comp?.kind === "Component" && !t.found)
          add({
            rule: "call-out-target",
            target: `${fid} ${where} ${s.to.entry}`,
            ...(ev ? { evidence: ev } : {}),
            message: `${fid} ${where} goes to ${s.to.entry} on ${s.to.component}, which the catalog has no entry point or interface for`,
            flow: fid,
          });
      }
      // A write names a table and columns the catalog has.
      let table: Table | undefined;
      if (s.store) {
        if (known(s.store.table, fid, where, ev)) {
          const r = byId.get(s.store.table)!;
          if (r.kind === "Table") table = r;
          else
            add({
              rule: "write-store",
              target: `${fid} ${where} ${s.store.table}`,
              ...(ev ? { evidence: ev } : {}),
              message: `${fid} ${where} stores in ${s.store.table}, which is a ${r.kind}, not a Table`,
              flow: fid,
            });
        }
        const cols = table ? columnsOf.get(table.id) : undefined;
        if (cols)
          for (const c of s.store.columns)
            if (!cols.has(c.toLowerCase()))
              add({
                rule: "column-unknown",
                target: `${fid} ${where} ${s.store.table}.${c}`,
                ...(ev ? { evidence: ev } : {}),
                message: `${fid} ${where} names the column ${c}, which ${table!.name} doesn't have in the catalog`,
                flow: fid,
              });
      }
      if (s.kind === "write" && (!s.store || s.store.columns.length === 0))
        add({
          rule: "write-store",
          target: `${fid} ${where}`,
          ...(ev ? { evidence: ev } : {}),
          message: `${fid} ${where} is a write that names no ${s.store ? "columns" : "table and columns"}`,
          flow: fid,
        });
      // A field a step uses appears in an earlier step or the trigger.
      if (i > 0)
        for (const x of [...(s.data?.sends ?? []), ...(s.data?.from ?? [])])
          if (!seenFields.has(fieldKey(x)))
            add({
              rule: "field-from-nowhere",
              target: `${fid} ${where} ${x}`,
              ...(ev ? { evidence: ev } : {}),
              message: `${fid} ${where} uses ${x}, which no earlier step or the trigger names`,
              flow: fid,
            });
      for (const x of [
        ...Object.values(s.data ?? {}).flat(),
        ...(s.store?.columns ?? []),
      ] as string[])
        seenFields.add(fieldKey(x));

      // The claim: what the step names, looked for on its cited lines.
      const claims: Claim[] = [];
      if (!(NEVER_CHECKED_STEPS as readonly string[]).includes(s.kind)) {
        if (s.kind === "entry") {
          const e = [trig, ...s.refs.map((r) => byId.get(r))].find((r) => r?.kind === "Endpoint");
          if (e?.kind === "Endpoint")
            claims.push(
              e.pathOrTopic.includes("/")
                ? { kind: "route", value: e.pathOrTopic }
                : { kind: "word", value: e.pathOrTopic },
            );
        } else if (s.to && route)
          claims.push(
            route.includes("/") ? { kind: "route", value: route } : { kind: "word", value: route },
          );
        else if (table) claims.push({ kind: "word", value: table.name.split(".").pop()! });
        else
          for (const x of [
            ...(s.data?.sends ?? []),
            ...(s.data?.returns ?? []),
            ...(s.data?.reads ?? []),
          ])
            claims.push({ kind: "field", value: x });
      }
      const holds =
        claims.length > 0 &&
        lines.length === s.evidence.length &&
        claims.every((c) =>
          lines.some((l) =>
            c.kind === "route"
              ? lineNamesRoute(l, c.value)
              : c.kind === "word"
                ? lineNamesWord(l, c.value)
                : lineNamesField(l, c.value),
          ),
        );
      if (claims.length === 0) unconfirmable++;
      let confirmedBy = s.confirmedBy;
      if (holds) {
        confirmed++;
        // The check is stronger than the AI's pass; a person's review stays.
        if (confirmedBy !== "person") confirmedBy = "check";
      } else if (s.confirmedBy === "check")
        add({
          rule: "check-fails",
          target: `${fid} ${where}`,
          ...(ev ? { evidence: ev } : {}),
          message: claims.length
            ? `${fid} ${where} says the check confirmed it, but its cited lines don't name ${claims.map((c) => c.value).join(", ")}`
            : `${fid} ${where} says the check confirmed it, but it names nothing the check can look for`,
          flow: fid,
        });
      steps.push({ ...s, ...(confirmedBy ? { confirmedBy } : {}) });
    }
    flows.push({ ...f, steps });
  }

  const triggers = specTriggers(o.records, o.repoId, o.template).map((t) => {
    const flow = o.flows.find((f) => f.trigger.ref === t.id || f.family.includes(t.id));
    return { ...t, ...(flow ? { flow: flow.id } : {}) };
  });
  if (!o.perFlowOnly)
    for (const t of triggers.filter((x) => !x.flow))
      add({
        rule: "no-flow",
        target: `trigger ${t.id}`,
        ...(t.evidence ? { evidence: t.evidence } : {}),
        message: `The ${t.kind} ${t.label} (${t.id}) has no flow`,
      });
  return { findings, flows, triggers, confirmed, unconfirmable };
}

/**
 * The flows that cite a file that changed since the spec was drafted (the spec header keeps
 * each cited file's hash), with the files that changed or went.
 */
export async function staleFlows(
  repo: RepoHandle,
  flows: readonly FlowRecord[],
  hashes: Readonly<Record<string, string>>,
): Promise<{ flow: string; files: string[] }[]> {
  const now = new Map<string, string | null>();
  const hashOf = async (p: string) => {
    if (!now.has(p)) {
      const t = await repo.readText(p).catch(() => undefined);
      now.set(p, t === undefined ? null : specFileHash(t));
    }
    return now.get(p)!;
  };
  const out: { flow: string; files: string[] }[] = [];
  for (const f of flows) {
    const changed: string[] = [];
    for (const p of flowFiles(f))
      if (hashes[p] === undefined || (await hashOf(p)) !== hashes[p]) changed.push(p);
    if (changed.length) out.push({ flow: f.id, files: changed });
  }
  return out;
}

/** The hash of each file the flows cite, for the spec header. */
export async function citedFileHashes(
  repo: RepoHandle,
  flows: readonly FlowRecord[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of [...new Set(flows.flatMap(flowFiles))].sort()) {
    const t = await repo.readText(p).catch(() => undefined);
    if (t !== undefined) out[p] = specFileHash(t);
  }
  return out;
}
