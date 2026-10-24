/**
 * The words nobody outside Atticus knows (WP5.1), each in one plain sentence: what
 * `atticus explain <term>` says, and the app's "What the words mean" (its copy holds the same
 * list; a test keeps the two equal).
 */

export interface ProductTerm {
  term: string;
  /** Other names people use for it. */
  aliases: string[];
  says: string;
}

export const PRODUCT_TERMS: ProductTerm[] = [
  {
    term: "metarepo",
    aliases: ["meta repo", "meta-repo"],
    says: "The Git repo Atticus keeps for your estate: the catalog read from your repos' code, the changes in flight, the knowledge and the org pack. Its pull requests are how things get approved.",
  },
  {
    term: "org pack",
    aliases: ["org-pack", "orgpack"],
    says: "Your organisation's settings for Atticus, in org-pack/: the repos and their types, the change types, the checklists and how AI runs here, changed through a pull request.",
  },
  {
    term: "catalog",
    aliases: [],
    says: "What Atticus read from your code: systems, components, endpoints, tables, settings and how they connect, each citing the file and line it came from.",
  },
  {
    term: "estate",
    aliases: [],
    says: "All your systems and the repos behind them, as the catalog describes them.",
  },
  {
    term: "flow",
    aliases: [],
    says: "One path through your code from a trigger (an endpoint, a job, a message) to what it reads, writes and returns, step by step, read from the code.",
  },
  {
    term: "change",
    aliases: [],
    says: "A piece of work from idea to release, kept in the metarepo with its brief, its design, its stories and its tasks.",
  },
  {
    term: "target flow",
    aliases: ["target flows"],
    says: "How a flow will run once a change is in: the steps it adds, changes or removes, with what each reads and writes.",
  },
  {
    term: "hand-off",
    aliases: ["handoff", "hand-off pr", "handoff pr", "the pr"],
    says: "The pull request in the metarepo that ends a phase of a change; merging it approves the phase's gate.",
  },
  {
    term: "gate",
    aliases: [],
    says: "The point between two phases of a change where its findings are checked and a person approves, by merging the hand-off pull request.",
  },
  {
    term: "finding",
    aliases: ["findings"],
    says: "Something the critic or a check raised about a change (blocking, a risk, a gap or an idea), citing where it is; a person decides what to do with it.",
  },
  {
    term: "critic",
    aliases: [],
    says: "The AI reviewer that reads a change at a gate, one lens at a time, and raises findings.",
  },
  {
    term: "lens",
    aliases: ["lenses"],
    says: "One way the critic reads a change, such as security, data or architecture, each with its own rules.",
  },
  {
    term: "checking round",
    aliases: [],
    says: "One more critic round after a gate's rounds are used, which reviews only what a person fixed.",
  },
  {
    term: "question",
    aliases: ["questions"],
    says: "Something Atticus asked a person because the code doesn't say, with options and the lines it read; the answer is kept in the metarepo for the steps that read it.",
  },
  {
    term: "knowledge item",
    aliases: ["knowledge items", "knowledge"],
    says: "A fact read from a wiki or a document you added (a process, a standard, a decision, a team), quoted with its page, until a person verifies it.",
  },
  {
    term: "need",
    aliases: ["needs"],
    says: "Something a change needs from the organisation, such as a firewall rule or an access request, with how to ask for it and who handles it.",
  },
  {
    term: "dialect",
    aliases: ["dialects"],
    says: "The rules that tell Atticus's scanner how to read one framework or language, your own house frameworks included.",
  },
  {
    term: "base clone",
    aliases: ["base clones"],
    says: "Atticus's own read-only copy of a repo, in the metarepo's workspace/, which the scans read; it never touches your working copy.",
  },
  {
    term: "slash command",
    aliases: ["slash commands"],
    says: "A command you type in your assistant's chat, such as /atticus-next, that runs one Atticus step with the assistant's model.",
  },
  {
    term: "service desk",
    aliases: ["snow", "servicenow"],
    says: "Your operations ticketing system, where a change's release and access requests are raised.",
  },
];

const fold = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");

/** The term a word names, by its name or another it goes by. */
export function termNamed(word: string): ProductTerm | undefined {
  const w = fold(word);
  return PRODUCT_TERMS.find((t) => fold(t.term) === w || t.aliases.some((a) => fold(a) === w));
}
