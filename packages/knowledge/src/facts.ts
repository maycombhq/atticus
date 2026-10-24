import { parseRecord, type CatalogRecord, type RecordOf } from "@maycombhq/core";
import { REACHES_SPEC, settle, verdictOf, type AiRuntime, type JudgeItem } from "@maycombhq/ai";
import type { ProfileSystem } from "@maycombhq/reconcile";
import type { JudgmentStore } from "@maycombhq/core";
import { sentences } from "./markdown.js";
import { mentionIndex, type Mention } from "./mentions.js";
import type { KnowledgePage } from "./sources.js";

/**
 * Facts read from wiki text, compared with the catalog. Code wins: a claim that contradicts a
 * fact read from code is a conflict for triage, never a change to the catalog. A fact only a
 * document gives is proposed as an inferred record that waits for an owner to confirm it.
 *
 * What is a format is read as one: an owner line, a service level ("99.9% availability"), a peak
 * load. How one system reaches another is a judgment (ADR 0117 addendum, `reaches`): which two
 * systems a sentence names is the mention index's fact, and whether it says the one calls the
 * other through the gateway, directly, or reads its data only through its API is the judge's,
 * kept in the judgments store so the same sentence gives the same claim. A sentence no one has
 * judged is a claim "unjudged", for a person to read; no word rule stands in for it.
 */

export type FactType = "interaction" | "data-access" | "slo" | "volume" | "owner";
export type ClaimStatus = "agrees" | "conflicts" | "document-only" | "unresolved" | "unjudged";

export interface Claim {
  doc: string;
  line: number;
  /** The sentence, without asides in brackets or the closing full stop. */
  claim: string;
  factType: FactType;
  status: ClaimStatus;
  /** For interaction and data-access claims: caller and callee systems. */
  from?: string;
  to?: string;
  via?: "gateway" | "direct";
  /** For slo, volume and owner claims. */
  system?: string;
  value?: string;
  /** Catalog records the claim agrees or conflicts with. */
  records: string[];
}

export interface DocumentConflict {
  /** Stable: page, line and the record contradicted. */
  id: string;
  doc: string;
  line: number;
  claim: string;
  /** The code fact it contradicts. */
  code: string;
  records: string[];
  factType: FactType;
}

export type ObligationRecord = RecordOf<"Obligation">;

export interface DocumentOnlyFact {
  id: string;
  doc: string;
  line: number;
  system: string;
  fact: string;
  becomes: "Obligation";
  /** The proposed record: confidence inferred, document evidence. Never asserted. */
  record: ObligationRecord;
}

export interface MapFactsInput {
  pages: KnowledgePage[];
  records: CatalogRecord[];
  systems: ProfileSystem[];
  /**
   * The reaches verdict of a sentence and its pair of systems (gateway, direct, api-only, none,
   * unsure), or undefined while no one has judged it. judgeFacts settles them; without it every
   * such sentence is unjudged.
   */
  reaches?: (item: JudgeItem) => string | undefined;
}

/** A sentence and the two systems it names, for the reaches judgment. */
export function reachesItem(sentence: string, from: string, to: string): JudgeItem {
  return {
    inputs: { v: 1, sentence, from, to },
    texts: { sentence },
    facts: [`from: ${from}`, `to: ${to}`],
  };
}

export interface MapFactsResult {
  claims: Claim[];
  documentConflicts: DocumentConflict[];
  documentOnlyFacts: DocumentOnlyFact[];
}

type Iface = RecordOf<"Interface">;
type Table = RecordOf<"Table">;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const words = (s: string) => new Set(slug(s).split("-").filter(Boolean));
const cleanClaim = (s: string) =>
  s
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
const singular = (w: string) =>
  w.endsWith("ies")
    ? `${w.slice(0, -3)}y`
    : w.endsWith("s") && !w.endsWith("ss")
      ? w.slice(0, -1)
      : w;

const SLO =
  /(\d+(?:\.\d+)?)\s*%\s+((?:monthly|weekly|daily|quarterly|yearly|annual)\s+)?(availability|uptime)/i;
const VOLUME =
  /peak(?:\s+load)?\s*(?::|of|is|at)?\s*(\d[\d,]*(?:\.\d+)?)\s+(requests?|calls?|messages?|transactions?|events?)\s+(?:per|an?|\/)\s*(second|minute|hour|day)/i;
const OWNER = /^owner\s*:\s*(.+)$/i;

