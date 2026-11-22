import { Finding } from "@maycombhq/core";
import { loadChangeContext, type ChangeContext } from "@maycombhq/changes";
import {
  assistantOf,
  readRound,
  roundsOf,
  stageGateOf,
  writeGateRound,
  type RoundWrite,
} from "@maycombhq/naysayer";
import { ACCEPTABLE_STAGE_RULES } from "./finding-kind.js";
import type { LoopFinding, Stage } from "./schema.js";

/**
 * ADR 0203 A: a person may accept a stage's blocking finding, with a name and a reason. The
 * bridge is a gate per stage: when a stage's run ends, its blocking findings of the current draft
 * are written as C3 findings on the built-in gate `stage-<stage>` (as conformance writes its
 * own), so `atticus finding <change> <id> waive --reason …` works unchanged, a person only
 * (act.ts refuses an assistant). The acceptance is recorded in the finding's file and nowhere
 * else; the loop reads it there.
 */

/** The rules about one id (a repo, a component, a consumer): the id is the target's last part. */
const ABOUT_ONE_ID: ReadonlySet<string> = new Set([
  "feature.unknown-repo",
  "operation.unknown-repo",
  "delta.unknown-component",
  "delta.unknown-consumer",
  "stories.unknown-consumer",
]);

/** The way on for a rule a person can't accept: the ADR's table, row by row. */
const WAYS_ON: [readonly string[] | RegExp, string][] = [
  [
    ["stories.note-cite", "stories.note-conflict", "stories.note-overrides-code"],
    "A document never overrides a fact verified from code (rule 6): fix the note, or the code.",
  ],
  [
    ["feature.nothing-placed", "small.no-target-flow"],
    "Nothing is left to plan, so accepting it can't work: a change with no flow and no operation belongs on the quick path (atticus change new --from <requirements.md>).",
  ],
  [
    [
      "feature.unknown-feature",
      "feature.unknown-flow",
      "delta.unknown-flow",
      "delta.unknown-read",
      "delta.flow-missing",
      "delta.new-flow-missing",
      "delta.unknown-table",
      "delta.unknown-column",
      "stories.unknown-column",
      "stories.unknown-entry",
    ],
    "The next stage needs today's steps, or the column's type and classification, from the catalog: put it under newFlows or mark it new, or read the repo (atticus map <repo>).",
  ],
  [
    [
      "delta.exists",
      "delta.entry-exists",
      "delta.table-exists",
      "delta.new-exists",
      "delta.wrong-repo",
      "delta.stale",
      "delta.read-and-changed",
    ],
    "The draft contradicts a verified fact, and a document never overrides one (rule 6): take new off, or run the stage again.",
  ],
  [
    [
      "delta.no-classification",
      "delta.no-retention",
      "delta.no-migration",
      "delta.bad-classification",
      "delta.bad-migration",
      "delta.no-type",
      "delta.no-columns",
      "stories.write-no-migration",
    ],
    "It is about data safety: answer its question with a choice, or fix the draft as the message says.",
  ],
  [
    ["feature.archived-repo", "operation.archived-repo"],
    "An archived repo takes no new work, whatever the catalog still holds of it: put the work in the repo that took it over, or take archived off in the manifest.",
  ],
  [
    /^delta\.(at|uses)-/,
    "The place cites code that isn't there: give new: <file> for new code, or cite the line that is.",
  ],
  [
    /^(delta\.(deploy-|key-)|operation\.)/,
    "The message gives the order or the fix; a wrong order is not a matter of opinion.",
  ],
  [
    /^(stage\.|design\.)/,
    "The answer doesn't read, or a design element is unmapped: fix the file the message names.",
  ],
];
const WAY_ON_DEFAULT =
  "The next stage can't do its work with it open, so it can't be accepted: fix it as the message says.";

export const acceptableStageRule = (rule: string): boolean => ACCEPTABLE_STAGE_RULES.has(rule);

/** Why a rule not on the list can't be accepted, and the way on. */
export function wayOn(rule: string): string {
  for (const [rules, words] of WAYS_ON)
    if (rules instanceof RegExp ? rules.test(rule) : rules.includes(rule)) return words;
  return WAY_ON_DEFAULT;
}

/** A person's acceptance of a stage finding, as its file records it. */
export interface Accepted {
  /** The finding's id, `stage-<fingerprint>`. */
  finding: string;
  fingerprint: string;
  stage: string;
  rule: string;
  by: string;
  why: string;
  at: string;
  /** The id the rule is about, when it is about one. */
  record?: string;
  /** The finding's words when it was accepted (its file's `why`): what the later stages read. */
  message: string;
}

/** The words a stage file and a note use: "accepted by <who>: <why>". */
export const acceptedWords = (a: Pick<Accepted, "by" | "why">) =>
  `accepted by ${a.by}: ${a.why.trim().replace(/[.!?]+$/, "")}`;

const STAGE_IDS = ["feature", "architecture", "stories", "small"] as const;

/**
 * Every acceptance on the change's stage gates (the newest round of each), by fingerprint. A
 * resolution an assistant wrote is no acceptance: only a person accepts.
 */
