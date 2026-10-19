import type { CatalogRecord } from "@maycombhq/core";

/**
 * A system guide: everything the catalog knows about one system, in plain sections, each fact
 * with where it came from, and each empty section saying what is missing. Generated, never
 * edited: it is rebuilt from the catalog, so it can't go stale.
 */

type Rec = CatalogRecord & Record<string, unknown>;

export interface GuideChange {
  id: string;
  title: string;
  state: string;
  systems: string[];
}

export interface GuideOptions {
  changes?: GuideChange[];
  /** Whether a system may be named (the catalog site hides restricted ones). Default: all. */
  visible?: (systemId: string) => boolean;
}

export interface Guide {
  system: string;
  name: string;
  markdown: string;
  /** Sections the catalog has nothing for. */
  gaps: string[];
}

const HIDDEN = "a system that isn't on this site";

/** Where a fact came from, short: repo/path:line, or the source kind. */
function src(r: Rec): string {
  const e = r.evidence[0];
  if (!e) return "";
  const where = [e.repo, e.path].filter(Boolean).join("/");
  return where ? `${where}${e.line ? `:${e.line}` : ""}` : e.source;
}

const cite = (r: Rec) => (src(r) ? ` _(${src(r)})_` : "");
const cell = (s: unknown) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

export function systemGuide(
  records: readonly CatalogRecord[],
  id: string,
  o: GuideOptions = {},
): Guide {
  const all = records as Rec[];
  const by = (kind: string) => all.filter((r) => r.kind === kind);
  const sys = by("System").find((r) => r.id === id);
  if (!sys) throw new Error(`There is no system ${id} in the catalog.`);
  const visible = o.visible ?? (() => true);
  const components = by("Component").filter((c) => c.system === id);
  const compIds = new Set(components.map((c) => c.id));
  const systemOfComp = new Map(by("Component").map((c) => [c.id, String(c.system)]));
  const sysOf = (ref: string) =>
    systemOfComp.get(ref) ?? (by("System").some((s) => s.id === ref) ? ref : undefined);
  const nameOf = (ref: string) => {
    const s = sysOf(ref);
    if (s && !visible(s)) return HIDDEN;
    return s && s !== ref && s !== id ? `${ref} (${s})` : ref;
  };
  const gaps: string[] = [];
  const out: string[] = [];

  out.push(`# ${String(sys.name)} (${id})`, "");
  out.push(
    `${cap(String(sys.boundary))} system · confidence: ${sys.confidence}${sys.owner ? ` · owner: ${String(sys.owner)}` : ""}${cite(sys)}`,
    "",
  );
  if (!sys.owner) {
    out.push("No owner recorded.", "");
    gaps.push("owner");
  }
  const repos = (sys.repos as string[]) ?? [];
  if (repos.length) out.push(`Repos: ${repos.join(", ")}`, "");

  // ---------------------------------------------------------------- components
  out.push("## What it is made of", "");
  if (components.length === 0) {
    out.push("No components in the catalog.", "");
    gaps.push("components");
  } else {
    out.push("| Component | Type | Runs on | Repo |", "| --- | --- | --- | --- |");
    for (const c of components)
      out.push(
        `| ${c.id} | ${cell(c.type)} | ${cell(c.runtime ?? "unknown")} | ${cell(c.repo ?? "")} |`,
      );
    out.push("");
  }

  // ---------------------------------------------------------------- interfaces
  const ifaces = by("Interface");
  const outbound = ifaces.filter((i) => compIds.has(String(i.from)) || i.from === id);
  const inbound = ifaces.filter(
    (i) => (compIds.has(String(i.to)) || i.to === id) && !outbound.includes(i),
  );
  out.push("## Who it talks to", "");
  const row = (i: Rec, other: string) =>
    `| ${nameOf(other)} | ${cell(i.method ? `${String(i.method)} ` : "")}${cell(i.normalizedPath)} | ${cell(i.via)} | ${cell(i.auth ?? "not declared")} | ${cell((i.pattern as { code?: string } | undefined)?.code ?? "none")} | ${i.confidence} |`;
  const head = [
    "| With | Operation | Via | Auth | Pattern | Confidence |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  if (outbound.length) {
    out.push("Calls out:", "", ...head, ...outbound.map((i) => row(i, String(i.to))), "");
  }
  if (inbound.length) {
    out.push("Called by:", "", ...head, ...inbound.map((i) => row(i, String(i.from))), "");
  }
  if (!outbound.length && !inbound.length) {
    out.push("No interfaces in the catalog.", "");
    gaps.push("interfaces");
  }
  const noAuth = [...outbound, ...inbound].filter((i) => !i.auth && i.via !== "event-bus");
  if (noAuth.length)
    out.push(
      `- ${noAuth.length} call${noAuth.length === 1 ? " has" : "s have"} no authentication declared in code or config.`,
      "",
    );

  // ---------------------------------------------------------------- data
  out.push("## Data", "");
  const stores = by("DataStore").filter((d) => compIds.has(String(d.ownerComponent)));
  const tables = by("Table").filter((t) => compIds.has(String(t.ownerComponent)));
  if (!stores.length && !tables.length) {
    out.push("No data stores in the catalog.", "");
    gaps.push("data");
  } else {
    for (const d of stores) out.push(`- **${d.id}** (${cell(d.storeType)})${cite(d)}`);
    if (stores.length) out.push("");
    if (tables.length) {
      out.push(
        "| Table | Written by | Read by | Classified columns |",
        "| --- | --- | --- | --- |",
      );
      for (const t of tables) {
        const cols = by("Column").filter((c) => c.table === t.id);
        const classified = cols.filter((c) => c.classification);
        out.push(
          `| ${t.id} | ${((t.writers as string[]) ?? []).map(nameOf).join(", ")} | ${((t.readers as string[]) ?? []).map(nameOf).join(", ")} | ${classified.length ? classified.map((c) => `${String(c.name)} (${String(c.classification)})`).join(", ") : `none of ${cols.length} tagged`} |`,
        );
      }
      out.push("");
    }
  }

  // ---------------------------------------------------------------- runtime
  out.push("## Runtime", "");
  const deps = by("Deployment").filter((d) => compIds.has(String(d.component)));
  const settings = by("Setting").filter((s) => compIds.has(String(s.component)));
  const obs = by("ObservabilityAsset").filter((s) => compIds.has(String(s.component)));
  if (deps.length)
    for (const d of deps)
      out.push(
        `- ${String(d.component)} in ${String(d.env)} on ${String(d.platform)}${d.replicas !== undefined ? `, ${String(d.replicas)} replicas` : ""}${cite(d)}`,
      );
  else {
    out.push("- No deployments in the catalog.");
    gaps.push("runtime");
  }
  for (const s of settings)
    out.push(
      `- ${String(s.settingKind)} ${String(s.key)} = ${String(s.valueOrRef)}${s.target ? ` (for ${nameOf(String(s.target))})` : ""}${cite(s)}`,
    );
  if (obs.length)
    for (const a of obs) out.push(`- ${String(a.assetKind)}: ${String(a.name)}${cite(a)}`);
  else {
    out.push("- No alerts, dashboards or runbooks in the catalog.");
    gaps.push("observability");
  }
  out.push("");

  // ---------------------------------------------------------------- access
  const grants = by("AccessGrant").filter((g) => compIds.has(String(g.subject)));
  if (grants.length) {
    out.push("## Access", "");
    for (const g of grants)
      out.push(
        `- ${String(g.subject)} (${String(g.subjectKind)}) on ${String(g.resource)}: ${((g.scopesOrPermissions as string[]) ?? []).join(", ")}${cite(g)}`,
      );
    out.push("");
  }

  // ---------------------------------------------------------------- decisions and changes
  out.push("## Decisions", "");
  const decisions = by("Decision").filter((d) =>
    ((d.links as { systems?: string[] })?.systems ?? []).includes(id),
  );
  if (decisions.length)
    for (const d of decisions)
      out.push(
        `- **${String(d.title)}** (${String(d.date)}, ${String(d.decidedBy)}): ${String(d.decision)} Because: ${String(d.reason)}`,
      );
  else out.push("No recorded decisions.");
  out.push("");
  const changes = (o.changes ?? []).filter((c) => c.systems.includes(id));
  if (o.changes) {
    out.push("## Changes touching it", "");
    if (changes.length) for (const c of changes) out.push(`- ${c.title} (${c.id}, ${c.state})`);
    else out.push("No open changes.");
    out.push("");
  }

  // ---------------------------------------------------------------- gaps
  out.push("## What the catalog doesn't know yet", "");
  if (gaps.length) for (const g of gaps) out.push(`- ${GAP_TEXT[g] ?? g}`);
  else out.push("Nothing flagged.");
  out.push("");
  return { system: id, name: String(sys.name), markdown: out.join("\n"), gaps };
}

const GAP_TEXT: Record<string, string> = {
  owner: "Who owns this system.",
  components: "What it is made of: no component has been scanned or named.",
  interfaces: "Who it talks to.",
  data: "Where its data lives.",
  runtime: "Where and how it runs.",
  observability: "How it is watched: alerts, dashboards, runbooks.",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
