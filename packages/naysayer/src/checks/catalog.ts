import { z } from "zod";
import {
  orgPackRelOf,
  RECORD_KINDS,
  type CatalogRecord,
  type OrgPack,
  type RecordKind,
} from "@maycombhq/core";
import { knowledgeGaps, type KnowledgeGap } from "@maycombhq/knowledge";
import {
  docOf,
  normalizePath,
  readDataChanges,
  readSnowDrafts,
  type SnowDraft,
} from "../artifacts.js";
import type { CriticContext } from "../context.js";
import { contentLines } from "../doc.js";
import {
  lineEvidence,
  questionOwner,
  recordEvidence,
  renderQuestion,
  ruleQuestion,
  sentence,
  type DeterministicCheckDef,
  type Evidence,
  type Hit,
} from "../hits.js";
import { matchesWhere, relatedRecords } from "../related.js";
import { matchServiceRequestTriggers, triggerReason } from "../snow-triggers.js";

/** Evidence for a catalog record: the record, plus the first file it was read from. */
function catalogEvidence(ctx: CriticContext, id: string): Evidence[] {
  const r = ctx.byId.get(id);
  if (!r) return [];
  const file = r.evidence.find((e) => e.path);
  return [
    recordEvidence(id),
    ...(file
      ? [
          {
            source: file.source,
            path: file.path!,
            ...(file.repo ? { repo: file.repo } : {}),
            ...(file.line ? { line: file.line } : {}),
          } satisfies Evidence,
        ]
      : []),
  ];
}

/** Evidence for a subject that may be known only from the platform profile. */
function subjectEvidence(ctx: CriticContext, id: string): Evidence[] {
  const ev = catalogEvidence(ctx, id);
  if (ev.length) return ev;
  const p = ctx.lifecycle.orgPack.profiles.find((x) => x.profile?.systems.some((s) => s.id === id));
  return p ? [{ source: "config", path: `org-pack/profiles/${p.platform}/profile.yaml` }] : [];
}

export const observabilityPresent: DeterministicCheckDef = {
  id: "observability-present",
  question: "ship",
  description:
    "Touched components have the observability assets the rule asks for (alerts, dashboards); unknown ones are asked about.",
  params: z.strictObject({ assetKinds: z.array(z.string()).min(1) }),
  run(ctx, p, rule) {
    const kinds = p.assetKinds as string[];
    const hits: Hit[] = [];
    const subjects: string[] = [];
    const design = docOf(ctx.files, "design.md");
    for (const id of ctx.footprint.components) {
      const c = ctx.get("Component", id);
      if (!c || ctx.boundaryOf(c.system) === "vendor") continue;
      const assets = ctx.records.filter(
        (r) => r.kind === "ObservabilityAsset" && r.component === id && kinds.includes(r.assetKind),
      );
      const planned =
        design &&
        contentLines(design).some(
          (l) =>
            l.text.toLowerCase().includes(id) &&
            kinds.some((k) => l.text.toLowerCase().includes(k)),
        );
      // A component whose asset the change plans no longer depends on the catalog fact.
      if (planned) continue;
      subjects.push(id);
      if (assets.length) continue;
      const template =
        ruleQuestion(rule, "ObservabilityAsset") ??
        `What ${kinds.join(" or ")} exist for \${record}?`;
      hits.push({
        kind: "knowledge-gap",
        artifact: "catalog",
        locator: { record: id },
        summary: sentence(
          `No ${kinds.join(" or ")} is known for ${id}, and the change doesn't plan one.`,
        ),
        why: `Rule ${rule.id} needs the component's ${kinds.join(" and ")} to judge whether a failure would be noticed; the catalog has none, so the critic asks instead of passing.`,
        fix: {
          text: `Answer the question, or plan the ${kinds[0]} in design.md under Non-functional design.`,
        },
        evidence: subjectEvidence(ctx, id),
        question: {
          text: renderQuestion(template, { record: id, system: c.system }),
          owner: questionOwner(ctx, id),
        },
        key: `gap|${id}|ObservabilityAsset|`,
        subject: id,
      });
    }
    return { hits, subjects };
  },
};

const gapCache = new WeakMap<CriticContext, KnowledgeGap[]>();

