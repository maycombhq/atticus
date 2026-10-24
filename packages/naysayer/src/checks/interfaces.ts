import { z } from "zod";
import type { IntegrationPattern, RecordOf } from "@maycombhq/core";
import { docOf, hopNotes, hopRoutes, type Hop } from "../artifacts.js";
import type { CriticContext } from "../context.js";
import { contentLines, headingAt, type Doc } from "../doc.js";
import {
  lineEvidence,
  recordEvidence,
  sentence,
  type CheckResult,
  type DeterministicCheckDef,
  type Evidence,
  type Hit,
} from "../hits.js";
import { linePatch } from "../patch.js";

const IFACES = "interfaces.md";

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/** The registry code a typo most likely meant: the single closest code within two edits. */
export function nearestCode(code: string, codes: string[]): string | undefined {
  const scored = codes.map((c) => ({ c, d: levenshtein(code.toUpperCase(), c.toUpperCase()) }));
  const best = Math.min(...scored.map((s) => s.d));
  const at = scored.filter((s) => s.d === best);
  return best <= 2 && at.length === 1 ? at[0]!.c : undefined;
}

const noPattern = (code: string) => code === "" || /^none\b/i.test(code) || code === "-";

const hopName = (h: Hop) =>
  `${h.caller || "?"} → ${h.callee || "?"} (${h.operation || "no operation"})`;

export function rowLocator(doc: Doc, line: number) {
  const heading = headingAt(doc, line);
  return { line, ...(heading ? { heading } : {}) };
}

interface PatternProblemOpts {
  missing: boolean;
  unknown: boolean;
  statuses?: string[];
}

function patternProblems(ctx: CriticContext, o: PatternProblemOpts): Hit[] {
  const doc = docOf(ctx.files, IFACES);
  if (!doc) return [];
  const hits: Hit[] = [];
  const codes = [...ctx.patterns.keys()].sort();
  for (const h of ctx.hops) {
    if (h.status === "planned-retire") continue;
    const ev = [lineEvidence(doc, h.line)];
    const key = `pattern|${IFACES}|${h.line}`;
    if (noPattern(h.pattern)) {
      if (!o.missing) continue;
      hits.push({
        kind: "issue",
        artifact: IFACES,
        locator: { ...rowLocator(doc, h.line), field: "pattern" },
        summary: sentence(`The hop ${hopName(h)} names no integration pattern.`),
        why: "Without a pattern code the hop's controls (auth, timeouts, retries) can't be checked, and the diagram can't be reconciled.",
        fix: {
          text: `Pick the pattern from the registry (${codes.join(", ")}) that fits this hop. If none fits, write "none fits" with the reason and ask the architect to register one.`,
        },
        evidence: ev,
        key,
      });
      continue;
    }
    const p = ctx.patterns.get(h.pattern);
    if (!p) {
      if (!o.unknown) continue;
      const near = nearestCode(h.pattern, codes);
      const line = doc.lines[h.line - 1]!;
      const patch =
        near && line.includes(h.pattern)
          ? linePatch(IFACES, doc.raw, h.line, h.line, [line.replace(h.pattern, near)])
          : undefined;
      hits.push({
        kind: "issue",
        artifact: IFACES,
        locator: { ...rowLocator(doc, h.line), field: "pattern" },
        summary: sentence(
          `The hop ${hopName(h)} names pattern ${h.pattern}, which is not in the pattern registry${near ? ` (did you mean ${near}?)` : ""}.`,
        ),
        why: "A code outside the registry has no defined controls, so nothing about the hop can be checked; it is usually a typo.",
        fix: {
          text: near ? `Use ${near}.` : `Use a code from the registry: ${codes.join(", ")}.`,
          ...(patch ? { patch } : {}),
        },
        evidence: ev,
        key,
      });
      continue;
    }
    if (o.statuses && !o.statuses.includes(p.status)) {
      hits.push({
        kind: "issue",
        artifact: IFACES,
        locator: { ...rowLocator(doc, h.line), field: "pattern" },
        summary: sentence(
          `The hop ${hopName(h)} uses pattern ${p.code}, which is ${p.status}, not approved.`,
        ),
        why: `Only patterns with status ${o.statuses.join(" or ")} are approved for new work.`,
        fix: {
          text: `Use an approved pattern, or get ${p.code} confirmed by the pattern owner first.`,
        },
        evidence: [...ev, { source: "rule", path: `org-pack/patterns/${p.code}.yaml` }],
        key,
      });
    }
  }
  return hits;
}

