import {
  contentLines,
  docOf,
  looksPersonal,
  normalizePath,
  sectionMatching,
  sectionLines,
} from "@maycombhq/naysayer";
import type { ReleaseContext } from "./context.js";
import { buildModel, hasWord, opOf, sortStrings, type Model, type ResolvedHop } from "./model.js";

/**
 * The security review draft, generated from the catalog and the change: new or changed
 * interfaces with their auth, data fields touched with their classification (the org pack's
 * levels; "not classified yet" when untagged), data crossing a system boundary, vendors,
 * secrets and settings touched, open security-relevant findings, and who signs off. It adds
 * no approval path: the sign-off is the existing hand-off PR of the gate that role approves.
 */

export type AuthKind = "oauth2" | "mtls" | "api-key" | "basic" | "none" | "other" | "not stated";

export interface InterfaceAuth {
  operation: string;
  caller: string;
  callee: string;
  change: string;
  auth: AuthKind;
  /** Where the auth came from. */
  authSource?: string;
  crosses?: string;
  source: string;
}

export interface FieldClass {
  field: string;
  /** The org pack level, a personal-data class, or "not classified yet". */
  classification: string;
  classificationSource?: string;
  personalLooking: boolean;
  source: string;
}

export interface Crossing {
  operation: string;
  from: string;
  to: string;
  toBoundary: string;
  fields: (FieldClass & { transform?: string; sensitive: "yes" | "no" | "unknown" })[];
  /** What mappings.md says when it lists no fields for the call. */
  note?: string;
  source: string;
}

export interface SecurityReview {
  change: string;
  title: string;
  today: string;
  levels: string[];
  interfaces: InterfaceAuth[];
  fields: FieldClass[];
  crossings: Crossing[];
  vendors: {
    system: string;
    name: string;
    isNew: boolean;
    operations: string[];
    existing: number;
  }[];
  secrets: { what: string; source: string }[];
  settings: { id: string; key: string; value: string; component: string; target?: string }[];
  findings: {
    gate: string;
    id: string;
    rule: string;
    severity: string;
    summary: string;
    path: string;
  }[];
  signOff: {
    gates: {
      gate: string;
      phase: string;
      handoff?: { state: string; pr: string; approvals: string[] };
    }[];
    how: string;
  };
  gaps: string[];
  markdown: string;
}

const SECURITY_RULES = new Set([
  "data-columns-classified",
  "data-retention-stated",
  "interface-pattern-approved",
  "interface-ends-in-catalog",
  "vendor-operation-known",
  "no-embedded-instructions",
]);
const SECURITY_WORDS =
  /\b(auth\w*|secur\w*|secret|personal|privacy|classif\w*|encrypt\w*|tls|mtls|credential|token|vendor|retention|pii)\b/i;
const SECRET_WORDS =
  /\b(secret|shared key|api key|private key|certificate|credential|password|token|vault|keystore|signing key)s?\b/i;

function authFromText(text: string): AuthKind | undefined {
  if (/\bm-?tls\b|mutual tls|client cert/i.test(text)) return "mtls";
  if (/\boauth/i.test(text)) return "oauth2";
  if (/\bapi[- ]?key/i.test(text)) return "api-key";
  if (/\bbasic auth/i.test(text)) return "basic";
  if (/\b(no auth|unauthenticated|without auth)/i.test(text)) return "none";
  return undefined;
}

function authOf(ctx: ReleaseContext, h: ResolvedHop): { auth: AuthKind; source?: string } {
  if (h.record?.auth) return { auth: h.record.auth, source: `catalog Interface ${h.record.id}` };
  const ep = ctx
    .all("Endpoint")
    .find(
      (e) =>
        e.component === h.callee &&
        (e.method ?? "").toUpperCase() === (h.method ?? "") &&
        (e.normalizedPath ?? normalizePath(e.pathOrTopic)) ===
          (h.path ? normalizePath(h.path) : ""),
    );
  if (ep?.auth) return { auth: ep.auth, source: `catalog Endpoint ${ep.id}` };
  for (const n of h.notes) {
    const a = authFromText(n.text);
    if (a) return { auth: a, source: `interfaces.md:${n.n}` };
  }
  for (const r of h.routes) {
    const route = ctx.get("GatewayRoute", r);
    for (const p of route?.policies ?? []) {
      const a = authFromText(p.replace(/([a-z])([A-Z])/g, "$1 $2"));
      if (a) return { auth: a, source: `catalog GatewayRoute ${r} policy ${p}` };
    }
  }
  return { auth: "not stated" };
}