export async function readAccepted(
  root: string,
  change: string,
  given?: Pick<ChangeContext, "orgPack">,
  stages: readonly string[] = STAGE_IDS,
): Promise<Map<string, Accepted>> {
  const out = new Map<string, Accepted>();
  // Always with the org pack's assistants known: a resolution an assistant wrote accepts nothing.
  const ctx = given ?? (await loadChangeContext(root));
  for (const stage of stages) {
    const gate = stageGateOf(stage);
    const round = (await roundsOf(root, change, gate).catch(() => [] as number[])).at(-1);
    if (round === undefined) continue;
    for (const { finding: f } of (await readRound(root, change, gate, round)).findings) {
      const r = f.resolution;
      // Rule 6: a constitution rule is never accepted, whatever its file says.
      if (f.state !== "waived" || !r?.reason || f.layer === "constitution") continue;
      if (assistantOf(ctx, r.by) || !acceptableStageRule(f.rule)) continue;
      const fp = f.id.replace(/^stage-/, "").slice(0, 12);
      out.set(fp, {
        finding: f.id,
        fingerprint: fp,
        stage,
        rule: f.rule,
        by: r.by,
        why: r.reason,
        at: r.at,
        ...(f.locator.record ? { record: f.locator.record } : {}),
        message: f.why,
      });
    }
  }
  return out;
}

/**
 * The ids people accepted (a repo, a component, a consumer), as knownToChange reads them: one an
 * acceptance, by rule and id, so one id accepted under two rules is known as both.
 */
export const acceptedIds = (
  accepted: ReadonlyMap<string, Accepted>,
): (Accepted & { id: string })[] => {
  const out = new Map<string, Accepted & { id: string }>();
  for (const a of accepted.values())
    if (a.record) out.set(`${a.rule}|${a.record}`, { ...a, id: a.record });
  return [...out.values()];
};

/** What the projection needs of a stage beyond its findings. */
export interface ProjectOptions {
  change: string;
  stage: Stage;
  /** The stage's source in the change folder, e.g. target-flows/. */
  source: string;
  /** The command that runs the stage again. */
  rerun: string;
  now: string;
  /** Where in the stage's files a finding is (`spec.locate`), as metarepo path:line. */
  locate?: (f: LoopFinding) => Promise<string | undefined>;
}

/** The id a finding is about, for a rule about one id. */
const recordOf = (f: LoopFinding): string | undefined => {
  if (ABOUT_ONE_ID.has(f.rule)) return f.target.split(":").at(-1);
  return undefined;
};

const RECORD_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** A `path:line` as evidence: the line when there is one. */
const evidenceOf = (at: string) => {
  const m = /^(.*):(\d+)$/.exec(at);
  return m ? { path: m[1]!, line: Number(m[2]) } : { path: at };
};

/** One stage finding as the C3 finding of its stage's gate (ADR 0203 A.2). */
export async function stageFinding(f: LoopFinding, o: ProjectOptions): Promise<Finding> {
  const acceptable = acceptableStageRule(f.rule);
  const id = `stage-${f.fingerprint}`;
  const where = (await o.locate?.(f).catch(() => undefined)) ?? undefined;
  const line = where ? evidenceOf(where).line : undefined;
  const record = recordOf(f);
  const summary = f.message.length <= 200 ? f.message : `${f.message.slice(0, 197)}...`;
  const fix = acceptable
    ? `Fix ${o.source} and run ${o.rerun} again. Or accept it: atticus finding ${o.change} ${id} waive --reason "<why>".`
    : `Fix ${o.source} and run ${o.rerun} again. It can't be accepted: ${wayOn(f.rule)}`;
  return Finding.parse({
    schemaVersion: 1,
    id,
    kind: "issue",
    change: o.change,
    gate: stageGateOf(o.stage),
    round: 1,
    rule: f.rule,
    layer: "org",
    lens: f.rule.startsWith("stories.") ? "complete" : "true",
    severity: "blocking",
    artifact: o.source,
    locator: {
      ...(line ? { line } : { heading: f.target }),
      ...(record && RECORD_ID.test(record) ? { record } : {}),
    },
    summary,
    why: f.message,
    fix: { text: fix },
    evidence: [{ source: "artifact", ...evidenceOf(f.evidence ?? where ?? o.source) }],
    waivable: acceptable,
    state: "open",
    createdAt: o.now,
  });
}

/**
 * Write the stage's gate: the current draft's blocking stage findings, and the ones people
 * accepted that the draft still has (an accepted finding no longer blocks, and must keep its
 * file). A finding keeps the words it was accepted with, so its resolution is carried.
 */
export async function writeStageGate(
  root: string,
  current: LoopFinding[],
  accepted: ReadonlyMap<string, Accepted>,
  o: ProjectOptions,
): Promise<RoundWrite> {
  const fresh: Finding[] = [];
  // The gate says what the current draft has, in its words; an acceptance is carried by the id,
  // which holds what was accepted. One accepted at another stage is that stage's to show.
  for (const f of current) {
    const mine = accepted.get(f.fingerprint)?.stage === o.stage;
    if (f.source === "stage" && (mine || (f.blocking && !accepted.has(f.fingerprint))))
      fresh.push(await stageFinding(f, o));
  }
  return writeGateRound(root, o.change, stageGateOf(o.stage), fresh, o.now, { carryById: true });
}

/**
 * What `atticus change status` says of the acceptances (ADR 0203 A.5), a line a stage: "1 finding
 * accepted at the architecture stage: <rule>, by <who>".
 */
export function acceptedStatus(accepted: ReadonlyMap<string, Accepted>): string[] {
  const by = new Map<string, Accepted[]>();
  for (const a of accepted.values()) by.set(a.stage, [...(by.get(a.stage) ?? []), a]);
  return [...by].map(
    ([stage, list]) =>
      `${list.length} finding${list.length === 1 ? "" : "s"} accepted at the ${stage} stage: ${list.map((a) => `${a.rule}, by ${a.by}`).join("; ")}.`,
  );
}
