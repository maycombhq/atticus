import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  AgentDefinition,
  IsoDateTime,
  RecordId,
  toCanonicalYaml,
  type OrgPack,
  type RunSummary,
} from "@maycombhq/core";
import { buildContextPack, toRunSummary, type AiRuntime, type SourceInput } from "@maycombhq/ai";
import type { TermEntry } from "./build.js";

/**
 * AI definitions for terms only the code uses (outside the scan): the `glossary-definer`
 * agent proposes one sentence per term from where the code uses it. Atticus's instructions
 * are trusted; the usages are wrapped as data. A proposal must cite record ids from the
 * term's usages; one that cites none is discarded. Proposals live in
 * `catalog/proposals/glossaryterm/<term>.yaml`, are read by every glossary build (flag
 * `ai-proposed`, still `inferred`) and give way to a page's or a person's definition.
 */

export const GLOSSARY_DEFINER = "glossary-definer";

/** What `proposeDefinitions` sends as the change and output path, so a finished hand-off is recognised. */
export const GLOSSARY_CHANGE = "glossary";
export const GLOSSARY_OUTPUT = "catalog/proposals/glossary-definitions.yaml";

export const DefinitionProposalFile = z.strictObject({
  schemaVersion: z.literal(1),
  term: RecordId,
  definition: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  agent: RecordId,
  runId: z.string().optional(),
  at: IsoDateTime,
});
export type DefinitionProposal = Omit<z.infer<typeof DefinitionProposalFile>, "schemaVersion">;

const LEADING = ["schemaVersion", "term", "definition", "evidence"];

export async function writeDefinitionProposals(
  dir: string,
  proposals: readonly DefinitionProposal[],
): Promise<string[]> {
  const written: string[] = [];
  if (!proposals.length) return written;
  await mkdir(join(dir, "glossaryterm"), { recursive: true });
  for (const p of proposals) {
    const file = `glossaryterm/${p.term}.yaml`;
    const body = DefinitionProposalFile.parse({ schemaVersion: 1, ...p });
    await writeFile(join(dir, file), toCanonicalYaml(body, LEADING), "utf8");
    written.push(file);
  }
  return written;
}

/** Remove the proposal of a term a person has defined (it would never be used again). */
export async function dropDefinitionProposal(dir: string, term: string): Promise<void> {
  await rm(join(dir, "glossaryterm", `${term}.yaml`), { force: true });
}

export async function readDefinitionProposals(dir: string): Promise<{
  proposals: DefinitionProposal[];
  problems: { file: string; message: string }[];
}> {
  const proposals: DefinitionProposal[] = [];
  const problems: { file: string; message: string }[] = [];
  let files: string[];
  try {
    files = (await readdir(join(dir, "glossaryterm"))).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return { proposals, problems };
  }
  for (const f of files) {
    const file = `glossaryterm/${f}`;
    let data: unknown;
    try {
      data = parse(await readFile(join(dir, file), "utf8"));
    } catch (e) {
      problems.push({ file, message: `invalid YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    const p = DefinitionProposalFile.safeParse(data);
    if (!p.success) {
      problems.push({
        file,
        message: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    const { schemaVersion: _v, ...rest } = p.data;
    void _v;
    proposals.push(rest);
  }
  return { proposals, problems };
}

/** The org pack's `glossary-definer` agent, or the built-in default. */
export function glossaryDefinerAgent(
  orgPack?: Pick<OrgPack, "agents" | "runtime">,
): AgentDefinition {
  const own = orgPack?.agents.find((a) => a.id === GLOSSARY_DEFINER);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: GLOSSARY_DEFINER,
    role: "business-analyst",
    description:
      "Proposes a one-sentence business definition for each glossary term found only in code, from where the code uses it.",
    inputs: ["glossary", "catalog-slice"],
    // C5 has no output kind for catalog proposals (see ADR 0031); a definition seeds specs.
    outputArtifact: "specs",
    tokenBudget: orgPack?.runtime.budgets.defaultTokens ?? 150_000,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

const INSTRUCTIONS = `# Glossary definer

You propose business definitions for words an estate's code uses that no wiki page defines. Each term below is a data block: its id, the word, and the records (endpoints, topics, tables, columns, schema fields) that use it. For each term propose:

- definition: one sentence a product owner would accept, saying what the word means to the business, only from the evidence;
- evidence: the record ids from that term's block your definition relies on.

Don't invent systems, rules or numbers. A proposal that cites no record id from its term is discarded. Write YAML and nothing else:

terms:
  - id: <term id>
    definition: <one sentence>
    evidence: [<record id>, ...]`;

const Proposal = z.object({
  id: z.string().min(1),
  definition: z.string().trim().min(3).max(400),
  evidence: z.array(z.coerce.string()).default([]),
});

export interface ProposeResult {
  proposals: DefinitionProposal[];
  discarded: { term?: string; reason: string }[];
  run?: RunSummary;
  promptSha256?: string;
  /** Set when the run went to the person's assistant (hand-off) and has no answer yet. */
  waiting?: string;
}

function block(e: TermEntry): string {
  return toCanonicalYaml(
    {
      id: e.id,
      term: e.term,
      usedBy: (e.code?.uses ?? []).map((u) => ({
        id: u.record,
        kind: u.kind,
        name: u.name,
        ...(u.evidence.path
          ? {
              code: `${u.evidence.repo ? `${u.evidence.repo}:` : ""}${u.evidence.path}${u.evidence.line ? `:${u.evidence.line}` : ""}`,
            }
          : {}),
      })),
    },
    ["id", "term", "usedBy", "id", "kind", "name", "code"],
  ).trimEnd();
}

/** Parse the agent's answer: keep proposals for the terms it was given that cite their usages. */
export function parseDefinerOutput(
  output: string,
  entries: readonly TermEntry[],
  meta: { agent: string; at: string; runId?: string },
): Pick<ProposeResult, "proposals" | "discarded"> {
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
  } catch (e) {
    return {
      proposals: [],
      discarded: [{ reason: `the output is not YAML: ${(e as Error).message.split("\n")[0]}` }],
    };
  }
  const list = (data as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(list))
    return { proposals: [], discarded: [{ reason: "the output has no terms list" }] };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: Pick<ProposeResult, "proposals" | "discarded"> = { proposals: [], discarded: [] };
  for (const raw of list) {
    const p = Proposal.safeParse(raw);
    const id =
      typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : undefined;
    if (!p.success) {
      out.discarded.push({ ...(id ? { term: id } : {}), reason: "incomplete proposal" });
      continue;
    }
    const e = byId.get(p.data.id);
    if (!e) {
      out.discarded.push({
        term: p.data.id,
        reason: `${p.data.id} isn't one of the terms it was given`,
      });
      continue;
    }
    if (out.proposals.some((x) => x.term === e.id)) {
      out.discarded.push({ term: e.id, reason: "a second proposal for the same term" });
      continue;
    }
    const known = new Set((e.code?.uses ?? []).map((u) => u.record));
    const evidence = [...new Set(p.data.evidence.filter((x) => known.has(x)))];
    if (!evidence.length) {
      out.discarded.push({ term: e.id, reason: "it cites no record that uses the term" });
      continue;
    }
    out.proposals.push({
      term: e.id,
      definition: p.data.definition.replace(/\s+/g, " "),
      evidence,
      agent: meta.agent,
      at: meta.at,
      ...(meta.runId ? { runId: meta.runId } : {}),
    });
  }
  return out;
}