function gapsFor(ctx: CriticContext): KnowledgeGap[] {
  let g = gapCache.get(ctx);
  if (!g) {
    g = knowledgeGaps({
      records: ctx.records,
      orgPack: ctx.lifecycle.orgPack as OrgPack,
      now: ctx.now,
    });
    gapCache.set(ctx, g);
  }
  return g;
}

export const knowledgeCheck: DeterministicCheckDef = {
  id: "knowledge-check",
  question: "true",
  description:
    "Runs one of the catalog's knowledge checks (@maycombhq/knowledge) and keeps the gaps about what the change touches.",
  params: z.strictObject({ check: z.string() }),
  run(ctx, p) {
    const fp = ctx.footprint;
    const touched = new Set([...fp.components, ...fp.systems, ...fp.interfaces.map((i) => i.id)]);
    const isTouched = (id: string) => {
      if (touched.has(id)) return true;
      const i = ctx.get("Interface", id);
      return !!i && touched.has(i.from) && touched.has(i.to);
    };
    const hits: Hit[] = [];
    for (const g of gapsFor(ctx)) {
      if (g.check !== p.check || !g.records.every(isTouched)) continue;
      const subject = g.records[0]!;
      const owner = g.owner === "unassigned" ? (g.routeTo ?? "architect") : g.owner;
      hits.push({
        kind: "knowledge-gap",
        artifact: "catalog",
        locator: { record: subject },
        summary: sentence(`Unknown: ${g.question.neededFact}.`),
        why: `The change touches ${subject}, and the catalog can't say this about it, so checks that depend on it can't pass.${g.stale?.length ? ` Stale: ${g.stale.join(", ")}.` : ""}`,
        // ADR 0021 addendum: when the fact is one a person writes in the org pack (a system's owner), the
        // fix names that file and field, so the answer has somewhere to go.
        fix: {
          text: g.fill?.length
            ? `Write it in ${g.fill.map((f) => `${orgPackRelOf(ctx.root)}/${f.file}: ${f.field} (${f.what})`).join("; ")}, in a pull request. Answering the owner question doesn't close the gap on its own: the answer counts once the fact is in the catalog.`
            : "Answer the owner question; the answer counts once the fact is in the catalog.",
        },
        evidence: catalogEvidence(ctx, subject),
        question: { text: g.question.question, owner },
        key: `gap|${subject}|knowledge|${g.check}`,
        subject,
      });
    }
    const subjects = [...fp.components, ...fp.systems].filter((id) => {
      const sys = ctx.systemOf(id);
      return !sys || ctx.boundaryOf(sys) !== "vendor";
    });
    return { hits, subjects };
  },
};

const Scope = z.enum([
  "touched-systems",
  "touched-components",
  "touched-interfaces",
  "touched-data-stores",
  "touched-vendors",
]);

export function scopeIds(ctx: CriticContext, scope: z.infer<typeof Scope>): string[] {
  const fp = ctx.footprint;
  switch (scope) {
    case "touched-systems":
      return fp.systems;
    case "touched-components":
      return fp.components;
    case "touched-interfaces":
      return fp.interfaces.map((i) => i.id);
    case "touched-data-stores":
      return fp.dataStores;
    case "touched-vendors":
      return fp.vendors;
  }
}