const Statuses = z.strictObject({ statuses: z.array(z.string()).optional() });

export const interfacePatternApproved: DeterministicCheckDef = {
  id: "interface-pattern-approved",
  question: "safe",
  description:
    "Every hop in interfaces.md names a pattern that is in the registry with an approved status.",
  params: Statuses,
  run: (ctx, p) => ({
    hits: patternProblems(ctx, {
      missing: true,
      unknown: true,
      statuses: (p.statuses as string[] | undefined) ?? ["confirmed"],
    }),
    subjects: [],
  }),
};

export const patternCodeInRegistry: DeterministicCheckDef = {
  id: "pattern-code-in-registry",
  question: "true",
  description: "Every pattern code in interfaces.md is in the registry.",
  params: Statuses,
  run: (ctx, p) => ({
    hits: patternProblems(ctx, {
      missing: false,
      unknown: true,
      ...(p.statuses ? { statuses: p.statuses as string[] } : {}),
    }),
    subjects: [],
  }),
};

export const interfaceHasPattern: DeterministicCheckDef = {
  id: "interface-has-pattern",
  question: "complete",
  description: "Every hop in interfaces.md names a pattern code.",
  params: z.strictObject({}),
  run: (ctx) => ({ hits: patternProblems(ctx, { missing: true, unknown: false }), subjects: [] }),
};

export const interfaceEndsInCatalog: DeterministicCheckDef = {
  id: "interface-ends-in-catalog",
  question: "true",
  description:
    "Every caller and callee in interfaces.md is a component or system the catalog knows.",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, IFACES);
    if (!doc) return { hits: [], subjects: [] };
    const hits: Hit[] = [];
    for (const h of ctx.hops) {
      for (const [role, end] of [
        ["caller", h.caller],
        ["callee", h.callee],
      ] as const) {
        if (!end || ctx.isKnown(end)) continue;
        hits.push({
          kind: "issue",
          artifact: IFACES,
          locator: { ...rowLocator(doc, h.line), field: role },
          summary: sentence(
            `The ${role} ${end} of ${h.operation || "a hop"} is not in the catalog.`,
          ),
          why: "A planned interface to a system the catalog doesn't know can't be checked for ownership, patterns or impact; it is a typo or a system nobody has scanned.",
          fix: {
            text: `Correct the name to a catalog id, or get ${end} into the catalog first (scan its repo, or add it to the platform profile with its owner).`,
          },
          evidence: [lineEvidence(doc, h.line)],
          key: `ends|${h.line}|${end}`,
        });
      }
    }
    return { hits, subjects: [] };
  },
};

export const interfaceIdsInCatalog: DeterministicCheckDef = {
  id: "interface-ids-in-catalog",
  question: "true",
  description:
    "Rows for existing hops use their catalog interface id; rows for new hops say new and planned-new.",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, IFACES);
    if (!doc) return { hits: [], subjects: [] };
    const hits: Hit[] = [];
    const add = (h: Hop, summary: string, why: string, fix: string, extra: Evidence[] = []) =>
      hits.push({
        kind: "issue",
        artifact: IFACES,
        locator: { ...rowLocator(doc, h.line), field: "interface id" },
        summary: sentence(summary),
        why,
        fix: { text: fix },
        evidence: [lineEvidence(doc, h.line), ...extra],
        key: `ifid|${h.line}`,
      });
    for (const h of ctx.hops) {
      if (!h.id) {
        add(
          h,
          `The hop ${hopName(h)} has no interface id.`,
          "Every row says which catalog interface it changes, or new.",
          "Write the catalog interface id, or new for a new hop.",
        );
        continue;
      }
      if (h.id === "new") {
        if (h.status !== "planned-new")
          add(
            h,
            `The new hop ${hopName(h)} has status ${h.status || "(none)"}, not planned-new.`,
            "A hop that isn't in the catalog yet can only be planned-new.",
            "Set the status to planned-new, or use the existing interface's id.",
          );
        continue;
      }
      const rec = ctx.get("Interface", h.id);
      if (!rec) {
        add(
          h,
          `Interface ${h.id} is not in the catalog.`,
          "An existing hop keeps its catalog id; an unknown id is a typo or a stale copy.",
          "Use the id from the catalog (atticus query), or new for a new hop.",
        );
        continue;
      }
      if ((h.caller && rec.from !== h.caller) || (h.callee && rec.to !== h.callee))
        add(
          h,
          `Interface ${h.id} is ${rec.from} → ${rec.to} in the catalog, but the row says ${h.caller} → ${h.callee}.`,
          "The row and the catalog disagree about which hop this is.",
          "Fix the caller and callee, or the interface id.",
          [recordEvidence(h.id)],
        );
      else if (h.status === "planned-new")
        add(
          h,
          `Interface ${h.id} already exists, so it can't be planned-new.`,
          "An existing hop is planned-modify or planned-retire.",
          "Set the status to planned-modify or planned-retire.",
          [recordEvidence(h.id)],
        );
    }
    return { hits, subjects: [] };
  },
};

