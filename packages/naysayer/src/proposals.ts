import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { changeFolder, writeFileAtomic, type ChangeContext } from "@maycombhq/changes";
import { assistantActor, IsoDateTime, toCanonicalYaml, type Finding } from "@maycombhq/core";

/**
 * What an assistant proposes about a finding (ADR 0115 addendum, 2026-10-25, finding integrity).
 * A live run's drafting assistant dismissed the critic's finding itself. Now an AI (any `by` that
 * names an assistant, an agent or a runtime, the drafter included) can only propose that a
 * blocking or risk finding is not relevant, or that it is fixed, with a reason. The finding stays
 * open (its C3 file is untouched); the proposal is kept beside the round, in
 * `review/<gate>/<round>/meta/proposals.yaml`, until a person's resolution closes the finding. A
 * "fixed" claim is checked by the next lens round, which sees the finding with the claim. A
 * waiver is a person's only, and a constitution rule is never waived.
 */
export const Proposal = z.strictObject({
  finding: z.string().min(1),
  /** What the assistant claims: the finding doesn't apply, or the draft now fixes it. */
  claim: z.enum(["not-relevant", "fixed"]),
  /** The action it ran: not-relevant, apply or edit-and-apply. */
  action: z.enum(["not-relevant", "apply", "edit-and-apply"]),
  by: z.string().min(1),
  at: IsoDateTime,
  reason: z.string().min(1).optional(),
  /** The finding's fingerprint (findings.ts), so the proposal follows it to the next round. */
  fingerprint: z.string().min(1),
});
export type Proposal = z.infer<typeof Proposal>;

const ProposalsFile = z.strictObject({
  schemaVersion: z.literal(1),
  proposals: z.array(Proposal),
});

const fileOf = (root: string, change: string, gate: string, round: number) =>
  join(changeFolder(root, change), "review", gate, String(round), "meta", "proposals.yaml");

/** The names that are an AI's in this metarepo, besides the built-in ones: the org pack's agents and models. */
export function assistantNames(lifecycle: Pick<ChangeContext, "orgPack">): string[] {
  const rt = lifecycle.orgPack.runtime as { models?: { allowed?: string[] } };
  return [...lifecycle.orgPack.agents.map((a) => a.id), ...(rt.models?.allowed ?? [])];
}

/** The AI a `by` names, with the org pack's agents and models known; undefined for a person. */
export const assistantOf = (lifecycle: Pick<ChangeContext, "orgPack">, by: string) =>
  assistantActor(by, assistantNames(lifecycle));

/** The severities only a person's resolution closes. */
export const PERSON_CLOSES: ReadonlySet<string> = new Set(["blocking", "risk"]);

/**
 * Whether a finding's resolution doesn't count as closing it: an AI resolved a blocking or risk
 * finding (a file from before this rule, or written by hand). It is read as still open.
 */
export const assistantClosed = (f: Finding, known: readonly string[] = []): boolean =>
  f.state !== "open" &&
  PERSON_CLOSES.has(f.severity) &&
  !!f.resolution &&
  assistantActor(f.resolution.by, known) !== undefined;

/** A round's proposals; none when it has no file or the file doesn't read. */
export async function readProposals(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<Proposal[]> {
  const text = await readFile(fileOf(root, change, gate, round), "utf8").catch(() => undefined);
  if (text === undefined) return [];
  const r = ProposalsFile.safeParse(parse(text));
  return r.success ? r.data.proposals : [];
}

/** Write a round's proposals, one per finding, sorted; an empty list leaves an empty file. */
export async function writeProposals(
  root: string,
  change: string,
  gate: string,
  round: number,
  proposals: Proposal[],
): Promise<void> {
  const by = new Map(proposals.map((p) => [p.finding, p]));
  const list = [...by.values()].sort((a, b) => a.finding.localeCompare(b.finding));
  const had = await readFile(fileOf(root, change, gate, round), "utf8").then(
    () => true,
    () => false,
  );
  if (!list.length && !had) return;
  await writeFileAtomic(
    fileOf(root, change, gate, round),
    `# What assistants proposed about this round's findings (ADR 0115 addendum, 2026-10-25): each finding stays open until a person decides it. Atticus writes this file.\n${toCanonicalYaml(ProposalsFile.parse({ schemaVersion: 1, proposals: list }), ["schemaVersion", "finding", "claim", "action", "by", "at", "reason"])}`,
  );
}

/** The words a person reads for a proposal: "proposed by the assistant (claude) as not relevant". */
export const proposalWords = (p: Pick<Proposal, "by" | "claim">) =>
  `proposed by the assistant (${p.by}) as ${p.claim === "fixed" ? "fixed" : "not relevant"}, waiting on a person`;
