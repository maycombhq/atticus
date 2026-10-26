import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { buildContextPack, type AiRuntime } from "@maycombhq/ai";
import { changeStore } from "@maycombhq/changes";
import {
  AgentDefinition,
  catalogDirOf,
  Finding,
  recordReferences,
  toCanonicalYaml,
  type CatalogRecord,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { commandNamed } from "./commands.js";
import { termNamed } from "./glossary.js";

/**
 * Explain anything in plain words: a catalog record, a critic finding, a change, or a
 * command. The explanation is built from fixed templates over the catalog, the finding file,
 * change.yaml and the command reference, so it is the same every time and needs no model.
 * When a runtime is given, an `explainer` agent may reword it for a newcomer; its answer is
 * kept only when it is not empty, and the deterministic text is always returned beside it.
 */

export interface Explanation {
  subject: string;
  kind: "record" | "finding" | "change" | "term" | "command" | "unknown";
  title: string;
  /** Plain sentences. */
  lines: string[];
  /** Related ids or commands to look at next. */
  seeAlso: string[];
  /** The AI's rewording, when a runtime was given and answered. */
  reworded?: string;
}

const KIND_TEXT: Record<string, string> = {
  System: "a system: a product or service people know by name, made of components",
  Component: "a component: one deployable part of a system, usually one repo or service",
  Endpoint: "an endpoint: something a component offers (an API operation, a topic, a queue, a job)",
  Interface: "an interface: one component calling or messaging another",
  GatewayRoute: "a gateway route: a proxy on the API gateway that forwards calls to a component",
  Schema: "a schema: the shape of a message or payload",
  FieldMapping:
    "a field mapping: how a field on one side of an interface becomes a field on the other",
  DataStore: "a data store: a database or other store a component owns",
  Table: "a table: a table or collection in a data store",
  Column: "a column: one field of a table",
  Migration: "a migration: a script that changes a data store's structure",
  Setting: "a setting: a configuration value of a component",
  Deployment: "a deployment: where and how a component runs in one environment",
  ObservabilityAsset: "an observability asset: an alert, dashboard or log query",
  AccessGrant: "an access grant: who may call or read what",
  Obligation: "an obligation: a promise such as a service level or a retention rule",
  SourceDocument: "a source document: a document Atticus took in as data",
  Party: "a party: an internal team or a vendor Atticus works with",
  Initiative: "an initiative: several changes across teams and vendors toward one outcome",
  Commitment: "a commitment: something a party promised to deliver by a date",
  OwnerQuestion: "an owner question: a question to a system's owner that closes a knowledge gap",
  ProcessArtifact: "a process artifact: a ticket, work item or change linked to the catalog",
  Capability: "a feature: what a set of entry points adds up to for its users",
  Unresolved: "a loose end: a call or access found on one side only, not yet matched",
  CuratedDecision:
    "a curated decision: a person's decision replayed over the catalog on every scan",
  GlossaryTerm: "a glossary term: a business word and what it means",
};

const CONFIDENCE: Record<string, string> = {
  verified: "verified: read directly from code, config or a published spec",
  inferred: "inferred: seen from one side only, or read from a diagram or document",
  asserted: "asserted: stated or confirmed by a person",
};

const SEVERITY: Record<string, string> = {
  blocking:
    "blocking: it stops the hand-off until it is fixed or, where allowed, waived with a reason",
  gap: "a knowledge gap: a fact only a person can give; it needs an answer or a recorded reason",
  risk: "a risk: worth knowing, never blocks",
  idea: "an idea: a suggestion, never blocks",
};

const ACTIONS: Record<string, string> = {
  issue:
    "apply the fix, edit and apply, mark not relevant with a reason, or (if blocking and waivable) waive it with a reason",
  "knowledge-gap": "ask the owner the question, or edit and apply the answer",
};

const STATE_TEXT: Record<string, string> = {
  draft: "being drafted",
  define: "in Define: the product owner writes the brief, proposal and specs",
  design: "in Design: the architect designs interfaces, data and the solution",
  plan: "in Plan: stories, tasks and service-desk requests are written",
  build: "in Build: the code is written in each repo",
  qa: "in QA: testing before release",
  "release-ready": "ready for the go/no-go decision",
  released: "released",
  "post-release-review": "released, with the skipped reviews to run after the fact",
  returned: "returned to the product owner",
  archived: "archived",
};

const words = (r: Record<string, unknown>, keys: string[]) =>
  keys.filter(
    (k) =>
      r[k] !== undefined &&
      r[k] !== "" &&
      !(Array.isArray(r[k]) && (r[k] as unknown[]).length === 0),
  );

/** Plain sentences about a record's main fields. */
function recordLines(
  r: CatalogRecord,
  all: CatalogRecord[],
): { lines: string[]; seeAlso: string[] } {
  const x = r as unknown as Record<string, unknown>;
  const lines: string[] = [];
  const seeAlso: string[] = [];
  switch (r.kind) {
    case "System":
      lines.push(
        `${r.name} is a ${r.boundary} system${r.owner ? ` owned by ${r.owner}` : " with no known owner"}.`,
      );
      if (r.repos.length) lines.push(`Its code is in ${r.repos.join(", ")}.`);
      break;
    case "Component":
      lines.push(
        `${r.id} is a ${r.type} in system ${r.system}${r.repo ? `, in repo ${r.repo}` : ""}.`,
      );
      break;
    case "Interface":
      lines.push(
        `${r.from} calls ${r.to}${r.method ? ` with ${r.method}` : ""} ${r.normalizedPath}, ${r.via === "gateway" ? "through the gateway" : r.via === "direct" ? "directly" : `over ${r.via}`}, ${r.sync === "sync" ? "waiting for the answer" : "without waiting (async)"}.`,
      );
      if (r.pattern)
        lines.push(`Its integration pattern is ${r.pattern.code} (${r.pattern.source}).`);
      else lines.push("No integration pattern is recorded for it.");
      if (r.conflicts.length)
        lines.push(`Sources disagree about ${r.conflicts.map((c) => c.field).join(", ")}.`);
      break;
    case "Endpoint":
      lines.push(
        `${r.component} offers ${r.method ? `${r.method} ` : ""}${r.pathOrTopic} (${r.endpointType}).`,
      );
      break;
    case "Table":
      lines.push(
        `${r.name} is a ${r.tableKind} in ${r.dataStore}, owned by ${r.ownerComponent ?? "an unknown component"}.`,
      );
      if (r.writers.length) lines.push(`Written by ${r.writers.join(", ")}.`);
      if (r.readers.length) lines.push(`Read by ${r.readers.join(", ")}.`);
      break;
    case "DataStore":
      lines.push(
        `${r.id} is a ${r.storeType} store owned by ${r.ownerComponent ?? "an unknown component"}.`,
      );
      break;
    case "Party":
      lines.push(
        `${r.name} is ${r.partyKind === "vendor" ? "a vendor" : "an internal team"}${r.owner ? ` (${r.owner})` : ""}.`,
      );
      for (const [k, v] of Object.entries(r.typicalLeadTimes))
        lines.push(`A ${k} usually takes ${v}.`);
      break;
    case "Initiative":
      lines.push(
        `"${r.title}" follows the ${r.journey} journey${r.targetRelease ? `, aiming to release on ${r.targetRelease}` : ""}.`,
      );
      if (r.changes.length) lines.push(`Its changes: ${r.changes.join(", ")}.`);
      if (r.parties.length) lines.push(`It depends on ${r.parties.join(", ")}.`);
      break;
    case "Commitment":
      lines.push(`${r.party} committed to: ${r.what}, by ${r.neededBy} (${r.commitmentStatus}).`);
      if (r.blocks.length) lines.push(`Until then it blocks ${r.blocks.join(", ")}.`);
      break;
    case "OwnerQuestion":
      lines.push(`${r.owner} was asked (${r.questionState}): ${r.question}`);
      break;
    case "Capability":
      lines.push(
        `"${r.name}" starts at ${r.entryPoints.join(", ") || "no known entry point"} and reaches ${r.records.length} record${r.records.length === 1 ? "" : "s"}.`,
      );
      break;
    case "CuratedDecision":
      lines.push(`${r.by} decided to ${r.action} ${r.target} on ${r.at.slice(0, 10)}: ${r.reason}`);
      break;
    default: {
      const keys = words(x, ["name", "title", "component", "system", "owner"]);
      if (keys.length) lines.push(keys.map((k) => `${k}: ${String(x[k])}`).join("; ") + ".");
    }
  }
  const refs = recordReferences(r);
  if (refs.length) {
    const ids = [...new Set(refs.map((f) => f.id))];
    lines.push(
      `It refers to ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` and ${ids.length - 8} more` : ""}.`,
    );
    seeAlso.push(...ids.slice(0, 5));
  }
  const back = all.filter((o) => o !== r && recordReferences(o).some((f) => f.id === r.id));
  if (back.length) {
    const ids = [...new Set(back.map((o) => o.id))];
    lines.push(
      `${ids.length} record${ids.length === 1 ? " refers" : "s refer"} to it, such as ${ids.slice(0, 5).join(", ")}.`,
    );
    seeAlso.push(`atticus impact ${r.id}`);
  }
  return { lines, seeAlso };
}

async function findFinding(
  root: string,
  id: string,
): Promise<{ path: string; finding: Finding } | undefined> {
  const changes = join(root, "openspec", "changes");
  const walk = async (d: string): Promise<{ path: string; finding: Finding } | undefined> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        const hit = await walk(full);
        if (hit) return hit;
      } else if (e.name === `${id}.yaml` && full.split(sep).includes("review")) {
        const r = Finding.safeParse(parse(await readFile(full, "utf8")));
        if (r.success) return { path: relative(root, full).split(sep).join("/"), finding: r.data };
      }
    }
    return undefined;
  };
  return walk(changes);
}

