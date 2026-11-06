import {
  effectiveRules,
  orgRulesLacking,
  readingRulesText,
  ruleIds,
  ruleMatches,
  type EffectiveRules,
} from "./reading-rules.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_RULE, neutralise, wrapData } from "@maycombhq/ai";
import {
  FACT_RULES_HASH,
  RULE_SETS,
  factRulesFor,
  factsReference,
  ruleSetKinds,
  rulesLacking,
  rulesNow,
  topUpWords,
  type RuleSet,
} from "@maycombhq/assistant-files";
import {
  citedFiles,
  factsDirOf,
  factsRelOf,
  parseFacts,
  writeFileAtomic,
  type Conventions,
  type Fact,
} from "@maycombhq/core";
import {
  fileKinds,
  kindsOf,
  lineRangeOf,
  planBatches,
  readingRank,
  sameCommit,
  type FileSource,
} from "@maycombhq/verify";
import type { Output } from "./commands.js";
import {
  loadReadPlan,
  modelsModeOf,
  recordNotReached,
  saveReadPlan,
  type ModelsMode,
  type ReadPlanFileT,
  type TopUpT,
} from "./map-parts.js";
import { MODELS_RULE, modelsData, reachPlanOf, type ReachPlan } from "./map-reach.js";

/**
 * ADR 0167: a top-up for the reading rules added since a repo was read. A read records the rules
 * it was given (the FACT_RULES hash and the rule sets, in its read plan); a repo whose facts are of
 * its clone's commit but whose read lacked a set is `rules-changed`, and is read again for those
 * sets alone: the files they apply to, chosen by the kinds and reading ranks the batch planner
 * already gives a path (never a parser) and by the files its facts cite, in sessions sized to the
 * model, each carrying the core rules and its sets' parts, with the facts kept listed by id. Once a
 * verify passes after the last session, the read records the rules there are now.
 */

/** One file a top-up reads, and the sets it reads it for. */
export interface TopUpFile {
  path: string;
  tokens: number;
  lines: number;
  /** Built-in rule sets, and the organisation's rules by id (`org:<key>@<hash>`, ADR 0176). */
  sets: string[];
}

const has = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/**
 * Whether a set's rules apply to a file: by its kinds and reading rank (`readingRank`: 1 config,
 * 2 entry points, 3 boundaries such as clients, DTOs, mappers and contracts) and the facts citing
 * it. `code` is a file of either side's code; anything else is a structured or build file.
 */
function applies(
  set: RuleSet,
  f: { kinds: readonly string[]; rank: number; code: boolean; cited: ReadonlySet<string> },
): boolean {
  switch (set) {
    case "field-types":
    case "message-types":
      // The bodies and messages: entry points, boundaries (DTOs, models, clients, publishers) and
      // the files a fact of a route, call or field cites; a contract file (proto, Avro, WSDL).
      return f.code
        ? f.rank === 2 ||
            f.rank === 3 ||
            f.cited.has("entry") ||
            f.cited.has("call") ||
            f.cited.has("field")
        : f.rank === 3 && f.kinds.includes("protocols");
    case "mappings":
      // A gateway's policies.
      return f.kinds.includes("gateway");
    case "terms":
      // Identifiers in settings, deploy and gateway files, not code.
      return !f.code && has(f.kinds, ["config", "deploy", "gateway"]);
    case "call-auth":
      // Clients and the settings that build them (a key store, a certificate), and every file a
      // call fact cites; settings and gateway files.
      return f.code
        ? f.rank === 1 || f.rank === 3 || f.cited.has("call")
        : has(f.kinds, ["config", "gateway"]);
  }
}