/** Terms that need a proposal: found only in code, with no definition from a page or a person. */
export function undefinedCodeTerms(entries: readonly TermEntry[]): TermEntry[] {
  return entries.filter(
    (e) => e.sources.length === 1 && e.sources[0] === "code" && (e.code?.uses.length ?? 0) > 0,
  );
}

export async function proposeDefinitions(
  entries: readonly TermEntry[],
  runtime: AiRuntime,
  o: { orgPack?: Pick<OrgPack, "agents" | "runtime" | "pack">; now?: Date } = {},
): Promise<ProposeResult> {
  const todo = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  if (!todo.length) return { proposals: [], discarded: [] };
  const agent = glossaryDefinerAgent(o.orgPack);
  const now = o.now ?? new Date();
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const levels = o.orgPack?.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const sources: SourceInput[] = [
    {
      id: "0-instructions",
      kind: "instruction",
      origin: "atticus/glossary",
      text: INSTRUCTIONS,
      classification: "public",
      trusted: true,
    },
    ...todo.map((e) => ({
      id: e.id,
      kind: "catalog" as const,
      origin: `catalog/generated/glossaryterm/${e.id}.yaml`,
      text: block(e),
      classification: "internal",
      priority: 10,
    })),
  ];
  const pack = buildContextPack({
    change: GLOSSARY_CHANGE,
    agent: agent.id,
    budget: o.orgPack?.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget,
    sources,
    levels,
    maxClassification: levels.includes("internal") ? "internal" : levels.at(-1)!,
    now,
  });
  const sent = todo.filter((e) => pack.manifest.sources.some((s) => s.id === e.id));
  const discarded: ProposeResult["discarded"] = todo
    .filter((e) => !sent.includes(e))
    .map((e) => ({
      term: e.id,
      reason: "left out of the context pack (budget or classification)",
    }));
  const prepared = await runtime.prepare({
    change: GLOSSARY_CHANGE,
    agent,
    pack,
    outputPath: GLOSSARY_OUTPUT,
  });
  const run = await runtime.run(prepared.runId);
  if (run.state === "waiting" || run.state === "prepared")
    return {
      proposals: [],
      discarded,
      waiting: run.runId,
      promptSha256: pack.manifest.promptSha256,
    };
  if (run.state !== "validated" || run.output === undefined)
    return {
      proposals: [],
      discarded: [
        ...discarded,
        { reason: `the glossary definer ${run.state}: ${run.errors.join("; ") || "no output"}` },
      ],
      run: toRunSummary(run),
      promptSha256: pack.manifest.promptSha256,
    };
  const parsed = parseDefinerOutput(run.output, sent, { agent: agent.id, at, runId: run.runId });
  return {
    proposals: parsed.proposals,
    discarded: [...discarded, ...parsed.discarded],
    run: toRunSummary(run),
    promptSha256: pack.manifest.promptSha256,
  };
}
