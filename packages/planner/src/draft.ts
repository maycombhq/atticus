import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  AgentDefinition,
  changesRelOf,
  type CatalogRecord,
  type RunSummary,
} from "@maycombhq/core";
import {
  buildContextPack,
  quarantineItems,
  toRunSummary,
  type AiRuntime,
  type Run,
  type SourceInput,
} from "@maycombhq/ai";
import { changeFolder, changeStore, loadChangeContext, writeFileAtomic } from "@maycombhq/changes";
import { writeQuarantineItems } from "@maycombhq/naysayer";
import { PlannerError } from "./errors.js";

/**
 * `atticus change draft` (ADR 0070): the proposal, spec and interfaces of a change, drafted by
 * the organisation's assistant from the brief and the part of the catalog it is about, and
 * checked deterministically before anything is written. The relevant part of the map is chosen
 * from the brief's words without AI: the features, endpoints, calls, tables and systems they
 * name. The assistant gets the brief and that map as data. A draft that names a component,
 * system or interface the catalog doesn't have, a requirement without a scenario, or a
 * malformed interface row goes back with the problems (`attempts`, default 3). A draft that
 * passes is written; files a person wrote are kept unless `force`.
 */

export const CHANGE_DRAFTER = "change-drafter";
export const DRAFT_OUTPUT = "change-draft.md";
export const DRAFT_MARK = "<!-- Drafted by atticus change draft";

/** The files a draft may write, change-folder relative. */
const ALLOWED =
  /^(proposal\.md|design\.md|interfaces\.md|data\.md|specs\/[a-z0-9][a-z0-9-]*\/spec\.md)$/;

// ------------------------------------------------------------------ the relevant map

const STOP = new Set(
  "the a an and or of to in on for with from by as at be is are was were it its this that these those can could should would will shall may might not no yes we you they them our their your who what when where why how which into out over under about than then so if do does did done has have had any all each every some one two three new add adds let lets get gets set sets make makes use uses user users want wants need needs today now also only just more most less very".split(
    " ",
  ),
);

/** A word's stem: lower case, a plural or -ing taken off, so "messages" meets "message". */
function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.split(/[^A-Za-z0-9]+/)) {
    if (w.length < 3 || /^\d+$/.test(w)) continue;
    // camelCase and snake_case parts too: ChatMember → chat, member.
    for (const p of w.split(/(?<=[a-z])(?=[A-Z])/)) {
      const s = stem(p);
      if (s.length >= 3 && !STOP.has(s)) out.add(s);
    }
  }
  return out;
}

type Rec = CatalogRecord & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const where = (r: Rec) => {
  const e = (r.evidence as { path?: string; line?: number }[] | undefined)?.[0];
  return e?.path ? ` (${e.path}${e.line ? `:${e.line}` : ""})` : "";
};

export interface RelevantMap {
  /** The map as the assistant reads it, one record per line with its catalog id. */
  text: string;
  /** Record ids it names. */
  ids: Set<string>;
}

/**
 * The part of the catalog a brief is about, deterministically: features, endpoints and tables
 * whose names share a word with the brief, ids the brief names, then the components that serve
 * those endpoints, the calls into them, the tables' readers and writers and their systems.
 */