/** The files a top-up of these sets reads, in reading order, each with the sets it is read for. */
export function topUpFiles(o: {
  facts: readonly Fact[];
  source: FileSource;
  exclude: readonly string[];
  sets: readonly RuleSet[];
  conventions?: Conventions;
  /**
   * ADR 0169: the reach over the repo's files: the model classes it leaves out aren't read, and
   * the entry points, clients and the classes they reach come first.
   */
  reach?: ReachPlan;
}): TopUpFile[] {
  const whole = planBatches(o.source, {
    room: Number.MAX_SAFE_INTEGER,
    exclude: o.exclude,
    ...(o.conventions ? { conventions: o.conventions } : {}),
    ...(o.reach?.reach.rooted && o.reach.reach.models
      ? { reach: { first: o.reach.first, leaveOut: o.reach.leaveOut } }
      : {}),
  });
  const cites = new Map<string, Set<string>>();
  for (const f of o.facts)
    for (const p of citedFiles(f)) {
      const k = cites.get(p) ?? new Set<string>();
      k.add(f.kind);
      cites.set(p, k);
    }
  const out: TopUpFile[] = [];
  for (const slice of whole.batches.flat()) {
    const path = slice.path;
    const rank = readingRank(path);
    // Tests are never read for facts.
    if (rank === 5) continue;
    const kinds = fileKinds(path);
    const of = {
      kinds,
      rank,
      code: kinds.includes("backend") || kinds.includes("frontend"),
      cited: cites.get(path) ?? new Set<string>(),
    };
    // Each set's own kinds too: a set is never read in a file of no kind it is for.
    const sets = o.sets.filter((s) => has(kinds, ruleSetKinds(s)) && applies(s, of));
    if (sets.length) out.push({ path, tokens: slice.tokens, lines: slice.of, sets });
  }
  return out;
}

/** The sets a top-up's files are read for, in RULE_SETS order, then the organisation's rules. */
export function ruleSetsOfFiles(files: readonly { sets: readonly string[] }[]): string[] {
  const all = new Set(files.flatMap((f) => f.sets));
  return [
    ...RULE_SETS.filter((x) => all.has(x)),
    ...[...all].filter((x) => x.startsWith("org:")).sort(),
  ];
}

/**
 * The sessions of a top-up, sized to the session's source: files in reading order, a file bigger
 * than a session in line ranges (`#L<from>-L<to>`), as the read plan cuts them.
 */