interface Classifier {
  levels: string[];
  personal: string[];
  of(table: string, column: string): { classification: string; source?: string };
}

function classifier(ctx: ReleaseContext, m: Model): Classifier {
  const levels = ctx.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const personal = ctx.policy.privacy.classifications;
  const terms = [...personal, ...levels];
  const doc = docOf(ctx.files, "data.md");
  const sec = sectionMatching(doc, /classif/i);
  const lines = doc && sec ? sectionLines(doc, sec) : [];
  const termIn = (text: string) => terms.find((t) => hasWord(text, t));
  return {
    levels,
    personal,
    of(table, column) {
      const col = ctx
        .all("Column")
        .find((c) => c.name === column && (c.table.endsWith(`.${table}`) || c.table === table));
      if (col?.classification)
        return { classification: col.classification, source: `catalog Column ${col.id}` };
      const own = lines.find((l) => hasWord(l.text, column) && termIn(l.text));
      if (own) return { classification: termIn(own.text)!, source: `data.md:${own.n}` };
      const tableWide = lines.find(
        (l) => hasWord(l.text, table) && /\bcolumns\b/i.test(l.text) && termIn(l.text),
      );
      if (tableWide)
        return { classification: termIn(tableWide.text)!, source: `data.md:${tableWide.n}` };
      void m;
      return { classification: "not classified yet" };
    },
  };
}