export const EXPLAINER = AgentDefinition.parse({
  schemaVersion: 1,
  id: "explainer",
  role: "developer",
  description:
    "Rewords an Atticus explanation in plain words for a newcomer, adding nothing that isn't in it.",
  inputs: ["catalog-slice"],
  outputArtifact: "proposal",
  tokenBudget: 20_000,
  allowedRuntimes: ["model", "mock", "replay", "hand-off"],
});

/** Explain an id (record, finding, change) or a command, in plain words. */
export async function explain(
  root: string,
  subject: string,
  o: { runtime?: AiRuntime; now?: Date } = {},
): Promise<Explanation> {
  const s = subject.trim();
  let out: Explanation | undefined;
  const cmd = /\s/.test(s) || /^atticus\b/.test(s) ? commandNamed(s) : undefined;
  if (cmd) out = commandExplanation(s, cmd);
  if (!out) {
    const dir = catalogDirOf(root);
    const records = [
      ...(await readCatalog(join(dir, "generated"), { cacheRoot: root })).records,
      ...(await readCatalog(join(dir, "curated"), { cacheRoot: root })).records,
    ];
    const hits = records.filter((r) => r.id === s);
    if (hits.length) {
      const r = hits[0]!;
      const { lines, seeAlso } = recordLines(r, records);
      out = {
        subject: s,
        kind: "record",
        title: `${s} is ${KIND_TEXT[r.kind] ?? `a ${r.kind} record`}.`,
        lines: [
          ...lines,
          `Its confidence is ${CONFIDENCE[r.confidence] ?? r.confidence}.`,
          `Evidence: ${[...new Set(r.evidence.map((e) => (e.source === "manual" ? `stated by ${e.by ?? "a person"}` : `${e.source}${e.path ? ` ${e.repo ? `${e.repo}/` : ""}${e.path}${e.line ? `:${e.line}` : ""}` : ""}`)))].slice(0, 4).join("; ")}.`,
          ...(hits.length > 1
            ? [
                `${hits.length - 1} other record${hits.length > 2 ? "s have" : " has"} the same id (${hits
                  .slice(1)
                  .map((h) => h.kind)
                  .join(", ")}).`,
              ]
            : []),
        ],
        seeAlso,
      };
    }
  }
  if (!out) {
    const c = await changeStore(root)
      .tryRead(s)
      .catch(() => undefined);
    if (c)
      out = {
        subject: s,
        kind: "change",
        title: `${s} is a change: "${c.title}" (${c.type}).`,
        lines: [
          `It is ${STATE_TEXT[c.state] ?? c.state}.`,
          ...(c.systems.length ? [`It touches ${c.systems.join(", ")}.`] : []),
          ...(c.history.length
            ? [
                `Last move: ${c.history.at(-1)!.from} to ${c.history.at(-1)!.to} by ${c.history.at(-1)!.by}.`,
              ]
            : []),
        ],
        seeAlso: [`atticus change status ${s}`, `atticus findings ${s}`],
      };
  }
  if (!out) {
    const f = await findFinding(root, s);
    if (f) {
      const x = f.finding;
      out = {
        subject: s,
        kind: "finding",
        title: `${s} is a critic finding on change ${x.change} at the ${x.gate} gate (round ${x.round}).`,
        lines: [
          `It says: ${x.summary}`,
          `Why it matters: ${x.why}`,
          `It is ${SEVERITY[x.severity] ?? x.severity}.`,
          `Rule ${x.rule} (${x.layer} layer, ${x.lens} lens) raised it about ${x.artifact}${x.locator.line ? ` line ${x.locator.line}` : ""}.`,
          `Evidence: ${x.evidence
            .map((e) => (e.quote ? `"${e.quote}"` : (e.record ?? e.path ?? "")))
            .filter(Boolean)
            .slice(0, 2)
            .join("; ")}.`,
          `Fix: ${x.fix.text}`,
          ...(x.question ? [`Question for ${x.question.owner}: ${x.question.text}`] : []),
          x.state === "open"
            ? `It is open. You can ${ACTIONS[x.kind]}${x.waivable ? "" : "; it can't be waived"}.`
            : `It is ${x.state}${x.resolution ? ` (by ${x.resolution.by})` : ""}.`,
        ],
        seeAlso: [`atticus finding ${x.change} ${x.id} <action>`, `atticus explain ${x.rule}`],
      };
    }
  }
  if (!out) {
    // WP5.1: one of Atticus's own words, before a command of the same name.
    const t = termNamed(s);
    if (t)
      out = {
        subject: s,
        kind: "term",
        title: t.term,
        lines: [t.says],
        seeAlso: commandNamed(s) ? [`atticus explain "atticus ${s}"`] : [],
      };
  }
  if (!out) {
    const c = commandNamed(s);
    if (c) out = commandExplanation(s, c);
  }
  out ??= {
    subject: s,
    kind: "unknown",
    title: `Atticus knows nothing called ${s}.`,
    lines: [
      'Try a record id (atticus query to find one), a change id, a finding id, or a command such as "atticus explain scan".',
    ],
    seeAlso: ["atticus query", "atticus change list"],
  };
  if (o.runtime && out.kind !== "unknown")
    out.reworded = await reword(out, o.runtime, o.now ?? new Date());
  return out;
}