export function topUpSessions(files: readonly TopUpFile[], room: number): TopUpT["sessions"] {
  const reads: { path: string; file: string; tokens: number; sets: string[] }[] = [];
  for (const f of files) {
    if (f.tokens <= room || f.lines <= 1) {
      reads.push({ path: f.path, file: f.path, tokens: f.tokens, sets: f.sets });
      continue;
    }
    const per = Math.max(1, Math.floor((f.lines * room) / f.tokens));
    for (let from = 1; from <= f.lines; from += per) {
      const to = Math.min(f.lines, from + per - 1);
      reads.push({
        path: `${f.path}#L${from}-L${to}`,
        file: f.path,
        tokens: Math.ceil((f.tokens * (to - from + 1)) / f.lines),
        sets: f.sets,
      });
    }
  }
  const sessions: { reads: typeof reads; tokens: number }[] = [];
  for (const r of reads) {
    const last = sessions.at(-1);
    if (last && last.tokens + r.tokens <= room) {
      last.reads.push(r);
      last.tokens += r.tokens;
    } else sessions.push({ reads: [r], tokens: r.tokens });
  }
  return sessions.map((s) => ({
    paths: s.reads.map((r) => r.path),
    sets: ruleSetsOfFiles(s.reads),
    files: new Set(s.reads.map((r) => r.file)).size,
    tokens: s.tokens,
  }));
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** The facts on file, or why they can't be topped up. */
async function factsOf(root: string, repo: string): Promise<Fact[] | string> {
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(() => "");
  if (!text.trim())
    return `${repo} isn't read yet: atticus map ${repo} reads it, under every rule.`;
  const p = parseFacts(text);
  return p.ok
    ? p.facts
    : `${factsRelOf(root)}/${repo}.jsonl does not read as facts (${p.issues[0]?.message ?? "?"}).`;
}

/**
 * What a repo's top-up is: the sets its read lacks and the files they apply to; an error when the
 * repo isn't read or its clone moved past its facts (a re-read comes first).
 */
export async function topUpOf(
  root: string,
  repo: string,
  o: {
    commit: string;
    facts?: readonly Fact[];
    source: FileSource;
    exclude: readonly string[];
    conventions?: Conventions;
    /** ADR 0169: the model classes to read; left out, the read plan's choice, else reachable. */
    models?: ModelsMode;
  },
): Promise<
  | { lacking: string[]; files: TopUpFile[]; plan?: ReadPlanFileT; reach?: ReachPlan }
  | { error: string }
> {
  const plan = await loadReadPlan(root, repo);
  const builtin = rulesLacking(plan?.rules);
  // G4 (ADR 0176): the organisation's rules the read wasn't given (new, or changed since).
  // A rule that names no files is given to the next whole read, never topped up alone.
  const org = orgRulesLacking(plan?.rules, await effectiveRules(root, repo)).filter(
    (r) => r.files?.length,
  );
  const lacking = [...builtin, ...org.map((r) => r.id)];
  if (!lacking.length) return { lacking, files: [], ...(plan ? { plan } : {}) };
  const facts = o.facts?.length ? [...o.facts] : await factsOf(root, repo);
  if (typeof facts === "string") return { error: facts };
  if (!facts.length) return { error: `${repo} isn't read yet: atticus map ${repo} reads it.` };
  if (!facts.every((f) => sameCommit(f.commit, o.commit)))
    return {
      error: `${repo}'s clone moved past its facts' commit: read what changed first (atticus map ${repo}), then top it up.`,
    };
  const all = planBatches(o.source, {
    room: Number.MAX_SAFE_INTEGER,
    exclude: o.exclude,
    ...(o.conventions ? { conventions: o.conventions } : {}),
  });
  const reach = reachPlanOf({
    paths: all.batches.flat().map((x) => x.path),
    source: o.source,
    facts,
    mode: await modelsModeOf(root, repo, o.models),
  });
  const files = topUpFiles({
    facts,
    source: o.source,
    exclude: o.exclude,
    sets: builtin,
    ...(o.conventions ? { conventions: o.conventions } : {}),
    reach,
  });
  // G4: each organisation rule tops up only the files it names (its globs), in reading order;
  // a rule that names none is given to the next whole read, not a top-up.
  if (org.length) {
    const byPath = new Map(files.map((f) => [f.path, f] as const));
    for (const slice of all.batches.flat()) {
      if (readingRank(slice.path) === 5) continue;
      const ids = org.filter((r) => r.files?.length && ruleMatches(r, slice.path)).map((r) => r.id);
      if (!ids.length) continue;
      const f = byPath.get(slice.path);
      if (f) f.sets.push(...ids);
      else {
        const add = { path: slice.path, tokens: slice.tokens, lines: slice.of, sets: ids };
        byPath.set(slice.path, add);
        files.push(add);
      }
    }
  }
  return { lacking, files, reach, ...(plan ? { plan } : {}) };
}

/** A read plan to record in, the one on file or a new one with no parts (a one-session read). */
const planOr = (
  plan: ReadPlanFileT | undefined,
  repo: string,
  commit: string,
  session: number,
): ReadPlanFileT =>
  plan ?? { schemaVersion: 2, repo, commit, session, plannedAt: stamp(), parts: [] };

/** ADR 0167: the read is recorded as under the rules there are now; a top-up under way is done. */
export async function recordRulesNow(root: string, repo: string, commit: string): Promise<void> {
  const plan = await loadReadPlan(root, repo);
  const { topUp: _t, ...rest } = planOr(plan, repo, commit, 150_000);
  // G4 (ADR 0176): and under the organisation's rules there are now for it.
  const rules = withOrgIds(rulesNow(), ruleIds(await effectiveRules(root, repo)));
  if (
    plan?.rules?.hash === FACT_RULES_HASH &&
    !plan.topUp &&
    rules.sets.every((x) => plan.rules!.sets.includes(x))
  )
    return;
  await saveReadPlan(root, { ...rest, rules });
}

/** A hash of the repo's facts and reviewed lines as they are on disk. */
async function writtenHash(root: string, repo: string): Promise<string> {
  const h = createHash("sha256");
  for (const f of [`${repo}.jsonl`, `${repo}.reviewed.jsonl`])
    h.update(await readFile(join(factsDirOf(root), f), "utf8").catch(() => "")).update("\u0000");
  return h.digest("hex").slice(0, 16);
}

/**
 * ADR 0167, from `atticus verify`: a verify that passed at the top-up's commit after a session
 * was given finds that session done; once every session is, the read records the rules there are
 * now and the top-up is gone.
 */
export async function recordTopUpVerified(
  root: string,
  repo: string,
  o: { commit: string | undefined; now?: string },
): Promise<void> {
  const plan = await loadReadPlan(root, repo);
  const t = plan?.topUp;
  if (!plan || !t || !o.commit || !sameCommit(t.commit, o.commit)) return;
  // beta.17: a session is done only once something was written for it (a fact or a reviewed
  // line) after it was given: a passing verify of a session that read nothing (it stopped over a
  // refusal) leaves it to be given again.
  const now = await writtenHash(root, repo);
  const doneNow = (s: (typeof t.sessions)[number]) =>
    !!s.given && !s.done && (s.before === undefined || s.before !== now);
  if (!t.sessions.some(doneNow)) return;
  const at = o.now ?? stamp();
  const sessions = t.sessions.map((s) =>
    doneNow(s) ? { ...s, done: { at, commit: o.commit! } } : s,
  );
  if (sessions.every((s) => s.done)) {
    const { topUp: _t, ...rest } = plan;
    const sets = [...new Set([...(plan.rules?.sets ?? []), ...t.sets])];
    await saveReadPlan(root, {
      ...rest,
      rules: t.hash === FACT_RULES_HASH ? withOrgIds(rulesNow(), sets) : { hash: t.hash, sets },
    });
    return;
  }
  await saveReadPlan(root, { ...plan, topUp: { ...t, sessions } });
}

/** G4 (ADR 0176): the rules record with the organisation's rule ids it was given kept. */
const withOrgIds = (r: { hash: string; sets: string[] }, had: readonly string[]) => ({
  hash: r.hash,
  sets: [...r.sets, ...[...new Set(had.filter((x) => x.startsWith("org:")))].sort()],
});

/** The prompt file's path, relative to the root with forward slashes. */
export const rulesRelOf = (root: string, repo: string) => `${factsRelOf(root)}/${repo}.rules.md`;

const sameSets = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The top-up a repo needs now: the one under way when it is of this commit, these rules and
 * these sets, else a new one planned (and saved) at `session` tokens a session.
 */
export async function plannedTopUp(
  root: string,
  repo: string,
  o: {
    commit: string;
    source: FileSource;
    exclude: readonly string[];
    conventions?: Conventions;
    session: number;
    /** Plan only: write nothing (map --all --dry-run). */
    dryRun?: boolean;
    /** ADR 0169: the model classes to read. */
    models?: ModelsMode;
  },
): Promise<
  { lacking: string[]; topUp?: TopUpT; facts: Fact[]; reach?: ReachPlan } | { error: string }
> {
  const t = await topUpOf(root, repo, o);
  if ("error" in t) return t;
  if (!t.lacking.length) return { lacking: [], facts: [] };
  const facts = await factsOf(root, repo);
  if (typeof facts === "string") return { error: facts };
  // ADR 0169: the model classes the top-up leaves out, recorded in the plan, never silent.
  if (!o.dryRun && t.reach)
    await recordNotReached(root, repo, {
      commit: o.commit,
      session: o.session,
      models: t.reach.mode,
      ...(t.reach.notReached ? { notReached: t.reach.notReached } : {}),
    });
  const reach = t.reach ? { reach: t.reach } : {};
  const on = (await loadReadPlan(root, repo))?.topUp;
  const same =
    on &&
    sameCommit(on.commit, o.commit) &&
    on.hash === FACT_RULES_HASH &&
    sameSets(on.sets, t.lacking);
  // The top-up under way, unless another --models is asked for now (beta.15): then what is left
  // is planned again under it, the sessions done kept as they are.
  if (same && (!o.models || on.models === o.models))
    return { lacking: t.lacking, topUp: on, facts, ...reach };
  const doneSessions = same ? on.sessions.filter((s) => s.done) : [];
  const read = new Set(doneSessions.flatMap((s) => s.paths));
  const topUp: TopUpT = {
    commit: o.commit,
    hash: FACT_RULES_HASH,
    sets: t.lacking,
    session: o.session,
    plannedAt: stamp(),
    ...(o.models ? { models: o.models } : {}),
    sessions: [
      ...doneSessions,
      ...topUpSessions(
        t.files.filter((f) => !read.has(f.path)),
        o.session,
      ),
    ],
  };
  if (!o.dryRun && topUp.sessions.length)
    await saveReadPlan(root, {
      ...planOr(await loadReadPlan(root, repo), repo, o.commit, o.session),
      topUp,
    });
  return { lacking: t.lacking, topUp, facts, ...reach };
}

/**
 * atticus map <repo> --rules, without a runtime (ADR 0167): the next session of the repo's
 * top-up, written as a prompt beside the facts (`<repo>.rules.md`) for a new chat, as the gaps
 * pass's is. Atticus reads and writes files only: nothing is run, and the reader starts the chat.
 */
export async function mapRules(
  root: string,
  repo: string,
  o: {
    commit: string;
    source: FileSource;
    exclude: readonly string[];
    conventions?: Conventions;
    session: number;
    /** The org notes for the repo (`notesText`), for the terms; empty when there are none. */
    notes: string;
    /** beta.16: the repo's checkout, relative to the metarepo, where the paths are. */
    checkout?: string;
    json?: boolean;
    /** ADR 0169: the model classes to read. */
    models?: ModelsMode;
  },
  io: Output,
): Promise<number> {
  const p = await plannedTopUp(root, repo, o);
  if ("error" in p) {
    io.err(p.error);
    return 2;
  }
  if (!p.lacking.length || !p.topUp) {
    if (o.json) io.out(JSON.stringify({ repo, commit: o.commit, sets: [], sessions: 0 }, null, 2));
    else io.out(`${repo} was read under the reading rules there are now: nothing to top up.`);
    return 0;
  }
  const t = p.topUp;
  if (!t.sessions.length) {
    await recordRulesNow(root, repo, o.commit);
    if (o.json)
      io.out(JSON.stringify({ repo, commit: o.commit, sets: t.sets, sessions: 0 }, null, 2));
    else
      io.out(
        `No file of ${repo} is one the reading rules added since it was read apply to (${t.sets.join(", ")}): its read is recorded as under the rules there are now.`,
      );
    return 0;
  }
  const n = t.sessions.findIndex((s) => !s.done);
  const next = t.sessions[n]!;
  const before = await writtenHash(root, repo);
  const sessions = t.sessions.map((s, i) =>
    i === n ? { ...s, given: stamp(), ...(s.given && s.before ? {} : { before }) } : s,
  );
  const plan = (await loadReadPlan(root, repo))!;
  await saveReadPlan(root, { ...plan, topUp: { ...t, sessions } });
  const rel = rulesRelOf(root, repo);
  await writeFileAtomic(
    join(factsDirOf(root), `${repo}.rules.md`),
    rulesPrompt(repo, o.commit, {
      orgRules: await effectiveRules(root, repo),
      rel: factsRelOf(root),
      session: next,
      n: n + 1,
      of: t.sessions.length,
      facts: p.facts,
      notes: o.notes,
      ...(o.checkout ? { checkout: o.checkout } : {}),
      ...(p.reach ? { reach: p.reach } : {}),
    }),
  );
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          repo,
          commit: o.commit,
          sets: t.sets,
          session: n + 1,
          sessions: t.sessions.length,
          paths: next.paths,
          tokens: next.tokens,
          prompt: rel,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const files = new Set(t.sessions.flatMap((s) => s.paths.map((x) => lineRangeOf(x)?.file ?? x)));
  const tokens = t.sessions.reduce((x, s) => x + s.tokens, 0);
  io.out(
    `Top-up of ${repo} for the reading rules added since it was read (${t.sets.join(", ")}): ${files.size} ${files.size === 1 ? "file" : "files"}, about ${tokens.toLocaleString("en-US")} tokens, in ${t.sessions.length} ${t.sessions.length === 1 ? "session" : "sessions"} of ${o.session.toLocaleString("en-US")} at most.`,
  );
  io.out(
    `Wrote ${rel}: session ${n + 1} of ${t.sessions.length}, ${next.paths.length} ${next.paths.length === 1 ? "read" : "reads"} (${next.sets.join(", ")}), about ${next.tokens.toLocaleString("en-US")} tokens.`,
  );
  io.out(
    `Start a new chat, so the session holds only these files, and run /atticus-map ${repo} --rules there (or paste ${rel}). When atticus verify ${repo} passes after it, the session is done${t.sessions.length > n + 1 ? `; the next is for another new chat` : ` and the read records the rules there are now`}.`,
  );
  return 0;
}

/** A fact as the top-up's list names it: its id, kind and the line it cites. */
const factLine = (f: Fact) => `- ${f.id} (${f.kind}, ${f.cite.file}:${f.cite.line})`;

/** The prompt for one session of a top-up: what to read, the rules to read by, the facts kept. */
export function rulesPrompt(
  repo: string,
  commit: string,
  c: {
    rel: string;
    session: TopUpT["sessions"][number];
    n: number;
    of: number;
    facts: readonly Fact[];
    notes: string;
    /** beta.16: the repo's checkout, relative to the metarepo, where the paths are. */
    checkout?: string;
    /** ADR 0169: the reach, for the reached model classes among the session's files. */
    reach?: ReachPlan;
    /** G4 (ADR 0176): the organisation's rules, for the ones this session tops up. */
    orgRules?: EffectiveRules;
  },
): string {
  const s = c.session;
  const sets = s.sets.filter((x): x is RuleSet => (RULE_SETS as readonly string[]).includes(x));
  const orgIds = new Set(s.sets.filter((x) => x.startsWith("org:")));
  const files = s.paths.map((x) => lineRangeOf(x)?.file ?? x);
  // Rule 6: the paths, the facts' ids and the notes hold text from the repo or the organisation:
  // each goes in a data block, neutralised, as the gaps prompt does.
  const list = s.paths.map((x) => `- \`${x}\``).join("\n");
  const kept = c.facts.filter((f) => citedFiles(f).some((p) => files.includes(p)));
  const block = (id: string, kind: string, origin: string, text: string) =>
    wrapData({ id, kind, origin }, neutralise(text, undefined, { mark: true }).text);
  return [
    `# Top-up of ${repo} at ${commit}`,
    "",
    `Session ${c.n} of ${c.of}, about ${s.tokens.toLocaleString("en-US")} tokens of source. ${topUpWords(s.sets.map((x) => (x.startsWith("org:") ? x.slice(4).split("@")[0]! : x)) as RuleSet[])} Open each path below and nothing else: a path ending \`#L<from>-L<to>\` by those lines only, never the whole file.${c.checkout ? ` The paths are in the repo's checkout, \`${c.checkout}\` in this metarepo: open \`${c.checkout}/<path>\` with your file tools; there is no need to look for it or to run a command.` : ""}`,
    "",
    `- Write each fact to \`${c.rel}/${repo}.jsonl\`, appended, with \`commit\` ${commit}. A kept fact you add to is written again whole, under its id.`,
    `- A path that has nothing to add under these rules: a line in \`${c.rel}/${repo}.reviewed.jsonl\`, \`{"path": "<the path>", "why": "..."}\`. Every path below ends with a fact written or a line there.`,
    `- Then run \`atticus verify ${repo}\` and fix what it rejects until it exits 0: that records this session done${c.of > c.n ? `. The next session is for a new chat: \`/atticus-map ${repo} --rules\` there` : ", and the read as under the rules there are now"}.`,
    "",
    "## The rules",
    "",
    "Each fact has this shape:",
    "",
    factsReference(),
    "",
    factRulesFor(kindsOf(files), undefined, sets),
    "",
    ...(orgIds.size && c.orgRules
      ? [readingRulesText({ rules: c.orgRules.rules, builtinOff: [] }, orgIds), ""]
      : []),
    "## Read",
    "",
    `The paths to open are in the data block below. ${DATA_RULE}`,
    "",
    block(`${repo}.rules`, "rules", `${c.rel}/${repo}.read-plan.yaml`, list),
    "",
    "## Facts already kept (by id; don't write them again)",
    "",
    kept.length
      ? block(`${repo}.kept`, "facts", `${c.rel}/${repo}.jsonl`, kept.map(factLine).join("\n"))
      : "None cite these files.",
    ...(c.notes
      ? [
          "",
          "## The organisation's notes for this repo",
          "",
          block(`${repo}.notes`, "notes", "org-pack", c.notes),
        ]
      : []),
    "",
    ...modelsPart(repo, c.reach, new Set(files)),
  ].join("\n");
}

/** ADR 0169: the reached model classes among a session's files, and the rule for them. */
function modelsPart(repo: string, r: ReachPlan | undefined, files: ReadonlySet<string>) {
  const data = r ? modelsData(repo, r, { only: files }) : undefined;
  return data ? ["## Model classes", "", MODELS_RULE, "", data, ""] : [];
}