export function mapFacts(input: MapFactsInput): MapFactsResult {
  const { records, systems } = input;
  const index = mentionIndex(records, systems);
  const sysOf = (id: string) => index.systemOf(id) ?? id;
  const ifaces = records.filter(
    (r): r is Iface => r.kind === "Interface" && r.status !== "retired",
  );
  const tables = records.filter((r): r is Table => r.kind === "Table");
  const storeOwner = new Map<string, string>();
  for (const r of records)
    if (r.kind === "DataStore" && r.ownerComponent) storeOwner.set(r.id, r.ownerComponent);
  const owners = new Map<string, string>();
  for (const s of systems as (ProfileSystem & { owner?: string })[])
    if (s.owner) owners.set(s.id, s.owner);
  for (const r of records) if (r.kind === "System" && r.owner) owners.set(r.id, r.owner);
  const obligations = records.filter(
    (r): r is ObligationRecord => r.kind === "Obligation" && r.status !== "retired",
  );

  const out: MapFactsResult = { claims: [], documentConflicts: [], documentOnlyFacts: [] };

  for (const page of input.pages) {
    const doc = page.path;
    const base = slug(page.pagePath.replace(/\.(md|markdown)$/i, ""));
    const subject = page.subject;
    const conflict = (c: Claim, code: string, record: string) =>
      out.documentConflicts.push({
        id: `conflict.${base}.${c.line}.${record}`,
        doc,
        line: c.line,
        claim: c.claim,
        code,
        records: [record],
        factType: c.factType,
      });

    for (const s of sentences(page.doc)) {
      const claim = cleanClaim(s.text);
      const mentions = index.find(s.text);
      const head = { doc, line: s.line, claim, records: [] as string[] };

      // Owner: ... (about the system the page describes)
      const own = OWNER.exec(claim);
      if (own) {
        if (!subject) continue;
        const value = own[1]!.trim();
        const known = owners.get(subject);
        const c: Claim = {
          ...head,
          factType: "owner",
          system: subject,
          value,
          status: "document-only",
        };
        if (known) {
          const a = words(value);
          const b = words(known);
          const same = [...b].every((w) => a.has(w)) || [...a].every((w) => b.has(w));
          c.status = same ? "agrees" : "conflicts";
          c.records = [subject];
          if (!same) conflict(c, `system ${subject} is owned by ${known}`, subject);
        }
        out.claims.push(c);
        continue;
      }

      // Service levels and peak load become proposed Obligations.
      const sysForValue = mentions[0]?.system ?? subject;
      const slo = SLO.exec(s.text);
      const vol = VOLUME.exec(s.text);
      for (const [kind, m] of [
        ["slo", slo],
        ["volume", vol],
      ] as const) {
        if (!m || !sysForValue) continue;
        const value =
          kind === "slo"
            ? `${m[1]}% ${(m[2] ?? "").toLowerCase()}${m[3]!.toLowerCase()}`
            : `${m[1]!.replace(/,/g, "")} ${m[2]!.toLowerCase()} per ${m[3]!.toLowerCase()}`;
        const c: Claim = {
          ...head,
          factType: kind,
          system: sysForValue,
          value,
          status: "document-only",
        };
        const existing = obligations.filter(
          (o) => o.system === sysForValue && o.obligationKind === kind,
        );
        const same = existing.find((o) => o.value.toLowerCase() === value);
        const firm = existing.filter((o) => o.confidence !== "inferred");
        if (same) {
          c.status = "agrees";
          c.records = [same.id];
        } else if (firm.length) {
          c.status = "conflicts";
          c.records = firm.map((o) => o.id);
          for (const o of firm) conflict(c, `obligation ${o.id} is ${o.value}`, o.id);
        } else {
          const id = `${sysForValue}.${kind}.${slug(value)}`.slice(0, 120);
          const p = parseRecord({
            schemaVersion: 1,
            kind: "Obligation",
            id,
            status: "current",
            confidence: "inferred",
            system: sysForValue,
            obligationKind: kind,
            value,
            assertedBy: doc,
            evidence: [{ source: "document", path: doc, line: s.line, side: "document" }],
          });
          if (!p.ok) throw new Error(`proposed ${id}: ${JSON.stringify(p.issues)}`);
          out.documentOnlyFacts.push({
            id,
            doc,
            line: s.line,
            system: sysForValue,
            fact: `${kind === "slo" ? "SLO" : "Peak load"} ${value}`,
            becomes: "Obligation",
            record: p.record as ObligationRecord,
          });
        }
        out.claims.push(c);
      }
      if (slo || vol) continue;

      // How one system reaches another (ADR 0117 addendum): the pair is the mention index's
      // fact; what the sentence says of it is the reaches judgment.
      if (mentions.length === 0) continue;
      const ends = callEnds(s.text, mentions, subject);
      if (!ends) continue;
      const verdict = input.reaches?.(reachesItem(s.text, ends.from, ends.to));
      if (verdict === "none") continue;
      if (verdict === undefined || verdict === "unsure") {
        out.claims.push({
          ...head,
          factType: "interaction",
          from: ends.from,
          to: ends.to,
          status: "unjudged",
        });
        continue;
      }
      if (verdict === "api-only") {
        // The reader reads the target's data through its API: it should not read its tables.
        const reader = ends.from;
        const target = ends.to;
        const c: Claim = {
          ...head,
          factType: "data-access",
          status: "unresolved",
          from: reader,
          to: target,
        };
        const said = new Set([...words(s.text)].map(singular));
        const owned = tables.filter((t) => {
          const owner = t.ownerComponent ?? storeOwner.get(t.dataStore);
          return owner !== undefined && sysOf(owner) === target;
        });
        // The tables the sentence names (a name written in it), else every table the target owns.
        const named = owned.filter((t) => said.has(singular(t.name.toLowerCase())));
        const direct: { table: Table; comp: string }[] = [];
        for (const t of named.length ? named : owned)
          for (const comp of t.readers) if (sysOf(comp) === reader) direct.push({ table: t, comp });
        if (direct.length) {
          c.status = "conflicts";
          c.records = direct.map((d) => d.table.id);
          for (const d of direct)
            conflict(c, `${d.comp} reads table ${d.table.id} directly`, d.table.id);
        } else {
          const calls = ifaces.filter((i) => sysOf(i.from) === reader && sysOf(i.to) === target);
          c.status = calls.length ? "agrees" : "document-only";
          c.records = calls.map((i) => i.id);
        }
        out.claims.push(c);
        continue;
      }
      if (verdict !== "gateway" && verdict !== "direct") continue;
      const via = verdict;
      const c: Claim = {
        ...head,
        factType: "interaction",
        via,
        status: "unresolved",
        from: ends.from,
        to: ends.to,
      };
      const calls = ifaces.filter(
        (i) => i.sync === "sync" && sysOf(i.from) === ends.from && sysOf(i.to) === ends.to,
      );
      const differ = calls.filter((i) => i.via !== via);
      if (calls.length === 0) c.status = "document-only";
      else if (differ.length) {
        c.status = "conflicts";
        c.records = differ.map((i) => i.id);
        for (const i of differ) conflict(c, `interface ${i.id} is via ${i.via}`, i.id);
      } else {
        c.status = "agrees";
        c.records = calls.map((i) => i.id);
      }
      out.claims.push(c);
    }
  }
  return out;
}

