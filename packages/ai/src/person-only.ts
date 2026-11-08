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
