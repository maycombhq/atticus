/**
 * The atticus commands that record a person's decision (review round 32): an answer, an
 * acceptance, an audit, a verdict on a knowledge item or finding, a step marked done. Inside a
 * Copilot session Atticus started (ATTICUS_ACP_SESSION), both the session's command check and the
 * CLI itself refuse them, so ingested content can never get the assistant to act as the person.
 * One list, held here.
 */
const flag = (a: readonly string[], ...names: string[]) =>
  a.some((x) => names.some((n) => x === n || x.startsWith(`${n}=`)));

const RULES: { test: (w: readonly string[], a: readonly string[]) => boolean; why: string }[] = [
  { test: (w) => w[0] === "questions" && w[1] === "answer", why: "a person answers questions" },
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
      (w[1] === "activate" || w[1] === "off" || (w[1] === "add" && !flag(a, "--draft"))),
    why: "a person sets a reading rule active or off (a session drafts)",
  },
  {
    test: (w) => w[0] === "initiative" && w[1] === "commit",
    why: "a person records where a commitment stands",
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
];

/** Why the command is a person's to run, or undefined when a session may run it. */
export function personOnlyWhy(argv: readonly string[]): string | undefined {
  const words: string[] = [];
  for (const x of argv) {
    if (x.startsWith("-")) break;
    words.push(x);
  }
  return RULES.find((r) => r.test(words, argv))?.why;
}

/** Files under facts/ that hold a person's record: an audit's answers, a person's corrections. */
export const isPersonsFactsFile = (name: string) =>
  /\.audit\.yaml$|\.corrections\.jsonl$/i.test(name);