/**
 * Caller and callee of a call sentence. A name right after "to" is the callee; otherwise
 * the first name calls the second. With one name, the page's own system is the other end.
 */
function callEnds(
  text: string,
  mentions: Mention[],
  subject: string | undefined,
): { from: string; to: string } | undefined {
  const distinct: Mention[] = [];
  for (const m of mentions) if (!distinct.some((d) => d.system === m.system)) distinct.push(m);
  const isTarget = (m: Mention) => /\bto\s+(?:the\s+)?$/i.test(text.slice(0, m.at));
  if (distinct.length >= 2) {
    const t = distinct.find(isTarget);
    if (t) {
      const f = distinct.find((m) => m !== t)!;
      return { from: f.system, to: t.system };
    }
    return { from: distinct[0]!.system, to: distinct[1]!.system };
  }
  const only = distinct[0]!;
  if (!subject || subject === only.system) return undefined;
  return isTarget(only) ? { from: subject, to: only.system } : { from: only.system, to: subject };
}

/** The sentences mapFacts would judge with reaches: every one naming two ends it can resolve. */
export function reachesItems(input: Omit<MapFactsInput, "reaches">): JudgeItem[] {
  const index = mentionIndex(input.records, input.systems);
  const out: JudgeItem[] = [];
  for (const page of input.pages)
    for (const s of sentences(page.doc)) {
      if (OWNER.test(cleanClaim(s.text)) || SLO.test(s.text) || VOLUME.test(s.text)) continue;
      const mentions = index.find(s.text);
      if (mentions.length === 0) continue;
      const ends = callEnds(s.text, mentions, page.subject);
      if (ends) out.push(reachesItem(s.text, ends.from, ends.to));
    }
  return out;
}

/**
 * mapFacts with its reaches judgments settled (ADR 0117 addendum): a judgment on file, else the
 * judge where the runtime calls a model directly; a sentence neither settles is unjudged.
 */
export async function judgeFacts(
  input: Omit<MapFactsInput, "reaches">,
  o: { runtime?: AiRuntime; store: JudgmentStore; now: Date; change?: string },
): Promise<MapFactsResult> {
  const results = await settle(REACHES_SPEC, reachesItems(input), {
    runtime: o.runtime,
    store: o.store,
    change: o.change ?? "knowledge-facts",
    now: o.now,
  });
  return mapFacts({
    ...input,
    reaches: (item) => verdictOf(results, REACHES_SPEC, item.inputs)?.verdict,
  });
}
