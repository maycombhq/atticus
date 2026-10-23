import { commandText } from "./cli";
import type { Expand } from "./sidebar-data";

/**
 * What a person reads between a click and its result (0.3.1): what a run is doing, in plain
 * words; what a section is reading; why it couldn't; what fills a part that is empty; and how a
 * search of the wikis ended. No `vscode` here, so it is tested outside the editor.
 */

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const owner = (s: string) => `${s}'s`;

/** What an AI step is doing while Copilot works on it. */
export function aiProgressTitle(args: string[]): string {
  const [a, b, c] = args;
  const two = `${a} ${b}`;
  const source = flag(args, "--source");
  switch (two) {
    case "knowledge find":
      return `Searching ${source ?? "the wikis"} for “${c}”: Copilot reads the pages that mention it`;
    case "knowledge scan":
      return args.includes("--full")
        ? "Reading every wiki page again with Copilot"
        : `Reading ${source ? `${owner(source)} pages` : "the wiki pages"} with Copilot (only those that changed)`;
    case "knowledge ask":
      return `Asking the knowledge: “${c}”`;
    case "change needs":
      return `Finding what ${c} needs from the organisation, with Copilot`;
    case "scan survey":
      return `Drafting ${owner(c ?? "the repo")} scan settings with Copilot`;
    case "scan verify":
      return `Checking ${owner(c ?? "the repo")} scan against the code with Copilot`;
    case "spec draft":
      return `Drafting ${owner(c ?? "the repo")} spec with Copilot`;
    case "change feature":
      return `Placing ${c} on the flows and features, with Copilot`;
    case "change architecture":
      return `The architecture stage of ${c}, with Copilot`;
    case "change draft":
      return `Drafting ${owner(c ?? "the change")} proposal, spec and interfaces with Copilot`;
    case "plan stories":
      return `Writing ${owner(c ?? "the change")} stories with Copilot`;
  }
  return `Running ${commandText(args)} with Copilot`;
}

/** What a command the extension runs is doing, while it runs. */
export function runProgressTitle(argv: string[]): string {
  const [a, b, c] = argv;
  const dry = argv.includes("--dry-run") ? " (a dry run: nothing is written)" : "";
  const source = flag(argv, "--source");
  switch (`${a} ${b}`) {
    case "sources sync":
      return `Copying ${source ? owner(source) : "every wiki's"} pages (a snapshot)`;
    case "sources add":
      return "Adding the wiki to the knowledge sources";
    case "sources tag":
      return `Tagging ${c}`;
    case "knowledge verify":
      return `Recording that ${c} is right`;
    case "knowledge correct":
      return `Recording your correction of ${c}`;
    case "knowledge reject":
      return `Recording that ${c} is wrong`;
    case "knowledge keep":
      return `Keeping ${c} as a knowledge item you verified`;
    case "knowledge finds":
      return "Reading the searches of the wikis";
    case "knowledge list":
      return "Reading the knowledge items";
    case "needs done":
      return "Recording the need as done";
    case "needs skip":
      return "Recording the need as not needed";
    case "needs reopen":
      return "Opening the need again";
    case "repos discover":
      return dry ? `Looking for repos${dry}` : "Adding the repos to the manifest";
    case "absorb accept":
      return dry ? `Checking what accepting it copies${dry}` : "Copying it into the metarepo";
    case "orgpack draft":
      return "Drafting the org pack's systems from the knowledge items";
    case "orgpack accept":
      return "Putting the systems you picked into profile.yaml";
    case "sandbox create":
      return "Making the practice metarepo (its Forge repos, synced and scanned)";
  }
  switch (a) {
    case "absorb":
      return dry ? `Reading what it holds${dry}` : "Writing the proposal";
    case "scan":
      return "Scanning the repos (files only, no network)";
    case "next":
      return "Reading the next step";
    case "needs":
      return "Reading the needs";
    case "init":
      return "Making the metarepo";
    case "adopt":
      return "Setting up Atticus in the repo";
    case "ask":
      return "Asking the catalog";
  }
  return `Running ${commandText(argv)}`;
}

export type FindOutcome =
  { kind: "nothing"; message: string } | { kind: "saved"; slug: string } | { kind: "unknown" };

/** How `atticus knowledge find` ended, from what it printed. */
export function findOutcome(messages: string[]): FindOutcome {
  const text = messages.join("\n");
  const none = /No page of the wikis mentions "([^"]*)"/.exec(text);
  if (none)
    return {
      kind: "nothing",
      message: `No page of the wikis mentions “${none[1]}”. Nothing was sent to Copilot.`,
    };
  const slug = /finds[\\/]([a-z0-9][a-z0-9-]*)\.ya?ml/i.exec(text)?.[1];
  return slug ? { kind: "saved", slug } : { kind: "unknown" };
}

export type SectionName = "repos" | "changes" | "catalog" | "knowledge";

const READING: Partial<Record<Expand["kind"], string>> = {
  repo: "the repo",
  flows: "the flows",
  flow: "the flow's steps",
  change: "the change",
  findings: "the findings",
  targets: "the target flows",
  tasks: "the tasks",
  sources: "the sources",
  "knowledge-items": "the items",
  "knowledge-group": "the items",
  "last-scan": "what the last scan changed",
  finds: "the searches",
  find: "what it found",
  needs: "what it needs",
  kind: "the records",
  evidence: "the citations",
};

/** The row a section, or a part of one, shows while it reads. */
export function loadingLabel(section: SectionName, expand?: Expand["kind"]): string {
  return `Reading ${expand ? (READING[expand] ?? "it") : `the ${section}`}…`;
}

/** The row shown when a read failed; clicking it shows the Atticus output. */
export const errorLabel = (message: string) =>
  `Couldn't read this: ${message.split("\n")[0]!.trim()}`;

const EMPTY_BELOW: Partial<Record<Expand["kind"], string>> = {
  flows: "No flows yet: draft the repo's spec.",
  flow: "This flow has no steps.",
  findings: "No open findings.",
  tasks: "No tasks yet: the stories stage writes them.",
  targets: "No target flows yet: the feature stage writes them.",
  needs: "No needs: nothing to raise.",
  find: "Nothing found that isn't an item already.",
  "last-scan": "The last scan changed nothing.",
  kind: "No records of this kind.",
  "knowledge-items": "No items yet.",
  "knowledge-group": "No items of these kinds.",
};

/** What a part of a section says when it opens to nothing. */
export const emptyBelow = (kind: Expand["kind"]) => EMPTY_BELOW[kind] ?? "Nothing here yet.";