export async function securityReview(ctx: ReleaseContext): Promise<SecurityReview> {
  const m = buildModel(ctx);
  const c = classifier(ctx, m);
  const gaps: string[] = [];
  const planned = m.hops.filter((h) => /^planned-/.test(h.change));

  const interfaces: InterfaceAuth[] = planned.map((h) => {
    const a = authOf(ctx, h);
    const crosses =
      h.callerSystem && h.calleeSystem && h.callerSystem !== h.calleeSystem
        ? `${m.systemName(h.callerSystem)} → ${m.systemName(h.calleeSystem)}${h.calleeBoundary ? ` (${h.calleeBoundary})` : ""}`
        : !h.calleeSystem
          ? `${h.callee} isn't in the catalog`
          : undefined;
    if (a.auth === "not stated")
      gaps.push(
        `interfaces.md:${h.line}: ${opOf(h)} (${h.caller} → ${h.callee}) says nothing about auth, and the catalog has none.`,
      );
    return {
      operation: opOf(h),
      caller: h.caller,
      callee: h.callee,
      change: h.change.replace(/^planned-/, ""),
      auth: a.auth,
      ...(a.source ? { authSource: a.source } : {}),
      ...(crosses ? { crosses } : {}),
      source: `interfaces.md:${h.line}`,
    };
  });

  const fields: FieldClass[] = [];
  for (const d of m.data)
    for (const col of d.newColumns) {
      const k = c.of(d.table, col.name);
      fields.push({
        field: `${d.store}.${d.table}.${col.name}`,
        classification: k.classification,
        ...(k.source ? { classificationSource: k.source } : {}),
        personalLooking: looksPersonal(col.name),
        source: `data.md:${d.line}`,
      });
    }
  for (const f of fields) {
    if (f.classification === "not classified yet")
      gaps.push(`${f.field} (${f.source}) is not classified yet.`);
    else if (f.personalLooking && !c.personal.includes(f.classification))
      gaps.push(
        `${f.field} looks like personal data but is classified ${f.classification} (${f.classificationSource}).`,
      );
  }

  // data that crosses a system boundary: the mappings of hops between two systems
  const mdoc = docOf(ctx.files, "mappings.md");
  const crossings: Crossing[] = [];
  const level = (cl: string) => c.levels.indexOf(cl);
  const sensitiveFrom = Math.max(1, level("confidential"));
  for (const h of planned) {
    if (!h.callerSystem || !h.calleeSystem || h.callerSystem === h.calleeSystem) continue;
    const s = mdoc?.sections.find((x) => x.heading.trim().toLowerCase() === opOf(h).toLowerCase());
    const t =
      s && mdoc
        ? mdoc.tables.find(
            (x) => x.line > s.line && x.line <= s.end && x.headers.includes("source field"),
          )
        : undefined;
    const out: Crossing["fields"] = (t?.rows ?? []).map((r) => {
      const src = r.cells["source field"] ?? "";
      const dot = /^([a-z0-9_]+)\.([a-z0-9_]+)$/i.exec(src.trim());
      const k = dot ? c.of(dot[1]!, dot[2]!) : { classification: "not a catalog field" };
      const personalLooking = dot ? looksPersonal(dot[2]!) : looksPersonal(src);
      const sensitive: "yes" | "no" | "unknown" =
        c.personal.includes(k.classification) ||
        personalLooking ||
        level(k.classification) >= sensitiveFrom
          ? "yes"
          : level(k.classification) >= 0
            ? "no"
            : "unknown";
      return {
        field: src,
        classification: k.classification,
        ...(k.source ? { classificationSource: k.source } : {}),
        personalLooking,
        ...(r.cells["rule or transformation"]
          ? { transform: r.cells["rule or transformation"] }
          : {}),
        sensitive,
        source: `mappings.md:${r.line}`,
      };
    });
    const note =
      s && mdoc && !t
        ? sectionLines(mdoc, s)
            .map((l) => l.text.trim())
            .join(" ")
        : undefined;
    if (!s)
      gaps.push(
        `${opOf(h)} crosses from ${m.systemName(h.callerSystem)} to ${m.systemName(h.calleeSystem)} but mappings.md doesn't say which fields it sends.`,
      );
    crossings.push({
      operation: opOf(h),
      from: m.systemName(h.callerSystem),
      to: m.systemName(h.calleeSystem),
      toBoundary: h.calleeBoundary ?? "unknown",
      fields: out,
      ...(note ? { note } : {}),
      source: t ? `mappings.md:${t.line}` : s ? `mappings.md:${s.line}` : `interfaces.md:${h.line}`,
    });
  }

  // vendors: systems with boundary vendor the change calls; new when nothing calls them today
  const vendorIds = sortStrings([
    ...ctx.change.systems.filter((s) => m.boundaryOf(s) === "vendor"),
    ...planned
      .filter((h) => h.calleeBoundary === "vendor" && h.calleeSystem)
      .map((h) => h.calleeSystem!),
  ]);
  const plannedIds = new Set(planned.map((h) => h.record?.id).filter(Boolean));
  const vendors = vendorIds.map((v) => {
    const existing = ctx
      .all("Interface")
      .filter((i) => m.systemOf(i.to) === v && !plannedIds.has(i.id)).length;
    return {
      system: v,
      name: m.systemName(v),
      isNew: existing === 0,
      operations: planned.filter((h) => h.calleeSystem === v).map((h) => opOf(h)),
      existing,
    };
  });

  // secrets: credentials the new calls need, and what the documents say about keys and secrets
  const secrets: SecurityReview["secrets"] = [];
  for (const i of interfaces) {
    if (i.change === "retire") continue;
    if (i.auth === "mtls")
      secrets.push({
        what: `A client certificate for ${i.caller} to call ${i.operation} (mTLS)`,
        source: i.authSource ?? i.source,
      });
    if (i.auth === "api-key")
      secrets.push({
        what: `An API key for ${i.caller} to call ${i.operation}`,
        source: i.authSource ?? i.source,
      });
    if (i.auth === "oauth2") {
      const h = planned.find((x) => opOf(x) === i.operation && x.caller === i.caller)!;
      const grant = ctx
        .all("AccessGrant")
        .find(
          (g) =>
            g.subject === i.caller &&
            h.routes.some((r) => (ctx.get("GatewayRoute", r)?.proxy ?? r) === g.resource),
        );
      secrets.push(
        grant
          ? {
              what: `OAuth client ${i.caller} with scopes ${grant.scopesOrPermissions.join(", ")} (existing grant)`,
              source: `catalog AccessGrant ${grant.id}`,
            }
          : {
              what: `An OAuth client for ${i.caller} to call ${i.operation}: no access grant in the catalog yet`,
              source: i.authSource ?? i.source,
            },
      );
    }
  }
  for (const [path, doc] of ctx.files.docs)
    for (const l of contentLines(doc)) {
      if (!SECRET_WORDS.test(l.text)) continue;
      const row = doc.tables.flatMap((t) => t.rows).find((r) => r.line === l.n);
      const what = !row
        ? l.text.trim().replace(/^[-*]\s+/, "")
        : row.cells["source field"] && row.cells["target field"]
          ? `${row.cells["source field"]} → ${row.cells["target field"]}: ${Object.entries(
              row.cells,
            )
              .filter(([k, v]) => v && k !== "source field" && k !== "target field")
              .map(([, v]) => v)
              .join("; ")}`
          : Object.values(row.cells).filter(Boolean).join("; ");
      secrets.push({ what, source: `${path}:${l.n}` });
    }

  const uniqueSecrets = secrets.filter(
    (x, i, a) => a.findIndex((y) => y.what === x.what && y.source === x.source) === i,
  );
  const touchedComponents = new Set(planned.flatMap((h) => [h.caller, h.callee]));
  const settings = ctx
    .all("Setting")
    .filter(
      (s) => touchedComponents.has(s.component) && (!s.target || touchedComponents.has(s.target)),
    )
    .map((s) => ({
      id: s.id,
      key: s.key,
      value: s.valueOrRef,
      component: s.component,
      ...(s.target ? { target: s.target } : {}),
    }));

  const findings = ctx.latest
    .filter(
      (f) =>
        f.finding.state === "open" &&
        (SECURITY_RULES.has(f.finding.rule) || SECURITY_WORDS.test(f.finding.summary)),
    )
    .map((f) => ({
      gate: f.finding.gate,
      id: f.finding.id,
      rule: f.finding.rule,
      severity: f.finding.severity,
      summary: f.finding.summary,
      path: f.path,
    }));

  // Who signs off (ADR 0073): whoever approves the design and release hand-off PRs on the Git
  // host. There is no role and no separate security approval.
  const gates = ctx.orgPack.gates.gates
    .filter((g) => g.phase === "design" || g.phase === "release")
    .map((g) => {
      const h = ctx.change.handoffs.filter((x) => x.phase === g.phase).at(-1);
      return {
        gate: g.id,
        phase: g.phase,
        ...(h
          ? {
              handoff: {
                state: h.state,
                pr: h.pr.url,
                approvals: h.approvals.map((a) => `${a.by} ${a.at.slice(0, 10)}`),
              },
            }
          : {}),
      };
    });
  const signOff = {
    gates,
    how: gates.length
      ? `Reviewers approve the ${gates.map((g) => g.phase).join(" and ")} hand-off PRs on the Git host with this draft in hand; merging a PR is its sign-off, and atticus change sync records it. The Git host's rules (branch protection, CODEOWNERS) decide who may approve. There is no separate security approval.`
      : "gates.yaml has no design or release gate, so no hand-off PR carries this review yet.",
  };

  const review: Omit<SecurityReview, "markdown"> = {
    change: ctx.change.id,
    title: ctx.change.title,
    today: ctx.today,
    levels: c.levels,
    interfaces,
    fields,
    crossings,
    vendors,
    secrets: uniqueSecrets,
    settings,
    findings,
    signOff,
    gaps: [...new Set(gaps)],
  };
  return { ...review, markdown: securityMarkdown(review, ctx.rounds.length > 0) };
}

