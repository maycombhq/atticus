import type { CatalogRecord } from "@maycombhq/core";

/**
 * A domain profile (ADR 0071): one system as a document people read and keep, filled from
 * the catalog. What the code proves (repos, interfaces, data, related domains, features) is
 * written with its evidence; what code can't tell (business owner, controls, retention) stays
 * Unknown and becomes an open question. The layout is a template: the organisation's own
 * (`org-pack/templates/domain-profile.md`) or this default, with `{{placeholders}}` filled and
 * everything else kept as written. Reads records only; the same catalog gives the same text.
 */

export const DEFAULT_DOMAIN_PROFILE = `# {{name}}

{{profile}}

## Purpose

Unknown: what this domain is for, in the business's words. A person writes this.

## Business Capabilities

{{capabilities}}

## Systems and Repositories

{{systems}}

## Interfaces

{{interfaces}}

## Data and Records

{{data}}

## Controls and Obligations

| Control or Obligation | Applicability | Owner | Authority | Evidence |
| --- | --- | --- | --- | --- |
| Unknown | Unknown | Unknown | Unknown | Code doesn't show controls; record only what a policy or a decision supports. |

## Operations

Unknown: cutoffs, calendars, service levels, support and incident ownership.

## Related Domains

{{related}}

## Open Questions

{{questions}}

## Evidence Register

{{evidence}}
`;

type Rec = CatalogRecord & Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const cell = (v: string | undefined) =>
  v && v.trim() ? v.replace(/\|/g, "\\|").replace(/\n/g, " ") : "Unknown";