export const factKnown: DeterministicCheckDef = {
  id: "fact-known",
  question: "complete",
  description:
    "A catalog fact of one kind (optionally with given field values) exists for each touched record in scope; when it doesn't, the owner is asked.",
  params: z.strictObject({
    kind: z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]),
    where: z.record(z.string(), z.string()).default({}),
    scope: Scope,
    boundary: z.array(z.enum(["product", "internal", "vendor"])).optional(),
    question: z.string().min(1),
  }),
  run(ctx, p, rule) {
    const kind = p.kind as RecordKind;
    const where = (p.where as Record<string, string>) ?? {};
    const boundary = p.boundary as string[] | undefined;
    const subjects = scopeIds(ctx, p.scope as z.infer<typeof Scope>).filter((id) => {
      if (!boundary) return true;
      const sys = ctx.systemOf(id);
      const b = sys ? ctx.boundaryOf(sys) : undefined;
      return b !== undefined && boundary.includes(b);
    });
    const label = `${kind}${
      Object.keys(where).length
        ? ` (${Object.entries(where)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})`
        : ""
    }`;
    const hits: Hit[] = [];
    for (const id of subjects) {
      const found = relatedRecords(ctx, kind, id).filter((r: CatalogRecord) =>
        matchesWhere(r, where),
      );
      if (found.length) continue;
      hits.push({
        kind: "knowledge-gap",
        artifact: "catalog",
        locator: { record: id },
        summary: sentence(`The catalog has no ${label} for ${id}.`),
        why: `Rule ${rule.id} (${rule.title}) depends on this fact for every touched record in scope; it is missing, so the critic asks instead of passing.`,
        fix: {
          text: "Answer the owner question; the answer counts once it is in the catalog (a scan, or an owner's curated decision).",
        },
        evidence: subjectEvidence(ctx, id),
        question: {
          text: renderQuestion(p.question as string, {
            record: id,
            system: ctx.systemOf(id) ?? id,
            kind,
          }),
          owner: questionOwner(ctx, id),
        },
        key: `gap|${id}|${kind}|${JSON.stringify(where)}`,
        subject: id,
      });
    }
    return { hits, subjects };
  },
};

export const vendorOperationKnown: DeterministicCheckDef = {
  id: "vendor-operation-known",
  question: "true",
  description:
    "Each new or changed call to a vendor uses an operation in the vendor's published spec (as read into the catalog).",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, "interfaces.md");
    const hits: Hit[] = [];
    const subjects = new Set<string>();
    if (!doc) return { hits, subjects: [] };
    for (const h of ctx.hops) {
      if (h.status !== "planned-new" && h.status !== "planned-modify") continue;
      const sys = ctx.systemOf(h.callee);
      if (!sys || ctx.boundaryOf(sys) !== "vendor" || !h.method || !h.path) continue;
      subjects.add(sys);
      const want = normalizePath(h.path);
      const found = ctx.records.some(
        (r) =>
          r.kind === "Endpoint" &&
          (r.component === h.callee || ctx.systemOf(r.component) === sys || r.component === sys) &&
          (r.method ?? "").toUpperCase() === h.method &&
          normalizePath(r.normalizedPath ?? r.pathOrTopic) === want,
      );
      if (found) continue;
      const name = ctx.get("System", sys)?.name ?? sys;
      hits.push({
        kind: "knowledge-gap",
        artifact: "interfaces.md",
        locator: { line: h.line, record: sys },
        summary: sentence(`${name}'s published spec has no ${h.method} ${h.path}.`),
        why: "The change plans a call to a vendor operation the catalog has never seen in the vendor's spec, so its contract, limits and errors are unknown.",
        fix: {
          text: `Get the operation's spec from ${name} and add it to inputs/partner-specs, or correct the operation.`,
        },
        evidence: [lineEvidence(doc, h.line), ...subjectEvidence(ctx, sys)],
        question: {
          text: `Does ${name} offer ${h.method} ${h.path}? Its published spec in the catalog has no such operation; please share the spec or the right operation.`,
          owner: questionOwner(ctx, sys),
        },
        key: `gap|${sys}|Endpoint|${h.method} ${want}`,
        subject: sys,
      });
    }
    return { hits, subjects: [...subjects] };
  },
};

// ------------------------------------------------------------------ service-desk drafts

/** A template name inside a sentence: "Network firewall rule" → "network firewall rule". */
const title = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface Need {
  template: OrgPack["serviceRequests"][number];
  record: string;
  why: string;
  evidence: Evidence[];
}

