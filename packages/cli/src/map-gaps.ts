import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { factsDirOf, factsRelOf, writeFileAtomic } from "@maycombhq/core";
import { estimateTokens } from "@maycombhq/ai";
import {
  planGaps,
  sameCommit,
  type FileSource,
  type GapPlan,
  type GapsFrom,
} from "@maycombhq/verify";
import type { Output } from "./commands.js";

/**
 * R2 (ADR 0157): `atticus map <repo> --gaps`, a second pass on the gaps only, in a fresh session.
 * The first read's session has spent most of its room by the time verify lists what it left, so
 * the lists in `<repo>.verify.yaml` (the files no fact cites, the skipped lines, the reviewed
 * globs holding some, the spec operations no entry covers, the entries no flow follows) are
 * planned for a new chat holding only those files and lines, sized to the session
 * (`sessionTokensFor`), and written as a prompt beside the facts: `<repo>.gaps.md`. Its facts go
 * in the same facts file under the same id rules, as any part's do. The prompt is the first
 * session's; after it, verify and `--gaps` again plan what is left. Atticus reads and writes
 * files only: nothing is run, and the reader starts the chat.
 */

export interface GapsOptions {
  commit: string;
  source: FileSource;
  /** The source one session reads (`sessionTokensFor`). */
  session: number;
  json?: boolean;
}

/** The prompt file's path, relative to the root with forward slashes. */
export const gapsRelOf = (root: string, repo: string) => `${factsRelOf(root)}/${repo}.gaps.md`;

const mtimeOf = async (path: string) => (await stat(path).catch(() => undefined))?.mtimeMs;

export async function mapGaps(
  root: string,
  repo: string,
  o: GapsOptions,
  io: Output,
): Promise<number> {
  const dir = factsDirOf(root);
  const rel = factsRelOf(root);
  const yamlPath = join(dir, `${repo}.verify.yaml`);
  const verifyYaml = `${rel}/${repo}.verify.yaml`;
  const text = await readFile(yamlPath, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(
      `No verify of ${repo} yet (${verifyYaml}): run atticus verify ${repo} first; its lists are the gaps a second pass reads.`,
    );
    return 2;
  }
  const v = (parse(text) ?? {}) as GapsFrom & {
    commit?: string;
    coverage?: { unknown?: string[] };
  };
  if (v.commit && !sameCommit(v.commit, o.commit)) {
    io.err(
      `The last verify of ${repo} was at ${v.commit}, not ${o.commit}: run atticus verify ${repo} at ${o.commit} first.`,
    );
    return 2;
  }
  // The lists are the last verify's: facts or reviewed lines written since may have closed some.
  const verified = (await mtimeOf(yamlPath)) ?? 0;
  for (const side of [`${repo}.jsonl`, `${repo}.reviewed.jsonl`]) {
    const t = await mtimeOf(join(dir, side));
    if (t !== undefined && t > verified) {
      io.err(
        `${rel}/${side} changed since the last verify: run atticus verify ${repo} first, so the gaps are the ones left.`,
      );
      return 2;
    }
  }
  const size = (file: string) => {
    const t = o.source.read(file);
    return t === undefined
      ? undefined
      : { tokens: estimateTokens(t), lines: t.split(/\r?\n/).length };
  };
  const plan = planGaps(
    {
      ...(v.coverage?.unknown ? { unknown: v.coverage.unknown } : {}),
      ...(v.skipped ? { skipped: v.skipped } : {}),
      ...(v.skippedCount !== undefined ? { skippedCount: v.skippedCount } : {}),
      ...(v.reviewedHolds ? { reviewedHolds: v.reviewedHolds } : {}),
      ...(v.specOpsUncovered ? { specOpsUncovered: v.specOpsUncovered } : {}),
      ...(v.specOpsUncoveredCount !== undefined
        ? { specOpsUncoveredCount: v.specOpsUncoveredCount }
        : {}),
      ...(v.entriesNoFlowFollows ? { entriesNoFlowFollows: v.entriesNoFlowFollows } : {}),
    },
    size,
    o.session,
  );
  const promptRel = gapsRelOf(root, repo);
  if (plan.sessions.length)
    await writeFileAtomic(
      join(dir, `${repo}.gaps.md`),
      gapsPrompt(repo, o.commit, plan, { rel, session: o.session }),
    );
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          repo,
          commit: o.commit,
          session: o.session,
          ...plan,
          ...(plan.sessions.length ? { prompt: promptRel } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!plan.sessions.length) {
    io.out(
      `No gaps left in ${repo}: the last verify lists no file no fact cites, no skipped line, no spec operation and no entry to follow.${plan.gone.length ? ` (${plan.gone.length} listed ${plan.gone.length === 1 ? "file is" : "files are"} gone from the checkout.)` : ""}`,
    );
    return 0;
  }
  const n = plan.sessions.length;
  const first = plan.sessions[0]!;
  io.out(
    `Second pass on the gaps of ${repo}: ${plan.files} ${plan.files === 1 ? "file" : "files"}, about ${plan.tokens.toLocaleString("en-US")} tokens, in ${n} ${n === 1 ? "session" : "sessions"} of ${o.session.toLocaleString("en-US")} at most.`,
  );
  io.out(
    `Wrote ${promptRel}: session 1${n > 1 ? ` of ${n}` : ""}, ${first.reads.length} ${first.reads.length === 1 ? "read" : "reads"}, about ${first.tokens.toLocaleString("en-US")} tokens.`,
  );
  if (plan.unlisted)
    io.out(
      `${plan.unlisted} more skipped lines or spec operations are counted in ${verifyYaml} but not listed: verify after this pass and --gaps again plans them.`,
    );
  io.out(
    `Start a new chat, so the session holds only these files and lines, and run /atticus-map ${repo} --gaps there (or paste ${promptRel}).`,
  );
  return 0;
}

/** The prompt for a fresh session: what to read, why, and where its facts go. */
export function gapsPrompt(
  repo: string,
  commit: string,
  plan: GapPlan,
  c: { rel: string; session: number },
): string {
  const n = plan.sessions.length;
  const s = plan.sessions[0]!;
  return [
    `# Second pass on the gaps of ${repo} at ${commit}`,
    "",
    `Session 1${n > 1 ? ` of ${n}` : ""}, about ${s.tokens.toLocaleString("en-US")} tokens of source. The first read is done and verified; this session reads only what it left (ADR 0157). Open each path below and nothing else: a path ending \`#L<from>-L<to>\` by those lines only, never the whole file.`,
    "",
    `- Write each fact to \`${c.rel}/${repo}.jsonl\`, appended, under the same rules and id rules as the first read, with \`commit\` ${commit}. A fact already in the file keeps its id: look for it before you write it.`,
    `- A path or line that holds nothing to record: a line in \`${c.rel}/${repo}.reviewed.jsonl\`, \`{"path": "<the path below>", "why": "..."}\`.`,
    `- Then run \`atticus verify ${repo}\` and fix what it rejects until it exits 0.`,
    ...(n > 1 || plan.unlisted
      ? [`- Then \`atticus map ${repo} --gaps\` plans what is left, for another new chat.`]
      : []),
    "",
    "## Read",
    "",
    ...s.reads.flatMap((r) => [
      `- \`${r.path}\` (about ${r.tokens.toLocaleString("en-US")} tokens)`,
      ...r.why.map((w) => `  - ${w}`),
    ]),
    "",
  ].join("\n");
}
