/**
 * The commands an assistant writing a dialect may run, as one list: the kit's cli.md is
 * generated from it, and the CLI's help lines for these commands should match it.
 */
export interface KitCommand {
  usage: string;
  summary: string;
  details: string[];
}

export const KIT_COMMANDS: readonly KitCommand[] = [
  {
    usage: "atticus dialect new <name> --from <repo>...",
    summary: "Survey the repos and write a starting dialect file, org-pack/dialects/<name>.yaml.",
    details: [
      "Lists what the repos share: a descriptor file present in every repo (proposed as the marker), the source roots and config files, every annotation with its count, attributes, enclosing annotations and a sample line, the descriptor's keys and the config keys.",
      "Writes `appliesTo`, `layout`, one commented candidate rule per framework annotation (each with `TODO`s) and empty `rules` and `tests`. The scaffold is not a valid dialect until you finish it.",
      "Never overwrites an existing file (exit 1). Exit 2 for a bad name or a missing folder.",
    ],
  },
  {
    usage: "atticus dialect test <name>",
    summary: "Check org-pack/dialects/<name>.yaml against contract C2 and run its tests.",
    details: [
      "Prints every schema problem with its path (for example `rules.0.emit.fields.owner`), or `pass` / `FAIL` per test with each failure under it.",
      "Exit 0 when the file is valid and every test passes, 1 otherwise. A dialect whose tests fail is not used by the scanner.",
    ],
  },
  {
    usage: "atticus dialect run <name> <repo> [--json]",
    summary: "Print the records the dialect produces from one repo folder.",
    details: [
      "Each record is printed as YAML you can paste into a test's `expect` list, with the file, line and rule it came from. Use it to see derived Interface ids and to find rules whose templates could not be filled (printed as warnings).",
      "Works before the dialect has tests. Says so when the repo lacks the marker file. Records that fail contract C1 are printed as `invalid:` with the reason, and the exit code is 1.",
      "`--json` prints the full records, evidence included.",
    ],
  },
  {
    usage: "atticus orgpack validate [dir]",
    summary: "Check the whole org pack (default: org-pack) against its schemas, dialects included.",
    details: ["Exit 0 when every file is valid, 1 otherwise."],
  },
];

export function cliMarkdown(): string {
  const L = [
    "# Commands",
    "",
    "These are the commands you need to write and check a dialect. Run them from the folder that holds `org-pack/` (or add `--root <dir>`). Repo folders are paths relative to where you run the command.",
    "",
  ];
  for (const c of KIT_COMMANDS) {
    L.push(`## \`${c.usage}\``, "", c.summary, "", ...c.details.map((d) => `- ${d}`), "");
  }
  L.push(
    "## The loop",
    "",
    "```",
    "atticus dialect new <name> --from repos/a repos/b repos/c   # once",
    "# edit org-pack/dialects/<name>.yaml",
    "atticus dialect run <name> repos/a                          # see what it produces",
    "atticus dialect test <name>                                 # until it passes",
    "```",
    "",
  );
  return L.join("\n");
}

/** The commands an assistant drafting a framework model may run (ADR 0055). */
export const FRAMEWORK_KIT_COMMANDS: readonly KitCommand[] = [
  {
    usage: "atticus frameworks survey [--package <prefix>[,...]] [--json]",
    summary:
      "List the house modules the estate's repos import, in any language, and how each imported name is used.",
    details: [
      "Give the house's own prefixes with `--package` (for example `@tide/,tide.`); without them every import that isn't relative or a well-known library counts.",
      "For each module: its language, how many files and repos import it, the model that already covers it (if any), the names imported, and each use (`useApi(...)`, `lantern.call(...)`, `@InternalApi`, `BankHttp.exchange(...)`) with a count and a sample line.",
      "Reads the base clones; names any repo that isn't cloned.",
    ],
  },
  {
    usage: "atticus frameworks check [name]",
    summary: "Run each framework model's own tests (or one model's).",
    details: [
      "A model fails when a test doesn't give exactly the lines it expects, or when an entry a person or document wrote is exercised by no test.",
      "Exit 0 when every model passes, 1 otherwise. A scan doesn't use a model whose check fails.",
    ],
  },
  {
    usage: "atticus orgpack validate [dir]",
    summary: "Check the whole org pack against its schemas, framework models included.",
    details: ["Exit 0 when every file is valid, 1 otherwise."],
  },
];

export function frameworksCliMarkdown(): string {
  const L = [
    "# Commands",
    "",
    "These are the commands you need to write and check a framework model. Run them from the folder that holds `org-pack/` (or add `--root <dir>`).",
    "",
  ];
  for (const c of FRAMEWORK_KIT_COMMANDS)
    L.push(`## \`${c.usage}\``, "", c.summary, "", ...c.details.map((d) => `- ${d}`), "");
  L.push(
    "## The loop",
    "",
    "```",
    "atticus frameworks survey --package <prefixes>   # once",
    "# write org-pack/frameworks/<name>.yaml, with tests",
    "atticus frameworks check <name>                  # until it passes",
    "```",
    "",
  );
  return L.join("\n");
}
