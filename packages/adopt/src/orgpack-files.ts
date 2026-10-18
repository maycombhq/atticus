import { join } from "node:path";
import { stringify } from "yaml";
import {
  DEFAULT_CHANGE_TYPES,
  DEFAULT_GATES,
  DEFAULT_ROLES,
  DEFAULT_RUNTIME,
  DEFAULT_TEST_STRATEGY,
  type Sources,
} from "@maycombhq/core";
import type { z } from "zod";
import { writeNew } from "./files.js";

/**
 * The files of a starting org pack, shared by init (a new metarepo) and adopt (`.atticus/`):
 * every built-in default written out as a file, so a team sees what applies and changes it
 * through a PR; a profile and an empty repos manifest for the platform; and a short README
 * in each folder whose loader reads YAML only (never in folders read as Markdown).
 */

const yaml = (data: unknown, header?: string) =>
  `${header ? `# ${header}\n` : ""}${stringify(data, { lineWidth: 0 })}`;

const DEFAULT_HEADER =
  "Built-in default written out by Atticus. Change it through a pull request; delete the file to go back to the default.";

export interface StartingPack {
  name: string;
  platform: string;
  owner: string;
  sources: z.input<typeof Sources>;
  /** Write the default roles, change types, gates, runtime and test strategy as files. */
  defaults: boolean;
  platformName?: string;
}

const FOLDER_READMES: [string, string][] = [
  [
    "checklists/README.md",
    "# Checklists\n\nCritic rule packs (contract C3), one YAML file per pack. The constitution is built in; packs here add organisation rules.\n",
  ],
  [
    "patterns/README.md",
    "# Integration patterns\n\nOne YAML file per approved pattern (`<code>.yaml`). Planned interfaces must name one.\n",
  ],
  [
    "dialects/README.md",
    "# Dialects\n\nRule files that teach the scan a house framework (contract C2). Start one with `atticus dialect new`.\n",
  ],
  [
    "agents/README.md",
    "# Agents\n\nAI agent definitions (contract C5), one YAML file per agent.\n",
  ],
  [
    "process/snow/README.md",
    "# Service-desk templates\n\nOne YAML file per request template. `atticus templates draft` proposes them from wikis and past tickets.\n",
  ],
];

/** Write the starting org pack into `dir`; existing files are kept. Returns the files written. */
export async function writeStartingPack(dir: string, p: StartingPack): Promise<string[]> {
  const files: [string, string][] = [
    [
      "pack.yaml",
      yaml({ schemaVersion: 1, name: p.name, version: "0.1.0", owner: p.owner }, "The org pack."),
    ],
    ["sources.yaml", yaml(p.sources, "Where things are and what Atticus reads.")],
    [
      `profiles/${p.platform}/profile.yaml`,
      yaml({
        schemaVersion: 1,
        platform: p.platform,
        name: p.platformName ?? p.platform,
        systems: [],
      }),
    ],
    [
      `profiles/${p.platform}/repos.manifest.yaml`,
      yaml({ schemaVersion: 1, platform: p.platform, repos: [] }),
    ],
    ...FOLDER_READMES,
  ];
  if (p.defaults)
    files.push(
      ["roles.yaml", yaml(DEFAULT_ROLES, DEFAULT_HEADER)],
      ["change-types.yaml", yaml(DEFAULT_CHANGE_TYPES, DEFAULT_HEADER)],
      ["gates.yaml", yaml(DEFAULT_GATES, DEFAULT_HEADER)],
      ["runtime.yaml", yaml(DEFAULT_RUNTIME, DEFAULT_HEADER)],
      ["test-strategy.yaml", yaml(DEFAULT_TEST_STRATEGY, DEFAULT_HEADER)],
    );
  const written: string[] = [];
  for (const [rel, text] of files)
    if (await writeNew(join(dir, ...rel.split("/")), text)) written.push(rel);
  return written.sort();
}