export const snowDraftsPresent: DeterministicCheckDef = {
  id: "snow-drafts-present",
  question: "ship",
  description:
    "Each catalog change that triggers an org-pack service-desk template (and each template it also needs) has a draft in snow.md with its required fields filled.",
  params: z.strictObject({}),
  run(ctx) {
    const templates = ctx.lifecycle.orgPack.serviceRequests;
    const ifaces = docOf(ctx.files, "interfaces.md");
    const data = docOf(ctx.files, "data.md");
    const needs: Need[] = [];
    const add = (n: Need) => {
      if (!needs.some((x) => x.template.id === n.template.id && x.record === n.record))
        needs.push(n);
    };
    for (const m of matchServiceRequestTriggers({
      templates,
      hops: ifaces ? ctx.hops : [],
      data: data ? readDataChanges(ctx.files) : [],
      files: ctx.files,
      patterns: ctx.patterns,
      get: (kind, id) => ctx.get(kind, id),
    })) {
      // A route a hop names is shown where the interface notes mention it.
      const note =
        m.trigger.kind === "GatewayRoute" && ifaces
          ? contentLines(ifaces).find((l) => l.text.toLowerCase().includes(m.record))?.n
          : undefined;
      const doc = m.file === "data.md" ? data! : ifaces!;
      const rule = {
        source: "rule" as const,
        path: `org-pack/process/snow/${(m.alongside ?? m.template).id}.yaml`,
      };
      add({
        template: m.template,
        record: m.record,
        why: m.alongside
          ? `the ${title(m.alongside.name)} for ${m.record} also needs a ${title(m.template.name)}`
          : triggerReason(m.record, m.trigger),
        evidence: [lineEvidence(doc, note ?? m.line), rule],
      });
    }
    const hits: Hit[] = [];
    if (needs.length === 0) return { hits, subjects: [] };
    const doc = docOf(ctx.files, "snow.md");
    const drafts = readSnowDrafts(ctx.files);
    const top = doc?.sections[0];
    for (const n of needs) {
      const names = [n.template.name, n.template.requestType, n.template.id].map((s) =>
        s.toLowerCase(),
      );
      const candidates = drafts.filter((d) =>
        names.some((x) => d.heading.toLowerCase().includes(x)),
      );
      const forRecord = candidates.filter((d) => d.text.toLowerCase().includes(n.record));
      const draft: SnowDraft | undefined =
        forRecord[0] ??
        (needs.filter((x) => x.template.id === n.template.id).length === 1
          ? candidates[0]
          : undefined);
      if (!draft) {
        hits.push({
          kind: "issue",
          artifact: "snow.md",
          locator: top
            ? { line: top.line, heading: top.heading }
            : { heading: "Service-desk requests" },
          summary: sentence(`No ${title(n.template.name)} draft in snow.md for ${n.record}.`),
          why: `${n.why}, so the ${title(n.template.requestType)} request (lead time ${n.template.leadTimeDays} days, approved by ${n.template.approvers.join(", ") || "the service desk"}) must be drafted before the change can go live.`,
          fix: {
            text: `Add "## ${n.template.requestType}" to snow.md with ${n.template.fields
              .filter((f) => f.required)
              .map((f) => f.name)
              .join(", ")} filled, and the task it unblocks.`,
          },
          evidence: [...(doc && top ? [lineEvidence(doc, top.line)] : []), ...n.evidence],
          key: `snow|${n.template.id}|${n.record}`,
        });
        continue;
      }
      const empty = n.template.fields
        .filter((f) => f.required)
        .filter((f) => !(draft.fields.get(f.name.toLowerCase())?.value ?? "").trim());
      if (!empty.length || !doc) continue;
      const first = draft.fields.get(empty[0]!.name.toLowerCase());
      const line = first?.line ?? draft.line;
      hits.push({
        kind: "issue",
        artifact: "snow.md",
        locator: { line, heading: draft.heading, field: empty[0]!.name },
        summary: sentence(
          `The ${title(n.template.name)} draft for ${n.record} leaves ${empty.map((f) => f.name).join(", ")} empty.`,
        ),
        why: `The ${title(n.template.requestType)} template requires ${empty.map((f) => f.name).join(", ")}; the service desk sends back a request without ${empty.length > 1 ? "them" : "it"}.`,
        fix: {
          text: `Fill ${empty.map((f) => f.name).join(", ")} from the catalog and the design.`,
        },
        evidence: [
          lineEvidence(doc, line),
          { source: "rule", path: `org-pack/process/snow/${n.template.id}.yaml` },
        ],
        key: `snow-field|${n.template.id}|${n.record}`,
      });
    }
    return { hits, subjects: [] };
  },
};
