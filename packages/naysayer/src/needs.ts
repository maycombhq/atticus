import type { CatalogRecord, ChecklistRule } from "@maycombhq/core";
import { daysBetween, newestEvidence } from "@maycombhq/knowledge";
import type { CriticContext } from "./context.js";
import {
  questionOwner,
  recordEvidence,
  renderQuestion,
  sentence,
  type Evidence,
  type Hit,
} from "./hits.js";
import { hasField, relatedRecords } from "./related.js";
import type { EffectiveRule } from "./rules.js";

type Need = ChecklistRule["needs"][number];

/**
 * No silent passes: every rule declares the catalog facts it depends on (`needs`). For each
 * touched record in the need's scope that the rule examined, the fact must exist (and be
 * fresher than `freshForDays`); when it doesn't, the critic raises a knowledge gap with the
 * rule's owner question instead of passing.
 */

/** Map an examined id onto a need's scope (a component examined means its system, and so on). */
function expand(ctx: CriticContext, id: string, scope: Need["scope"]): string[] {
  const fp = ctx.footprint;
  const r = ctx.byId.get(id);
  const sys = ctx.systemOf(id);
  switch (scope) {
    case "touched-systems":
      if (r?.kind === "Interface")
        return [ctx.systemOf(r.from), ctx.systemOf(r.to)].filter((x): x is string => !!x);
      return sys ? [sys] : [id];
    case "touched-components":
      if (r?.kind === "Component") return [id];
      if (r?.kind === "Interface") return [r.from, r.to];
      if (sys === id) return fp.components.filter((c) => ctx.systemOf(c) === id);
      if (r?.kind === "Table" && r.ownerComponent) return [r.ownerComponent];
      return [];
    case "touched-interfaces":
      if (r?.kind === "Interface") return [id];
      return fp.interfaces
        .map((i) => i.id)
        .filter((i) => {
          const x = ctx.get("Interface", i);
          return !!x && (x.from === id || x.to === id);
        });
    case "touched-data-stores":
      if (r?.kind === "Table" || r?.kind === "DataStore") return [id];
      return [];
  }
}

function scopeSubjects(ctx: CriticContext, scope: Need["scope"]): string[] {
  const fp = ctx.footprint;
  switch (scope) {
    case "touched-systems":
      return fp.systems;
    case "touched-components":
      return fp.components;
    case "touched-interfaces":
      return fp.interfaces.map((i) => i.id);
    case "touched-data-stores":
      return [...fp.dataStores, ...fp.tables];
  }
}

function stale(ctx: CriticContext, r: CatalogRecord, days: number | undefined): string | undefined {
  if (!days) return undefined;
  const seen = newestEvidence(r);
  if (seen && daysBetween(seen, ctx.now) > days) return seen;
  return undefined;
}

export function evaluateNeeds(ctx: CriticContext, rule: EffectiveRule, examined?: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const need of rule.needs) {
    let subjects = scopeSubjects(ctx, need.scope);
    if (examined) {
      const allowed = new Set(examined.flatMap((id) => expand(ctx, id, need.scope)));
      subjects = subjects.filter((s) => allowed.has(s));
    }
    const label = need.field ? `${need.kind} ${need.field}` : need.kind;
    for (const subject of [...new Set(subjects)].sort()) {
      const rec = ctx.byId.get(subject);
      if (need.kind === "Table" || need.kind === "Column") {
        if (rec?.kind !== "Table" && rec?.kind !== "DataStore" && rec?.kind !== need.kind) continue;
      }
      let problem: string | undefined;
      let staleIds: string[] = [];
      if (rec && rec.kind === need.kind) {
        if (need.field && !hasField(rec, need.field))
          problem = `Unknown for ${subject}: its ${need.field}`;
        else {
          const s = stale(ctx, rec, need.freshForDays);
          if (s) {
            problem = `${subject} was last seen ${s.slice(0, 10)}, over ${need.freshForDays} days ago`;
            staleIds = [subject];
          }
        }
      } else if (!rec && need.kind === "System") {
        const owner = need.field === "owner" ? ctx.ownerOf(subject) : undefined;
        if (need.field && need.field !== "owner")
          problem = `Unknown for ${subject}: its ${need.field}`;
        else if (need.field === "owner" && !owner) problem = `Unknown for ${subject}: its owner`;
      } else {
        const related = relatedRecords(ctx, need.kind, subject);
        const withField = need.field ? related.filter((r) => hasField(r, need.field!)) : related;
        if (withField.length === 0)
          problem = `Unknown for ${subject}: ${need.field ? `its ${need.kind} records (${need.field})` : `its ${need.kind} records`}`;
        else if (need.freshForDays) {
          const old = withField.filter((r) => stale(ctx, r, need.freshForDays));
          if (old.length === withField.length) {
            staleIds = old.map((r) => r.id);
            problem = `Every ${label} for ${subject} is older than ${need.freshForDays} days (${staleIds.join(", ")})`;
          }
        }
      }
      if (!problem) continue;
      const ev: Evidence[] = rec ? [recordEvidence(subject)] : [];
      if (!rec) {
        const p = ctx.lifecycle.orgPack.profiles.find((x) =>
          x.profile?.systems.some((s) => s.id === subject),
        );
        if (p) ev.push({ source: "config", path: `org-pack/profiles/${p.platform}/profile.yaml` });
      }
      ev.push({ source: "rule", path: rule.file });
      if (!ev.some((e) => e.record !== undefined || e.path !== undefined)) continue;
      hits.push({
        kind: "knowledge-gap",
        artifact: "catalog",
        locator: { record: subject, ...(need.field ? { field: need.field } : {}) },
        summary: sentence(`${problem}.`),
        why: `Rule ${rule.id} (${rule.title}) depends on ${label} for ${need.scope.replace("touched-", "touched ")}; it is ${staleIds.length ? "stale" : "missing"}, so the critic asks instead of passing.`,
        fix: {
          text: "Answer the owner question; the answer counts once the fact is in the catalog (a scan, or an owner's curated decision).",
        },
        evidence: ev,
        question: {
          text: renderQuestion(need.question, {
            record: subject,
            system: ctx.systemOf(subject) ?? subject,
            kind: need.kind,
            ...(need.field ? { field: need.field } : {}),
          }),
          owner: questionOwner(ctx, subject),
        },
        key: `gap|${subject}|${need.kind}|${need.field ?? ""}`,
        subject,
      });
    }
  }
  return hits;
}