// ------------------------------------------------------------------ resilience

export type SettingKind = "timeout" | "retry" | "circuit-breaker";

export const KIND_WORDS: Record<SettingKind, RegExp> = {
  timeout: /time[- ]?outs?\b/i,
  retry: /\bretr(y|ies|ied)\b/i,
  "circuit-breaker": /circuit[- ]?breakers?\b/i,
};

/** The resilience settings a pattern's controls and defaults call for. */
export function patternSettingKinds(p: IntegrationPattern): SettingKind[] {
  const text = p.controls.join(", ").toLowerCase();
  const out: SettingKind[] = [];
  if (/time[- ]?out/.test(text) || p.resilience.timeoutMs !== undefined) out.push("timeout");
  if (/retr(y|ies)/.test(text) || p.resilience.retries !== undefined) out.push("retry");
  if (/circuit[- ]?breaker/.test(text) || p.resilience.circuitBreaker) out.push("circuit-breaker");
  return out;
}

export interface Call {
  caller: string;
  callee: string;
  operation: string;
  pattern?: IntegrationPattern;
  via?: string;
  hop?: Hop;
  record?: RecordOf<"Interface">;
}

/** Hops from interfaces.md plus touched catalog interfaces that have no row. */
export function calls(ctx: CriticContext): Call[] {
  const out: Call[] = [];
  const rowIds = new Set(ctx.hops.map((h) => h.id));
  for (const h of ctx.hops) {
    if (h.status === "planned-retire") continue;
    const p = ctx.patterns.get(h.pattern);
    const rec = h.id.startsWith("if-") ? ctx.get("Interface", h.id) : undefined;
    out.push({
      caller: h.caller,
      callee: h.callee,
      operation: h.operation,
      ...(p ? { pattern: p } : {}),
      ...(p ? { via: p.route } : rec ? { via: rec.via } : {}),
      hop: h,
      ...(rec ? { record: rec } : {}),
    });
  }
  for (const t of ctx.footprint.interfaces) {
    if (rowIds.has(t.id) || t.status === "planned-retire") continue;
    const rec = ctx.get("Interface", t.id);
    if (!rec) continue;
    const p = rec.pattern ? ctx.patterns.get(rec.pattern.code) : undefined;
    out.push({
      caller: rec.from,
      callee: rec.to,
      operation: `${rec.method ?? ""} ${rec.normalizedPath}`.trim(),
      ...(p ? { pattern: p } : {}),
      via: rec.via,
      record: rec,
    });
  }
  return out;
}

/** Lines that talk about a call: its notes in interfaces.md and design.md lines naming the callee or path. */
export function callLines(ctx: CriticContext, c: Call): { doc: Doc; n: number; text: string }[] {
  const out: { doc: Doc; n: number; text: string }[] = [];
  const ifaces = docOf(ctx.files, IFACES);
  if (ifaces && c.hop) for (const l of hopNotes(ctx.files, c.hop)) out.push({ doc: ifaces, ...l });
  const design = docOf(ctx.files, "design.md");
  if (design) {
    const names = [...ctx.namesOf(c.callee), ...(c.hop?.path ? [c.hop.path.toLowerCase()] : [])];
    for (const l of contentLines(design))
      if (names.some((n) => l.text.toLowerCase().includes(n))) out.push({ doc: design, ...l });
  }
  return out;
}

