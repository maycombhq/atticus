import { createHash } from "node:crypto";
import {
  parseRecord,
  type CatalogRecord,
  type ExternalRef as ExternalRefSchema,
  type RecordOf,
} from "@maycombhq/core";
import type { z } from "zod";
import { Tracer, type Capability } from "./detect.js";
import { slugOf } from "./words.js";

/**
 * People name, tag, merge, split and link features (ADR 0031). Each answer is a
 * CuratedDecision written to catalog/curated, the same path `atticus triage decide` and
 * `atticus alias` use, and replayed on every scan:
 * - name, description, owner, tags, links: an assert on the feature (it becomes `asserted`,
 *   with manual evidence naming who);
 * - merge: an alias whose value is the merged features' ids;
 * - split: two membership asserts (`entryPoints`) so both features keep their ids.
 * A person runs the command that writes the decision, so it is the human approval it needs.
 */

export type ExternalRef = z.infer<typeof ExternalRefSchema>;
export type CuratedDecision = RecordOf<"CuratedDecision">;

export class FeatureError extends Error {}

export interface DecisionOptions {
  by: string;
  /** ISO timestamp; default now. */
  at?: string;
  reason?: string;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const short = (f: string) => f.replace(/^feature\./, "");

/** A decision id under the 120-character limit. */
function decisionId(prefix: string, key: string): string {
  const id = `${prefix}.${key}`;
  if (id.length <= 120) return id;
  return `${id.slice(0, 110)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

function decision(
  id: string,
  target: string,
  action: CuratedDecision["action"],
  value: unknown,
  reason: string,
  o: DecisionOptions,
): CuratedDecision {
  const p = parseRecord({
    schemaVersion: 2,
    kind: "CuratedDecision",
    id,
    status: "current",
    confidence: "asserted",
    evidence: [{ source: "manual", by: o.by }],
    target,
    action,
    value,
    reason: o.reason?.trim() || reason,
    by: o.by,
    at: o.at ?? now(),
  });
  if (!p.ok)
    throw new FeatureError(
      `That decision isn't valid: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return p.record as CuratedDecision;
}

/** Confirm or correct a feature's name, and optionally its description and owner. */
export function featureNameDecision(
  feature: Capability,
  o: DecisionOptions & { name: string; description?: string; owner?: string },
): CuratedDecision {
  const name = o.name.trim();
  if (!name) throw new FeatureError("A feature needs a name.");
  const description = o.description?.trim();
  const owner = o.owner?.trim();
  return decision(
    decisionId("feature-name", short(feature.id)),
    feature.id,
    "assert",
    {
      name,
      namedBy: "person",
      ...(description ? { description } : {}),
      ...(owner ? { owner } : {}),
    },
    `${o.by} named ${feature.id} "${name}"`,
    o,
  );
}

const TAG = /^[a-z0-9][a-z0-9-]*$/;

/** Set a feature's tags (the full list). */
export function featureTagDecision(
  feature: Capability,
  tags: string[],
  o: DecisionOptions,
): CuratedDecision {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()))].filter(Boolean).sort();
  const bad = clean.find((t) => !TAG.test(t));
  if (bad) throw new FeatureError(`"${bad}" isn't a tag: use lower-case words joined by "-".`);
  return decision(
    decisionId("feature-tags", short(feature.id)),
    feature.id,
    "assert",
    { tags: clean },
    `${o.by} tagged ${feature.id} ${clean.length ? clean.join(", ") : "with no tags"}`,
    o,
  );
}

/** Merge features into one: an alias whose value is the merged features' ids. */
export function featureMergeDecision(
  into: Capability,
  from: Capability[],
  o: DecisionOptions,
): CuratedDecision {
  const ids = [...new Set(from.map((f) => f.id))].sort();
  if (!ids.length) throw new FeatureError("Name at least one feature to merge.");
  if (ids.includes(into.id))
    throw new FeatureError(`A feature can't be merged into itself (${into.id}).`);
  return decision(
    decisionId("feature-merge", `${short(into.id)}.${ids.map(short).join(".")}`),
    into.id,
    "alias",
    ids,
    `${o.by} merged ${ids.join(", ")} into ${into.id}`,
    o,
  );
}

/**
 * Split entry points off a feature into a new one: one membership assert for the new
 * feature (with its name, if given) and one for what stays, so detection keeps both ids.
 */