export function relevantMap(records: CatalogRecord[], brief: string, max = 60): RelevantMap {
  // The title says what the change is about: its words weigh three times the body's. Section
  // headings (Problem, Open questions) are the template's words, not the change's.
  const clean = brief.replace(/<!--[\s\S]*?-->/g, " ");
  const title = /^#\s+(.+)$/m.exec(clean)?.[1] ?? "";
  const want = new Map<string, number>();
  for (const w of words(clean.replace(/^#{1,6}\s.*$/gm, " "))) want.set(w, 1);
  for (const w of words(title)) want.set(w, 3);
  const all = records as Rec[];
  const byId = new Map(all.map((r) => [r.id, r]));
  const named = new Set(
    all
      .filter((r) => new RegExp(`\\b${r.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(brief))
      .map((r) => r.id),
  );
  // A word counts by how rare it is among records of the kind: "api" in every path says
  // nothing; "message" in a few says a lot. Only the strongest matches are kept.
  const top = (kind: string, text: (r: Rec) => string, n: number) => {
    const pool = all.filter((r) => r.kind === kind).map((r) => ({ r, w: words(text(r)) }));
    const df = new Map<string, number>();
    for (const p of pool) for (const w of p.w) df.set(w, (df.get(w) ?? 0) + 1);
    const weight = (w: string) => {
      const d = df.get(w) ?? 0;
      return d === 0 || d > Math.max(3, pool.length * 0.25) ? 0 : Math.log(1 + pool.length / d);
    };
    const scored = pool
      .map((p) => ({
        r: p.r,
        s:
          [...p.w].filter((w) => want.has(w)).reduce((a, w) => a + weight(w) * want.get(w)!, 0) +
          (named.has(p.r.id) ? 10 : 0),
      }))
      .filter((x) => x.s > 0);
    const best = Math.max(0, ...scored.map((x) => x.s));
    return scored
      .filter((x) => x.s >= best * 0.5)
      .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))
      .slice(0, n)
      .map((x) => x.r);
  };

  const features = top("Capability", (r) => `${str(r.name) ?? ""} ${r.id}`, 6);
  const endpoints = new Map<string, Rec>();
  for (const f of features)
    for (const id of arr(f.entryPoints)) {
      const e = byId.get(id);
      if (e?.kind === "Endpoint") endpoints.set(id, e);
    }
  for (const e of top("Endpoint", (r) => `${str(r.pathOrTopic) ?? ""}`, max))
    endpoints.set(e.id, e);
  // Tables whose names the brief names; a feature's other tables would bring its whole flow.
  const tables = new Map<string, Rec>();
  for (const t of top("Table", (r) => `${str(r.name) ?? r.id}`, 25)) tables.set(t.id, t);

  const components = new Set<string>();
  for (const e of endpoints.values()) if (str(e.component)) components.add(str(e.component)!);
  for (const id of named) if (byId.get(id)?.kind === "Component") components.add(id);
  const calls = all.filter(
    (r) =>
      r.kind === "Interface" &&
      ((str(r.endpoint) && endpoints.has(str(r.endpoint)!)) ||
        [...endpoints.values()].some(
          (e) =>
            str(e.component) === str(r.to) &&
            str(e.method) === str(r.method) &&
            (str(e.pathOrTopic) ?? "").replace(/\{[^}]*\}/g, "{}") ===
              (str(r.normalizedPath) ?? "").replace(/\{[^}]*\}/g, "{}"),
        )),
  );
  for (const c of calls)
    for (const end of [str(c.from), str(c.to)])
      if (end && byId.get(end)?.kind === "Component") components.add(end);
  for (const t of tables.values())
    for (const c of [...arr(t.readers), ...arr(t.writers)])
      if (byId.get(c)?.kind === "Component") components.add(c);
  const systems = new Set<string>();
  for (const c of components) {
    const s = str(byId.get(c)?.system);
    if (s) systems.add(s);
  }
  for (const id of named) if (byId.get(id)?.kind === "System") systems.add(id);

  const lines: string[] = [
    "The catalog, as scanned from the code: only what the brief is about. Ids are catalog ids.",
    "",
  ];
  const ids = new Set<string>();
  const add = (id: string, line: string) => {
    ids.add(id);
    lines.push(line);
  };
  for (const s of [...systems].sort())
    add(s, `system ${s}${str(byId.get(s)?.name) ? ` (${str(byId.get(s)!.name)})` : ""}`);
  for (const c of [...components].sort()) {
    const r = byId.get(c)!;
    add(
      c,
      `component ${c}: system ${str(r.system) ?? "?"}, type ${str(r.type) ?? "?"}${str(r.repo) ? `, repo ${str(r.repo)}` : ""}${arr(r.uses).length ? `, uses ${arr(r.uses).join(", ")}` : ""}`,
    );
  }
  for (const f of features)
    add(
      f.id,
      `feature ${f.id} "${str(f.name) ?? f.id}": entry points ${arr(f.entryPoints).join(", ")}`,
    );
  for (const e of [...endpoints.values()].sort((a, b) => a.id.localeCompare(b.id)))
    add(
      e.id,
      `endpoint ${e.id}: ${str(e.component)} serves ${str(e.method) ?? ""} ${str(e.pathOrTopic) ?? ""}${where(e)}`.replace(
        / {2,}/g,
        " ",
      ),
    );
  for (const c of calls.sort((a, b) => a.id.localeCompare(b.id)).slice(0, max)) {
    const p = (c.pattern as { code?: string } | undefined)?.code;
    add(
      c.id,
      `interface ${c.id}: ${str(c.from)} calls ${str(c.to)} ${str(c.method) ?? ""} ${str(c.normalizedPath) ?? ""} via ${str(c.via)}${p ? `, pattern ${p}` : ""}`.replace(
        / {2,}/g,
        " ",
      ),
    );
  }
  if (calls.length > max) lines.push(`(and ${calls.length - max} more calls)`);
  for (const t of [...tables.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const cols = all
      .filter((r) => r.kind === "Column" && str(r.table) === t.id)
      .map((r) => str(r.name) ?? r.id.split(".").pop()!)
      .sort();
    add(
      t.id,
      `table ${t.id} (${str(t.name) ?? ""}, store ${str(t.dataStore) ?? "?"}): columns ${cols.join(", ") || "unknown"}; read by ${arr(t.readers).join(", ") || "nobody known"}; written by ${arr(t.writers).join(", ") || "nobody known"}`,
    );
  }
  if (ids.size === 0)
    lines.push(
      "Nothing in the catalog shares a word with the brief: name systems or components by their catalog id in the brief's Systems section.",
    );
  return { text: lines.join("\n"), ids };
}

// ------------------------------------------------------------------ the assistant's answer

/** The answer as files: `=== <path>` lines start each one. */
export function parseDraft(text: string): Map<string, string> {
  const files = new Map<string, string>();
  let path: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (path !== undefined) files.set(path, `${body.join("\n").trim()}\n`);
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^===\s*(?:file:\s*)?(\S+)\s*(?:===)?\s*$/.exec(line);
    if (m) {
      flush();
      path = m[1]!;
      body = [];
    } else if (path !== undefined) body.push(line);
  }
  flush();
  return files;
}

const SECTION = (doc: string, h: string) => {
  const m = new RegExp(`^##\\s+${h}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "mi").exec(doc);
  return m ? m[1]!.trim() : undefined;
};

/** What is wrong with a draft, in plain words for the assistant's next attempt. */
export function checkDraft(files: Map<string, string>, records: CatalogRecord[]): string[] {
  const problems: string[] = [];
  const all = records as Rec[];
  const kinds = new Map(all.map((r) => [r.id, r.kind]));
  // A system is one a System record or a component names (a profile may list none).
  const systemIds = new Set([
    ...all.filter((r) => r.kind === "System").map((r) => r.id),
    ...all
      .map((r) => (r.kind === "Component" ? str(r.system) : undefined))
      .filter((s): s is string => !!s),
  ]);
  const proposal = files.get("proposal.md");
  if (!proposal) problems.push("There is no proposal.md.");
  else {
    for (const h of ["Why", "What Changes"])
      if (!SECTION(proposal, h))
        problems.push(`proposal.md has no "## ${h}" section, or it is empty.`);
    const systems = SECTION(proposal, "Systems");
    for (const row of (systems ?? "")
      .split("\n")
      .filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l))
      .slice(1)) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const id = cells[0]?.replace(/`/g, "");
      if (id && !/^new\b/i.test(cells[1] ?? "") && !systemIds.has(id))
        problems.push(
          `proposal.md names system ${id}, which isn't in the catalog; use a catalog id, or mark it new.`,
        );
    }
  }
  const specs = [...files.keys()].filter((f) => f.startsWith("specs/"));
  if (specs.length === 0) problems.push("There is no spec: write specs/<capability>/spec.md.");
  for (const s of specs) {
    const doc = files.get(s)!;
    if (!/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/m.test(doc))
      problems.push(`${s} has no "## ADDED Requirements" (or MODIFIED, REMOVED, RENAMED) heading.`);
    const reqs = [...doc.matchAll(/^###\s+Requirement:\s*(.+)$/gm)];
    if (reqs.length === 0) problems.push(`${s} has no "### Requirement:".`);
    for (let i = 0; i < reqs.length; i++) {
      const start = reqs[i]!.index!;
      const end = i + 1 < reqs.length ? reqs[i + 1]!.index! : doc.length;
      const body = doc.slice(start, end);
      if (!/^####\s+Scenario:/m.test(body))
        problems.push(
          `Requirement "${reqs[i]![1]!.trim()}" has no scenario: add "#### Scenario:" with WHEN and THEN.`,
        );
      else if (!/\bWHEN\b/.test(body) || !/\bTHEN\b/.test(body))
        problems.push(`A scenario of "${reqs[i]![1]!.trim()}" lacks a WHEN or a THEN.`);
    }
  }
  const ifs = files.get("interfaces.md");
  if (ifs) {
    const proposedNew = new Set(
      [...(proposal ?? "").matchAll(/^\|\s*`?([a-z0-9][\w.-]*)`?\s*\|\s*new\b/gim)].map(
        (m) => m[1]!,
      ),
    );
    const known = (id: string) =>
      kinds.get(id) === "Component" || systemIds.has(id) || proposedNew.has(id);
    const rows = ifs
      .split("\n")
      .filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l))
      .slice(1);
    for (const row of rows) {
      const [id, caller, callee, , op, , status] = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (!id) continue;
      if (id !== "new" && kinds.get(id) !== "Interface")
        problems.push(
          `interfaces.md: ${id} isn't an interface in the catalog; write new for a new one.`,
        );
      for (const end of [caller, callee])
        if (end && !known(end))
          problems.push(
            `interfaces.md: ${end} isn't in the catalog; use a component or system id from the map, or list it as new in the proposal's Systems.`,
          );
      if (!op || !/^([A-Z]+ \/\S*|[\w.-]+)$/.test(op))
        problems.push(
          `interfaces.md: the operation "${op ?? ""}" should be METHOD /path, or a topic.`,
        );
      if (!/^planned-(new|modify|retire)$/.test(status ?? ""))
        problems.push(
          `interfaces.md: status "${status ?? ""}" should be planned-new, planned-modify or planned-retire.`,
        );
    }
  }
  return problems;
}

// ------------------------------------------------------------------ the agent

export function changeDrafter(agents: AgentDefinition[], budget: number): AgentDefinition {
  return (
    agents.find((a) => a.id === CHANGE_DRAFTER) ??
    AgentDefinition.parse({
      schemaVersion: 1,
      id: CHANGE_DRAFTER,
      role: "architect",
      description:
        "Drafts a change's OpenSpec proposal, spec delta and interfaces from its brief and the part of the catalog it is about.",
      inputs: ["brief", "catalog-slice"],
      outputArtifact: "proposal",
      tokenBudget: budget,
      allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
    })
  );
}

const FORMAT = `Reply with the files only, each starting with a line "=== <path>", in this order:

=== proposal.md
# Proposal
## Why            (the problem, from the brief)
## What Changes   (bullets: what each component does differently, by catalog id)
## Capabilities   (### New Capabilities or ### Modified Capabilities, "- \`<capability>\`: <what>")
## Systems        (a table: | System (catalog id) | New, modified or retired | Why |)
## Impact         (calls, data and people it touches)
## Open questions (the brief's, and any you find; never answer them yourself)

=== specs/<capability>/spec.md
## ADDED Requirements   (or MODIFIED, REMOVED, RENAMED)
### Requirement: <name>
The system SHALL <behaviour>.
#### Scenario: <name>
- **WHEN** <situation and action>
- **THEN** <what can be seen or checked>

=== interfaces.md        (only when the change adds or changes a call or an endpoint)
# Interfaces
| Interface id | Caller | Callee | Pattern | Operation | Contract | Status |
| --- | --- | --- | --- | --- | --- | --- |
| <catalog interface id, or new> | <component id> | <component or system id> | <pattern or empty> | <METHOD /path> | <spec file or none> | <planned-new, planned-modify or planned-retire> |

Rules:
- Use only components, systems, interfaces, endpoints and tables that are in the map below, by their ids. Something new is marked new.
- A change to an existing endpoint is planned-modify with that call's interface id; a new endpoint is a new row.
- Every requirement has at least one scenario, written so a test can check it.
- Plain, short English. No placeholders such as TBD.`;

function instructions(title: string, problems: string[]): string {
  return [
    "# Change drafter",
    "",
    `Draft the OpenSpec proposal, spec delta and interfaces for the change "${title}", from its brief and the catalog map below. People review and own the result; draft what the brief and the map support, and leave the rest as open questions.`,
    "",
    FORMAT,
    ...(problems.length
      ? ["", "Your last draft had these problems. Fix every one:", ...problems.map((p) => `- ${p}`)]
      : []),
  ].join("\n");
}

// ------------------------------------------------------------------ the step

export interface DraftChangeOptions {
  runtime: AiRuntime;
  now?: Date;
  /** Attempts before giving up (default 3). */
  attempts?: number;
  /** Replace design files a person wrote (drafted ones are always replaced). */
  force?: boolean;
  /** Finish a hand-off run: the run id `atticus handoff done` completed. */
  resume?: string;
}

export interface DraftChangeResult {
  change: string;
  state: "written" | "waiting" | "failed";
  attempts: number;
  /** Change-folder-relative files written. */
  files: string[];
  /** Files the answer held that a draft may not write. */
  discarded: string[];
  /** What was wrong with the last draft (empty when it was written). */
  problems: string[];
  /** Catalog ids the map gave the assistant. */
  map: string[];
  waiting?: { runId: string };
  run?: RunSummary;
}

const TEMPLATE_ONLY = (brief: string) =>
  brief
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => l.trim() && !/^#/.test(l.trim())).length === 0;

export async function draftChange(
  root: string,
  changeId: string,
  o: DraftChangeOptions,
): Promise<DraftChangeResult> {
  const change = await changeStore(root).read(changeId);
  const dir = changeFolder(root, change.id);
  const brief = await readFile(join(dir, "brief.md"), "utf8").catch(() => "");
  if (!brief.trim() || TEMPLATE_ONLY(brief))
    throw new PlannerError(
      "refused",
      `${change.id}'s brief.md is still the template: write the problem, outcome and scope first; the draft is made from it.`,
    );
  const ctx = await loadChangeContext(root);
  const map = relevantMap(ctx.records, brief);
  const agent = changeDrafter(ctx.orgPack.agents, ctx.orgPack.runtime.budgets.defaultTokens);
  const levels = ctx.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const now = o.now ?? new Date();
  const attempts = Math.max(1, o.attempts ?? 3);

  const pack = (problems: string[]) => {
    const sources: SourceInput[] = [
      {
        id: "instructions",
        kind: "instruction",
        origin: "atticus",
        text: instructions(change.title, problems),
        classification: "public",
        trusted: true,
      },
      {
        id: "brief.md",
        kind: "artifact",
        origin: `${changesRelOf(root)}/${change.id}/brief.md`,
        text: brief,
        classification: "internal",
        priority: 100,
      },
      {
        id: "catalog-map",
        kind: "catalog",
        origin: "atticus change draft (deterministic)",
        text: map.text,
        classification: "internal",
        priority: 90,
      },
    ];
    return buildContextPack({
      change: change.id,
      agent: agent.id,
      budget: agent.tokenBudget,
      sources,
      levels,
      maxClassification: levels.includes("internal") ? "internal" : levels[0]!,
      now,
    });
  };

  // Files a person wrote are kept unless forced.
  const own: string[] = [];
  const isOwn = async (rel: string) => {
    const text = await readFile(join(dir, rel), "utf8").catch(() => undefined);
    return text !== undefined && !text.startsWith(DRAFT_MARK);
  };
  for (const rel of ["proposal.md", "interfaces.md"])
    if (!o.force && (await isOwn(rel))) own.push(rel);
  if (own.length)
    throw new PlannerError(
      "refused",
      `${change.id} already has design files a person wrote: ${own.join(", ")}. Re-run with --force to replace them.`,
    );

  let problems: string[] = [];
  let run: Run | undefined;
  for (let n = 1; n <= attempts; n++) {
    const p = pack(problems);
    if (o.resume && n === 1) run = await o.runtime.result(o.resume);
    else {
      const prepared = await o.runtime.prepare({
        change: change.id,
        agent,
        pack: p,
        outputPath: DRAFT_OUTPUT,
        outputIn: "run",
      });
      await writeQuarantineItems(
        root,
        change.id,
        prepared.runId,
        quarantineItems(p.defences ?? []),
      );
      run = await o.runtime.run(prepared.runId);
    }
    const base = {
      change: change.id,
      attempts: n,
      map: [...map.ids].sort(),
      run: toRunSummary(run),
    };
    if (run.state === "waiting" || run.state === "prepared")
      return {
        ...base,
        state: "waiting",
        files: [],
        discarded: [],
        // What the last draft got wrong, which this hand-off asks to fix.
        problems,
        waiting: { runId: run.runId },
      };
    if (run.output === undefined || run.state === "failed" || run.state === "cancelled") {
      problems = [`The assistant ${run.state}: ${run.errors.join("; ") || "no answer"}.`];
      continue;
    }
    const answer = parseDraft(run.output);
    const discarded = [...answer.keys()].filter(
      (k) => !ALLOWED.test(k) || posix.normalize(k) !== k || k.includes(".."),
    );
    for (const k of discarded) answer.delete(k);
    problems = checkDraft(answer, ctx.records);
    if (problems.length) continue;
    const stamp = `${DRAFT_MARK} on ${now.toISOString().slice(0, 10)} from brief.md and the catalog; review and edit it, then it is yours. -->\n\n`;
    const files: string[] = [];
    for (const [rel, text] of [...answer].sort(([a], [b]) => a.localeCompare(b))) {
      const path = join(dir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, stamp + text);
      files.push(rel);
    }
    return { ...base, state: "written", files, discarded, problems: [] };
  }
  return {
    change: change.id,
    state: "failed",
    attempts,
    files: [],
    discarded: [],
    problems,
    map: [...map.ids].sort(),
    ...(run ? { run: toRunSummary(run) } : {}),
  };
}