const say = (k: SettingKind) => k.replace("-", " ");

export const settingsPresent: DeterministicCheckDef = {
  id: "settings-present",
  question: "safe",
  description:
    "Planned calls have the resilience settings their pattern (or the rule) requires, in the catalog or stated in interfaces.md or design.md.",
  params: z.strictObject({
    settingKinds: z.array(z.enum(["timeout", "retry", "circuit-breaker"])).optional(),
    forVia: z.array(z.string()).optional(),
    forBoundary: z.string().optional(),
    fromPattern: z.boolean().optional(),
  }),
  run(ctx, p): CheckResult {
    const hits: Hit[] = [];
    const subjects = new Set<string>();
    const ifaces = docOf(ctx.files, IFACES);
    for (const c of calls(ctx)) {
      const calleeSystem = ctx.systemOf(c.callee);
      const boundary = calleeSystem ? ctx.boundaryOf(calleeSystem) : undefined;
      if (p.forBoundary && boundary !== p.forBoundary) continue;
      const forVia = p.forVia as string[] | undefined;
      if (forVia && (!c.via || !forVia.includes(c.via))) continue;
      let kinds: SettingKind[];
      if (p.fromPattern) {
        if (!c.pattern) continue;
        kinds = patternSettingKinds(c.pattern);
      } else kinds = (p.settingKinds as SettingKind[] | undefined) ?? ["timeout", "retry"];
      if (kinds.length === 0) continue;
      if (ctx.get("Component", c.caller)) subjects.add(c.caller);
      const targets = new Set([c.callee, calleeSystem].filter(Boolean));
      const settings = ctx.records.filter(
        (r): r is RecordOf<"Setting"> =>
          r.kind === "Setting" &&
          r.component === c.caller &&
          r.target !== undefined &&
          targets.has(r.target),
      );
      const lines = callLines(ctx, c);
      const missing = kinds.filter(
        (k) =>
          !settings.some((s) => s.settingKind === k) &&
          !lines.some((l) => KIND_WORDS[k].test(l.text)),
      );
      if (!missing.length) continue;
      const code = c.pattern?.code;
      const requires = p.fromPattern
        ? `pattern ${code} requires ${kinds.map(say).join(", ")} (${c.pattern!.controls.join(", ")})`
        : `this rule requires ${kinds.join(" and ")}${p.forBoundary ? ` for calls to ${p.forBoundary} systems` : ""}`;
      const ev: Evidence[] = [];
      let artifact = "catalog";
      let locator: Hit["locator"] = { record: c.record?.id ?? c.caller };
      if (c.hop && ifaces) {
        artifact = IFACES;
        locator = { ...rowLocator(ifaces, c.hop.line), field: "notes" };
        ev.push(lineEvidence(ifaces, c.hop.line));
        for (const l of lines.slice(0, 2)) ev.push(lineEvidence(l.doc, l.n));
      } else if (c.record) ev.push(recordEvidence(c.record.id));
      if (code) ev.push({ source: "rule", path: `org-pack/patterns/${code}.yaml` });
      const defaults = c.pattern
        ? [
            c.pattern.resilience.timeoutMs !== undefined
              ? `timeout ${c.pattern.resilience.timeoutMs} ms`
              : "",
            c.pattern.resilience.retries !== undefined
              ? `${c.pattern.resilience.retries} retries`
              : "",
            c.pattern.resilience.circuitBreaker ? "a circuit breaker" : "",
          ].filter(Boolean)
        : [];
      hits.push({
        kind: "issue",
        artifact,
        locator,
        summary: sentence(
          `The call from ${c.caller} to ${c.callee} (${c.operation}) states no ${missing.map(say).join(" or ")}; ${p.fromPattern ? `pattern ${code}` : "the rule"} requires ${missing.length > 1 ? "them" : "it"}.`,
        ),
        why: `Nothing in the catalog or the change says how this call behaves when ${c.callee} is slow or down: ${requires}.`,
        fix: {
          text: `State the ${missing.map(say).join(" and ")} for this call in the Notes of interfaces.md (or under Non-functional design in design.md)${defaults.length ? `; the pattern's defaults are ${defaults.join(", ")}` : ""}.`,
        },
        evidence: ev,
        key: `resilience|${artifact}|${c.hop?.line ?? c.record?.id}`,
      });
    }
    return { hits, subjects: [...subjects].sort() };
  },
};