const esc = (s: string) => s.replace(/\|/g, "\\|");

function securityMarkdown(r: Omit<SecurityReview, "markdown">, reviewed: boolean): string {
  const md: string[] = [
    `# Security review draft: ${r.title}`,
    "",
    `Change \`${r.change}\`, generated ${r.today} from the catalog and the change folder. A draft for the reviewers of the hand-off PRs: every line says where it came from, and anything Atticus couldn't find is listed as a gap.`,
    "",
    "## New or changed interfaces",
    "",
  ];
  if (r.interfaces.length) {
    md.push(
      "| Operation | Caller → callee | Change | Auth | Auth from | Crosses | Source |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const i of r.interfaces)
      md.push(
        `| ${i.operation} | ${i.caller} → ${i.callee} | ${i.change} | ${i.auth} | ${i.authSource ?? "nowhere"} | ${i.crosses ?? "no"} | ${i.source} |`,
      );
  } else md.push("_interfaces.md lists no new or changed interfaces._");
  md.push(
    "",
    "## Data fields touched",
    "",
    `Classification levels (org pack): ${r.levels.join(", ")}.`,
    "",
  );
  if (r.fields.length) {
    md.push(
      "| Field | Classification | From | Looks personal | Source |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const f of r.fields)
      md.push(
        `| ${f.field} | ${f.classification} | ${f.classificationSource ?? "nowhere"} | ${f.personalLooking ? "yes" : "no"} | ${f.source} |`,
      );
  } else md.push("_data.md adds no fields._");
  md.push("", "## Data crossing a boundary", "");
  if (r.crossings.length)
    for (const x of r.crossings) {
      md.push(`### ${x.operation}: ${x.from} → ${x.to} (${x.toBoundary})`, "");
      if (x.fields.length) {
        md.push(
          "| Field | Classification | Transformation | Sensitive | Source |",
          "| --- | --- | --- | --- | --- |",
        );
        for (const f of x.fields)
          md.push(
            `| ${esc(f.field)} | ${f.classification} | ${esc(f.transform ?? "")} | ${f.sensitive} | ${f.source} |`,
          );
      } else if (x.note) md.push(`${x.note} (${x.source})`);
      else md.push(`_mappings.md doesn't say which fields it sends (${x.source})._`);
      md.push("");
    }
  else md.push("_No new or changed call crosses a system boundary._", "");
  md.push("## Vendors", "");
  if (r.vendors.length)
    for (const v of r.vendors)
      md.push(
        `- ${v.name} (${v.system}): ${v.isNew ? "a new vendor" : `already called (${v.existing} interface${v.existing === 1 ? "" : "s"} in the catalog)`}; new or changed: ${v.operations.join(", ") || "none"}.`,
      );
  else md.push("_The change calls no vendor._");
  md.push("", "## Secrets and settings touched", "");
  if (r.secrets.length) for (const s of r.secrets) md.push(`- ${s.what} (${s.source})`);
  else md.push("_No credential or secret is named or implied._");
  if (r.settings.length) {
    md.push("", "Settings in force on the touched calls:", "");
    for (const s of r.settings)
      md.push(
        `- ${s.key} = ${s.value} on ${s.component}${s.target ? ` → ${s.target}` : ""} (catalog Setting ${s.id})`,
      );
  }
  md.push("", "## Open security-relevant findings", "");
  if (r.findings.length)
    for (const f of r.findings) md.push(`- ${f.severity}: ${f.summary} (${f.rule}, ${f.path})`);
  else
    md.push(
      reviewed
        ? "_None open._"
        : "_No critic round has run yet, so there are no findings to show._",
    );
  md.push("", "## Sign-off", "");
  md.push(`- How: ${r.signOff.how}`);
  for (const g of r.signOff.gates)
    md.push(
      `- ${g.gate} gate: ${g.handoff ? `hand-off PR ${g.handoff.pr} is ${g.handoff.state}${g.handoff.approvals.length ? `, approved by ${g.handoff.approvals.join("; ")}` : ""}` : "no hand-off PR yet"}.`,
    );
  md.push("", "## Gaps", "");
  if (r.gaps.length) for (const g of r.gaps) md.push(`- ${g}`);
  else md.push("_None._");
  return md.join("\n") + "\n";
}