export function featureSplitDecisions(
  feature: Capability,
  moved: string[],
  o: DecisionOptions & { into?: string; name?: string; records?: readonly CatalogRecord[] },
): [CuratedDecision, CuratedDecision] {
  const move = [...new Set(moved)];
  const missing = move.filter((m) => !feature.entryPoints.includes(m));
  if (!move.length) throw new FeatureError("Name the entry points to split off.");
  if (missing.length)
    throw new FeatureError(
      `${missing.join(", ")} ${missing.length === 1 ? "isn't an entry point" : "aren't entry points"} of ${feature.id} (it has ${feature.entryPoints.join(", ")}).`,
    );
  const stay = feature.entryPoints.filter((e) => !move.includes(e));
  if (!stay.length)
    throw new FeatureError(
      `That would move every entry point of ${feature.id}; rename it instead.`,
    );
  const name = o.name?.trim();
  let into = o.into;
  if (!into && name)
    into = `feature.${slugOf(
      name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    )}`;
  if (!into && o.records) {
    const tracer = new Tracer(o.records);
    const e = tracer.entryFor(move[0]!);
    if (e) into = `feature.${slugOf(e.resource)}`;
  }
  if (!into) throw new FeatureError("Say what to call the new feature (a name or an id).");
  if (!into.startsWith("feature.")) into = `feature.${into}`;
  if (into === feature.id)
    throw new FeatureError(`The new feature needs an id other than ${feature.id}.`);
  return [
    decision(
      decisionId("feature-split", short(into)),
      into,
      "assert",
      { entryPoints: move, ...(name ? { name, namedBy: "person" } : {}) },
      `${o.by} split ${move.join(", ")} off ${feature.id} into ${into}`,
      o,
    ),
    decision(
      decisionId("feature-members", short(feature.id)),
      feature.id,
      "assert",
      { entryPoints: stay },
      `${o.by} kept ${stay.join(", ")} in ${feature.id}`,
      o,
    ),
  ];
}

const refKey = (r: ExternalRef) => `${r.system}|${r.id}`;

/** Link a work item, wiki page or spec to a feature (the full list of links, so later wins). */
export function featureLinkDecision(
  feature: Capability,
  ref: ExternalRef,
  o: DecisionOptions,
): CuratedDecision {
  const refs = [...feature.externalRefs];
  if (!refs.some((r) => refKey(r) === refKey(ref))) refs.push(ref);
  return decision(
    decisionId(
      "feature-link",
      `${short(feature.id)}.${ref.system}-${slugOf(
        ref.id
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean),
      )}`,
    ),
    feature.id,
    "assert",
    { externalRefs: refs },
    `${o.by} linked ${ref.system} ${ref.id}${ref.title ? ` (${ref.title})` : ""} to ${feature.id}`,
    o,
  );
}

const SYSTEMS = ["ado", "jira", "wiki", "openspec", "other"] as const;

/**
 * A reference as people type it: `ado:4711`, `jira:PAY-12`, `wiki:<page>`, `openspec:<cap>`,
 * or a URL (Azure DevOps and Jira links are recognised; other URLs are wiki pages when they
 * look like one, else "other").
 */
export function parseExternalRef(text: string, title?: string): ExternalRef {
  const t = text.trim();
  const withTitle = (r: ExternalRef): ExternalRef => (title ? { ...r, title } : r);
  const m = /^([a-z]+):(?!\/\/)(.+)$/i.exec(t);
  if (m && (SYSTEMS as readonly string[]).includes(m[1]!.toLowerCase()))
    return withTitle({ system: m[1]!.toLowerCase() as ExternalRef["system"], id: m[2]!.trim() });
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    const ado = /\/_workitems\/edit\/(\d+)/.exec(u.pathname);
    if (ado) return withTitle({ system: "ado", id: ado[1]!, url: t });
    const jira = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname);
    if (jira) return withTitle({ system: "jira", id: jira[1]!, url: t });
    const id = `${u.host}${u.pathname}`.replace(/\/+$/, "");
    const system = /wiki|confluence/i.test(t) ? "wiki" : /openspec/i.test(t) ? "openspec" : "other";
    return withTitle({ system, id, url: t });
  }
  throw new FeatureError(
    `"${text}" isn't a reference Atticus knows: use ado:<id>, jira:<key>, wiki:<page>, openspec:<capability> or a URL.`,
  );
}