export const interfaceViaMatchesPattern: DeterministicCheckDef = {
  id: "interface-via-matches-pattern",
  question: "safe",
  description:
    "Hops governed by a pattern take the route it requires (for a gateway pattern, they name the gateway route).",
  params: z.strictObject({ pattern: z.string(), via: z.string() }),
  run(ctx, p): CheckResult {
    const hits: Hit[] = [];
    const subjects: string[] = [];
    const pattern = ctx.patterns.get(p.pattern as string);
    const want = p.via as string;
    const target = pattern?.detection.targetBoundary;
    const doc = docOf(ctx.files, IFACES);
    const governs = (code: string | undefined, callee: string) => {
      if (code === p.pattern) return true;
      const sys = ctx.systemOf(callee);
      return target !== undefined && sys !== undefined && ctx.boundaryOf(sys) === target;
    };
    if (doc)
      for (const h of ctx.hops) {
        if (h.status === "planned-retire" || !governs(h.pattern, h.callee)) continue;
        const own = ctx.patterns.get(h.pattern);
        if (own && own.route !== want) {
          hits.push({
            kind: "issue",
            artifact: IFACES,
            locator: { ...rowLocator(doc, h.line), field: "pattern" },
            summary: sentence(
              `The hop ${hopName(h)} uses ${own.code} (route ${own.route}), but ${p.pattern} requires the ${want}.`,
            ),
            why: `Calls of this kind must go via the ${want}, where the pattern's controls are enforced.`,
            fix: { text: `Route the call via the ${want} and use ${p.pattern}.` },
            evidence: [
              lineEvidence(doc, h.line),
              { source: "rule", path: `org-pack/patterns/${p.pattern}.yaml` },
            ],
            key: `via|${h.line}`,
          });
          continue;
        }
        if (want === "gateway" && hopRoutes(ctx.files, h).length === 0)
          hits.push({
            kind: "issue",
            artifact: IFACES,
            locator: { ...rowLocator(doc, h.line), field: "notes" },
            summary: sentence(
              `The hop ${hopName(h)} goes via the gateway but names no gateway route.`,
            ),
            why: "A hop through the gateway names the gateway route, so the route (or the request for a new one) can be checked.",
            fix: {
              text: "Name the gateway route (gw-…) in the hop's note in interfaces.md, or say a new one is needed.",
            },
            evidence: [lineEvidence(doc, h.line)],
            key: `via|${h.line}`,
          });
      }
    for (const t of ctx.footprint.interfaces) {
      const rec = ctx.get("Interface", t.id);
      if (!rec || t.status === "planned-retire" || !governs(rec.pattern?.code, rec.to)) continue;
      subjects.push(rec.id);
      if (rec.via === want) continue;
      hits.push({
        kind: "issue",
        artifact: "catalog",
        locator: { record: rec.id, field: "via" },
        summary: sentence(
          `Interface ${rec.id} (${rec.from} → ${rec.to}) goes ${rec.via} in the code, but ${p.pattern} requires the ${want}.`,
        ),
        why: "The code takes a route the pattern doesn't allow, and this change touches that hop.",
        fix: {
          text: `Move the call behind the ${want} as part of this change, or record why not.`,
        },
        evidence: [
          recordEvidence(rec.id),
          ...rec.evidence
            .filter((e) => e.path)
            .slice(0, 1)
            .map((e): Evidence => ({
              source: e.source,
              path: e.path!,
              ...(e.repo ? { repo: e.repo } : {}),
              ...(e.line ? { line: e.line } : {}),
            })),
        ],
        key: `via|${rec.id}`,
      });
    }
    return { hits, subjects };
  },
};