const table = (head: string[], rows: string[][]) =>
  rows.length === 0
    ? "None found in the code."
    : [
        `| ${head.join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
        ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
      ].join("\n");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function evidenceOf(r: Rec): string | undefined {
  const e = (r.evidence as { repo?: string; path?: string; line?: number }[] | undefined)?.[0];
  if (!e?.path) return undefined;
  return `${e.repo ? `${e.repo}:` : ""}${e.path}${e.line ? `:${e.line}` : ""}`;
}
const confidence = (r: Rec) => (r.confidence === "inferred" ? "inferred" : "confirmed");

const TYPE: Record<string, string> = {
  rest: "API",
  grpc: "API",
  soap: "API",
  graphql: "API",
  websocket: "API",
  sse: "API",
  webhook: "API",
  "event-topic": "event",
  "file-drop": "file",
  "batch-job": "batch",
  "mq-queue": "queue",
  function: "function",
  transaction: "transaction",
};

export function domainProfile(
  records: CatalogRecord[],
  system: string,
  o: { template?: string; scannedAt?: string },
): string {
  const all = [...(records as Rec[])].sort((a, b) => cmp(a.id, b.id));
  const byId = new Map(all.map((r) => [r.id, r]));
  const of = (kind: string) => all.filter((r) => r.kind === kind);
  const sys = byId.get(system);
  const components = of("Component").filter((c) => s(c.system) === system);
  if (sys?.kind !== "System" && components.length === 0)
    throw new Error(`No system "${system}" in the catalog.`);
  const name = s(sys?.name) ?? system;
  const own = new Set(components.map((c) => c.id));
  const systemOf = (id: string) =>
    own.has(id)
      ? system
      : (s(byId.get(id)?.system) ?? (byId.get(id)?.kind === "System" ? id : undefined));
  const day = (o.scannedAt ?? "").slice(0, 10) || "Unknown";
  const evidence: string[][] = [];
  const claim = (text: string, r: Rec) =>
    evidence.push([text, evidenceOf(r) ?? r.id, day, day, confidence(r)]);

  // Profile.
  const profile = table(
    ["Field", "Value"],
    [
      ["Status", s(sys?.status) ?? "current"],
      ["Owning team", s(sys?.owner) ?? "Unknown"],
      ["Business owner", "Unknown"],
      ["Last verified", day],
      ["Verified by", "atticus scan (from code)"],
    ],
  );

  // Systems and repositories: the components and where they are built.
  const systems = table(
    ["Component", "Repository", "Responsibility", "Builds on", "Evidence"],
    components.map((c) => {
      claim(`${c.id} is built in ${s(c.repo) ?? "an unknown repo"}`, c);
      return [
        c.id,
        s(c.repo) ?? "Unknown",
        s(c.type) ?? "Unknown",
        list(c.uses).join(", ") || "-",
        evidenceOf(c) ?? "Unknown",
      ];
    }),
  );

  // Interfaces: what the domain serves (with who calls it) and what it calls outside itself.
  const interfaces = of("Interface");
  const endpoints = of("Endpoint").filter((e) => own.has(s(e.component) ?? ""));
  const norm = (p: string | undefined) => (p ?? "").replace(/\{[^}]*\}/g, "{}");
  const callersOf = (e: Rec) =>
    [
      ...new Set(
        interfaces
          .filter(
            (i) =>
              s(i.endpoint) === e.id ||
              (s(i.to) === s(e.component) &&
                s(i.method) === s(e.method) &&
                norm(s(i.normalizedPath)) === norm(s(e.pathOrTopic))),
          )
          .map((i) => s(i.from)!)
          .filter(Boolean),
      ),
    ].sort();
  const ifRows: string[][] = [];
  for (const e of endpoints) {
    const op = `${s(e.method) ? `${s(e.method)} ` : ""}${s(e.pathOrTopic) ?? ""}`;
    claim(`${s(e.component)} serves ${op}`, e);
    ifRows.push([
      op,
      TYPE[s(e.endpointType) ?? ""] ?? "API",
      s(e.component)!,
      callersOf(e).join(", ") || "Unknown",
      list(e.schemaRefs).join(", ") || "none",
      evidenceOf(e) ?? "Unknown",
    ]);
  }
  for (const i of interfaces.filter(
    (x) => own.has(s(x.from) ?? "") && systemOf(s(x.to) ?? "") !== system,
  )) {
    const op = `${s(i.method) ? `${s(i.method)} ` : ""}${s(i.normalizedPath) ?? ""}`;
    claim(`${s(i.from)} calls ${s(i.to)} ${op}`, i);
    ifRows.push([
      op,
      i.sync === "async" ? "event" : "API",
      s(i.to)!,
      s(i.from)!,
      "none",
      evidenceOf(i) ?? "Unknown",
    ]);
  }
  const interfacesText = table(
    ["Interface", "Type", "Producer", "Consumer", "Contract", "Evidence"],
    ifRows,
  );

  // Data: the tables of the domain's stores, and who owns them.
  const stores = of("DataStore").filter(
    (d) => own.has(s(d.ownerComponent) ?? "") || s(d.system) === system,
  );
  const storeIds = new Set(stores.map((d) => d.id));
  const tables = of("Table").filter(
    (t) => storeIds.has(s(t.dataStore) ?? "") || own.has(s(t.ownerComponent) ?? ""),
  );
  const data = table(
    ["Data", "System of Record", "Classification", "Retention", "Read and written by", "Evidence"],
    tables.map((t) => {
      claim(`${t.id} is held in ${s(t.dataStore) ?? "an unknown store"}`, t);
      const who = [...new Set([...list(t.readers), ...list(t.writers)])].sort().join(", ");
      return [
        t.id,
        s(t.ownerComponent) ?? "Unknown",
        "Unknown",
        "Unknown",
        who || "Unknown",
        evidenceOf(t) ?? "Unknown",
      ];
    }),
  );

  // Related domains: the other end of every interface that crosses the boundary.
  const related = new Map<string, { out: boolean; in: boolean; ev?: string }>();
  for (const i of interfaces) {
    const from = systemOf(s(i.from) ?? "");
    const to = systemOf(s(i.to) ?? "");
    if (!from || !to || from === to) continue;
    if (from === system || to === system) {
      const other = from === system ? to : from;
      const r = related.get(other) ?? { out: false, in: false };
      if (from === system) r.out = true;
      else r.in = true;
      r.ev ??= evidenceOf(i);
      related.set(other, r);
    }
  }
  const relatedText = table(
    ["Domain", "Relationship", "Boundary Owner", "Evidence"],
    [...related]
      .sort(([a], [b]) => cmp(a, b))
      .map(([d, r]) => [
        d,
        r.in && r.out
          ? `calls and is called by ${name}`
          : r.out
            ? `${name} calls it`
            : `calls ${name}`,
        s(byId.get(d)?.owner) ?? "Unknown",
        r.ev ?? "Unknown",
      ]),
  );

  // Features found in code that touch the domain.
  const touched = new Set([...own, ...endpoints.map((e) => e.id), ...tables.map((t) => t.id)]);
  const capabilities = table(
    ["Capability", "Description", "Owner", "Status", "Evidence"],
    of("Capability")
      .filter((c) => [...list(c.entryPoints), ...list(c.records)].some((x) => touched.has(x)))
      .map((c) => [
        s(c.name) ?? c.id,
        s(c.description) ?? `Entry points: ${list(c.entryPoints).join(", ")}`,
        s(c.owner) ?? "Unknown",
        c.namedBy === "person" ? "confirmed" : "detected, to confirm",
        evidenceOf(c) ?? "Unknown",
      ]),
  );

  // Open questions: what code can't tell, and questions people already asked.
  const questions = [
    `- Who is the business owner of ${name}? (product owner)`,
    `- Which controls and obligations apply to ${name}, and under which policy or decision? (architect)`,
    ...stores.map(
      (d) => `- What are the classification and retention of the data in ${d.id}? (data owner)`,
    ),
    ...of("OwnerQuestion")
      .filter((q) => s(q.system) === system)
      .map((q) => `- ${s(q.question)} (${s(q.owner) ?? "owner"}, ${s(q.questionState) ?? "open"})`),
    ...[
      ...new Set(
        of("Unresolved")
          .filter((u) => own.has(s(u.owner) ?? ""))
          .map((u) => s(u.owner)!),
      ),
    ]
      .sort()
      .map((c) => {
        const n = of("Unresolved").filter((u) => s(u.owner) === c).length;
        return `- ${n} call${n === 1 ? "" : "s"} or data access${n === 1 ? "" : "es"} in ${c} couldn't be resolved from the code: what do they reach? (developer)`;
      }),
  ].join("\n");

  const evidenceText = table(
    ["Claim", "Source", "Source Date", "Verified Date", "Confidence"],
    evidence.sort((a, b) => cmp(a[0]!, b[0]!)),
  );

  const values: Record<string, string> = {
    name,
    id: system,
    profile,
    capabilities,
    systems,
    interfaces: interfacesText,
    data,
    related: relatedText,
    questions,
    evidence: evidenceText,
  };
  return (o.template ?? DEFAULT_DOMAIN_PROFILE).replace(
    /\{\{\s*([a-z]+)\s*\}\}/g,
    (whole, k: string) => values[k] ?? whole,
  );
}