function commandExplanation(
  s: string,
  c: NonNullable<ReturnType<typeof commandNamed>>,
): Explanation {
  return {
    subject: s,
    kind: "command",
    title: `atticus ${c.name}: ${c.what}`,
    lines: [
      `Usage: ${c.usage}`,
      `Usually run by: ${c.who.join(", ")}.`,
      c.changes === "nothing" ? "It only reads; it changes nothing." : `It changes: ${c.changes}.`,
      ...(c.approval
        ? [
            "It writes to a shared system, so it needs your approval each time (--approve; it shows what it would do first).",
          ]
        : []),
    ],
    seeAlso: (c.related ?? []).map((r) => `atticus explain ${r}`),
  };
}

async function reword(e: Explanation, runtime: AiRuntime, now: Date): Promise<string | undefined> {
  const pack = buildContextPack({
    change: "explain",
    agent: EXPLAINER.id,
    budget: EXPLAINER.tokenBudget,
    levels: ["public", "internal", "confidential", "restricted"],
    maxClassification: "internal",
    now,
    sources: [
      {
        id: "0-instructions",
        kind: "instruction",
        origin: "atticus/learn/explain",
        text: "Reword the explanation below in plain, short sentences for someone new to Atticus. Keep every fact; add none. Write only the reworded text.",
        classification: "public",
        trusted: true,
      },
      {
        id: "explanation",
        kind: "document",
        origin: `explain/${e.subject}`,
        text: toCanonicalYaml({ title: e.title, lines: e.lines }),
        classification: "internal",
      },
    ],
  });
  try {
    const run = await runtime.prepare({
      change: "explain",
      agent: EXPLAINER,
      pack,
      outputPath: "explain.md",
    });
    const done = await runtime.run(run.runId);
    const text = done.output?.trim();
    return done.state === "validated" && text ? text : undefined;
  } catch {
    return undefined;
  }
}
