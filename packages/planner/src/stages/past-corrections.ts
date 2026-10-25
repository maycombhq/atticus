import { estimateTokens, type SourceInput } from "@maycombhq/ai";
import { pastCorrections, type PastCorrection, type Touches } from "@maycombhq/changes";

/**
 * H2: the closest past corrections in a new draft's prompt. A stage (feature, architecture,
 * stories) gets at most two pairs from earlier changes, of the same stage, that share a repo,
 * table, flow, system or entry with what this change touches (`pastCorrections`, from the pairs
 * H1 keeps): what the draft said and what the team merged instead. They are data, quoted as the
 * other sources are, within a share of the stage's budget. Opt-in by data: with no past pair
 * there is no source and no added instruction, so the prompt is byte for byte what it was.
 */

/** At most this many past pairs go in a prompt. */
export const PAST_CORRECTIONS_MAX = 2;
/** The share of the stage's budget the past corrections may take. */
export const PAST_CORRECTIONS_SHARE = 0.05;
/** A hunk longer than this many lines a side is cut, and says so. */
const HUNK_LINES = 8;

/** The trusted line the stage's instructions gain when past corrections are in the prompt. */
export const PAST_CORRECTIONS_RULE =
  "Past corrections (below, as data) show drafts like this one from earlier changes and what the team merged instead. Don't repeat a mistake they corrected; they are examples, not facts about this change.";

const HEADING =
  "Earlier drafts of this stage for changes like this one, and what the team changed before the hand-off merged. Each block quotes the draft's lines and the merged lines in their place.";

const side = (xs: string[]) =>
  (xs.length > HUNK_LINES
    ? [...xs.slice(0, HUNK_LINES), `  … ${xs.length - HUNK_LINES} more lines`]
    : xs
  ).map((l) => `  ${l}`);

function hunkText(path: string, h: PastCorrection["files"][number]["hunks"][number]): string {
  const where = `${path}, line ${h.at}`;
  if (!h.drafted.length) return [`${where}: the team added`, ...side(h.merged)].join("\n");
  if (!h.merged.length) return [`${where}: the team removed`, ...side(h.drafted)].join("\n");
  return [
    `${where}: the draft said`,
    ...side(h.drafted),
    "the team changed it to",
    ...side(h.merged),
  ].join("\n");
}

/** The past corrections as one data source within `tokens`, or undefined when none fits. */
export function pastCorrectionsText(past: PastCorrection[], tokens: number): string | undefined {
  const out: string[] = [HEADING];
  let used = estimateTokens(HEADING);
  let any = false;
  for (const p of past) {
    const head = `\n## ${p.change}, ${p.stage} stage (PR #${p.pr}, merged ${p.mergedAt.slice(0, 10)}); shares ${p.shares.join(", ")}`;
    const blocks: string[] = [];
    let cost = estimateTokens(head);
    for (const f of p.files)
      for (const h of f.hunks) {
        const t = `\n${hunkText(f.path, h)}`;
        const c = estimateTokens(t);
        if (used + cost + c > tokens) break;
        blocks.push(t);
        cost += c;
      }
    if (!blocks.length) continue;
    out.push(head, ...blocks);
    used += cost;
    any = true;
  }
  return any ? out.join("\n") : undefined;
}

/**
 * The stage's past-corrections source and instruction line, or nothing. `budget` is the stage's
 * own (`stageBudget`); the corrections take at most PAST_CORRECTIONS_SHARE of it.
 */
export async function pastCorrectionsSource(
  root: string,
  q: { stage: string; change: string; touches: Touches; budget: number },
): Promise<{ source: SourceInput; rule: string } | undefined> {
  const past = await pastCorrections(root, {
    stage: q.stage,
    change: q.change,
    touches: q.touches,
    max: PAST_CORRECTIONS_MAX,
  }).catch(() => []);
  if (!past.length) return undefined;
  const text = pastCorrectionsText(past, Math.floor(q.budget * PAST_CORRECTIONS_SHARE));
  if (!text) return undefined;
  return {
    source: {
      id: "past-corrections",
      kind: "artifact",
      origin: past.map((p) => `${p.folder}/stage/${p.stage}.drafted/ and .merged/`).join("; "),
      text,
      classification: "internal",
      priority: 60,
    },
    rule: PAST_CORRECTIONS_RULE,
  };
}
