/**
 * The atticus commands that record a person's decision (review round 32): an answer, an
 * acceptance, an audit, a verdict on a knowledge item or finding, a step marked done. Inside a
 * Copilot session Atticus started (ATTICUS_ACP_SESSION), both the session's command check and the
 * CLI itself refuse them, so ingested content can never get the assistant to act as the person.
 * One list, held here.
 */
import { commandWords } from "./cli-options.js";

const flag = (a: readonly string[], ...names: string[]) =>
  a.some((x) => names.some((n) => x === n || x.startsWith(`${n}=`)));

/**
 * A switch given as itself, `--name=` or `--name=true` (review round 47: `--draft=false` is no
 * draft, and the command line reads it as none).
 */
const switchOn = (a: readonly string[], name: string) =>
  a.some(
    (x) => x === name || (x.startsWith(`${name}=`) && /^(true)?$/i.test(x.slice(name.length + 1))),
  );

const RULES: { test: (w: readonly string[], a: readonly string[]) => boolean; why: string }[] = [
  {
    test: (w, a) => w[0] === "change" && w[1] === "release-prs" && flag(a, "--approve"),
    why: "a person raises the release PRs into each repo's default branch (ADR 0184); a session never approves a push or a PR",
  },
  {
    test: (w, a) => w[0] === "task" && w[1] === "run-ready" && flag(a, "--approve"),
    why: "a person approves each ready task's push and PR into the change branch (ADR 0181); a session never approves a push or a PR",
  },
  { test: (w) => w[0] === "questions" && w[1] === "answer", why: "a person answers questions" },
  {
    // ADR 0181: the AI decides as itself, through Atticus; correcting it, spreading the
    // correction and undoing a batch are a person's word.
    test: (w) => w[0] === "questions" && (w[1] === "correct" || w[1] === "undo"),
    why: "a person corrects an AI decision and undoes a batch of decisions (ADR 0181); the AI decides only as itself, through Atticus",
  },
  {
    test: (w, a) => w[0] === "questions" && w[1] === "sheet" && flag(a, "--apply"),
    why: "a person answers questions (questions sheet --apply answers as them)",
  },
  {
    test: (w, a) =>
      w[0] === "verify" &&
      w[1] === "audit" &&
      flag(a, "--right", "--wrong", "--unsure", "--answers"),
    why: "a person answers an audit: its record says who confirmed each fact",
  },
  {
    test: (w) => w[0] === "knowledge" && ["verify", "correct", "reject"].includes(w[1] ?? ""),
    why: "a person verifies, corrects or rejects a knowledge item",
  },
  { test: (w) => w[1] === "accept", why: "a person accepts what is proposed" },
  { test: (w) => w[0] === "baseline", why: "a person accepts the catalog as the baseline" },
  {
    // ADR 0195 point 3: a person checks the cited line, then dismisses what the readers found.
    test: (w, a) =>
      w[0] === "catalog" && w[1] === "crosscheck" && flag(a, "--dismiss", "--undismiss"),
    why: "a person dismisses what the readers found, after checking its line (ADR 0195)",
  },
  {
    // ADR 0195 point 3: promote to assert writes a `by: person` fact; only a person vouches.
    test: (w, a) => w[0] === "catalog" && w[1] === "crosscheck" && flag(a, "--promote"),
    why: "a person promotes what the readers found to their own fact, after checking its line (ADR 0195)",
  },
  { test: (w) => w[0] === "triage" && w[1] === "decide", why: "a person decides a triage item" },
  { test: (w) => w[0] === "finding", why: "a person acts on a finding (it is recorded with them)" },
  {
    test: (w) => w[0] === "feature" && ["name", "link"].includes(w[1] ?? ""),
    why: "a person names a feature or links it to work",
  },
  { test: (w) => w[0] === "todo" && w[1] === "done", why: "a person records a manual step done" },
  {
    test: (w) => {
      const n = w[0] === "change" && w[1] === "needs" ? w.slice(1) : w;
      return n[0] === "needs" && ["done", "skip"].includes(n[1] ?? "");
    },
    why: "a person records a need done or not needed",
  },
  { test: (_w, a) => flag(a, "--by"), why: "--by names a person; a session acts as no one" },
  {
    test: (_w, a) => flag(a, "--approve", "--send"),
    why: "--approve and --send are a person's: a human approves every write to shared systems",
  },
  { test: (_w, a) => flag(a, "--as"), why: "--as names a person; a session acts as no one" },
  {
    test: (w, a) =>
      w[0] === "rules" &&
      (w[1] === "activate" || w[1] === "off" || (w[1] === "add" && !switchOn(a, "--draft"))),
    why: "a person sets a reading rule active or off (a session drafts)",
  },
  {
    test: (w) => w[0] === "initiative" && ["commit", "new", "plan", "request"].includes(w[1] ?? ""),
    why: "a person starts, plans and records an initiative",
  },
  {
    test: (w) => w[0] === "questions" && w[1] === "owner",
    why: "an owner answers a knowledge gap's question",
  },
  { test: (w) => w[0] === "outcome" && w[1] === "record", why: "a person records an outcome" },
  {
    test: (_w, a) => flag(a, "--accept", "--accept-proposal"),
    why: "a person accepts what is proposed (--accept is theirs)",
  },
  {
    test: (w, a) =>
      w[0] === "repo" &&
      (w[1] === "add" || (w[1] === "describe" && flag(a, "--description", "--reject"))),
    why: "a person adds a repo and writes or drops its description (a session drafts with --drafted)",
  },
  {
    test: (w) => w[0] === "knowledge" && w[1] === "keep",
    why: "a person keeps a knowledge item (it is recorded as verified by them)",
  },
  { test: (w) => w[0] === "alias", why: "a person decides what a name means" },
  {
    test: (w) => w[0] === "glossary" && ["define", "link", "alias"].includes(w[1] ?? ""),
    why: "a person defines, links or aliases a glossary term",
  },
  {
    // Seventh UX walk: shown by anyone; set (a handle given) only by a person, as in the app.
    test: (w) => w[0] === "orgpack" && w[1] === "owner" && !!w[2],
    why: "a person says who looks after the org pack",
  },
];

/**
 * The command a line names once a leading `legacy` is dropped, as the CLI's aliasArgv drops it
 * (`atticus legacy <words>` runs <words>; `legacy` alone, or before a flag, is the list). Review
 * round 46: `legacy questions answer` was checked as written, so a session's check let it by.
 */
export function withoutLegacy(argv: readonly string[]): readonly string[] {
  return argv[0] === "legacy" && argv[1] !== undefined && !argv[1].startsWith("-")
    ? argv.slice(1)
    : argv;
}

/**
 * Why the command is a person's to run, or undefined when a session may run it. Its words are
 * the command line's own positionals (review round 47): every option that takes a value takes
 * it, so `questions --option 1 answer q1` is `questions answer`, as the command line runs it.
 */
export function personOnlyWhy(argv: readonly string[]): string | undefined {
  argv = withoutLegacy(argv);
  const words = commandWords(argv);
  return RULES.find((r) => r.test(words, argv))?.why;
}

/** Files under facts/ that hold a person's record: an audit's answers, a person's corrections. */
export const isPersonsFactsFile = (name: string) =>
  /\.audit\.yaml$|\.corrections\.jsonl$/i.test(windowsName(name));

/**
 * Final review: the name Windows opens for a path's last part. It drops trailing dots and spaces,
 * and `name:stream` (`::$DATA`) is the file `name`, so `x.corrections.jsonl.` is that file.
 */
export const windowsName = (name: string) => name.replace(/:.*$/, "").replace(/[. ]+$/, "");
