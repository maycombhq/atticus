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
  /** v30 slice 8: the names this word replaces, as the app says under it. */
  was?: string;
}

export const PRODUCT_TERMS: ProductTerm[] = [
  // v30 slice 8 (docs/guide/words.md): one name per thing; `was` is the names a word replaces,
  // which `atticus explain` finds it by too.
  {
    term: "Map",
    aliases: ["estate canvas", "estate map", "ecosystem map", "the picture", "canvas"],
    says: "The drawing of your estate: a box for each repo and outside system, an arrow for each call between them, each citing its line of code.",
    was: "Estate canvas, Estate map, Ecosystem map, the picture",
  },
  {
    term: "Read status",
    aliases: ["trust"],
    says: "How far each repo was read and checked: what is up to date, behind or read only in part, what was rejected, and what to read again.",
    was: "Trust",
  },
  {
    term: "Cross-check",
    aliases: ["crosscheck"],
    says: "For a repo your assistant read, what the built-in readers found compared with what its facts say. It never changes the map by itself.",
    was: "Readers found / facts say",
  },
  {
    term: "Apply",
    aliases: [],
    says: "Update the map from what was read: verify checks each fact on its cited line and the catalog is built again. The button Apply means only this.",
  },
  {
    term: "Write",
    aliases: ["apply fix", "apply to similar"],
    says: "Save a correction, an answer or a fix into the metarepo's files. It reaches the map when you Apply it.",
    was: "Apply fix, Apply to similar",
  },
  {
    term: "Propose",
    aliases: [],
    says: "Share what you wrote for review, as a pull request a person reviews and merges.",
  },
  {
    term: "your changes",
    aliases: ["curated decision", "corrections and declarations"],
    says: "Everything you told Atticus that the build keeps, in your name: your answers, corrections, declarations, choices on triage items, tags, kept edits and deleted links. Apply puts them on the map; Propose shares them.",
    was: "curated decision, Corrections and declarations",
  },
  {
    term: "your kept edit",
    aliases: ["made curated"],
    says: "A file of the catalog you changed by hand and kept (Keep my edits): one of your changes.",
    was: "made curated",
  },
  {
    term: "decision",
    aliases: [],
    says: "Only the AI's decisions (Decided by AI) and the knowledge kind (decisions and constraints). What you told Atticus is one of your changes, never a decision.",
  },
  {
    term: "Accept",
    aliases: [],
    says: "A person says a stage's blocking finding stands as it is, with a reason, so it no longer holds the stage: Accept… in the stage's thread, or atticus finding <change> <id> waive --reason. Only a person, from the app or a terminal of their own; there is no undo.",
  },
  {
    term: "Waive",
    aliases: [],
    says: "A person says a critic's finding doesn't hold its gate, with a reason: atticus finding <change> <id> waive --reason, the command that accepts a stage's finding too. Only a person; a constitution rule is never waived.",
  },
  {
    term: "call with no arrow",
    aliases: ["loose call"],
    says: "A call read from code whose target Atticus can't tell yet, so the map draws no arrow for it.",
    was: "loose call",
  },
  {
    term: "declared arrow",
    aliases: ["declared link"],
    says: "An arrow a person draws with Connect to… where the code shows no call yet: drawn dashed, marked declared by them, never counted with arrows read from code. Find it in the code looks for the call.",
  },
  {
    term: "loose end",
    aliases: [],
    says: "A call, publish, listener or table use whose other side Atticus can't find; for a call, the map draws no arrow.",
  },
  {
    term: "repo",
    aliases: [],
    says: "A Git repository the manifest lists; a box on the map.",
  },
  {
    term: "outside system",
    aliases: [],
    says: "A system outside your estate that your repos call, named in the profile: a vendor, or another team's service.",
    was: "System, system",
  },
  {
    term: "Activity",
    aliases: [],
    says: "One page for what ran: Model runs, Prompt history, Scans and Catalog builds, a tab each, in Set up.",
    was: "Model runs, Prompt history, Scans and Catalog builds as pages",
  },
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
