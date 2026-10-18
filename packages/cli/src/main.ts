import { parseArgs } from "node:util";
import { SCHEMA_VERSION } from "@maycombhq/core";
import { join, resolve } from "node:path";
import { catalogValidate, orgPackValidate, schemaExport, type Output } from "./commands.js";
import {
  openspecCheck,
  openspecSetup,
  workspaceOpen,
  workspacePrune,
  workspaceSync,
} from "./workspace-commands.js";

export const VERSION = "0.0.1";

const HELP = `atticus ${VERSION} (catalog schema v${SCHEMA_VERSION})

Usage:
  atticus schema export [dir]          Write JSON Schema for catalog records and workspace files (default: ./schema)
  atticus catalog validate <dir>       Check record files: schema, location and canonical form
          [--fix]                      Rewrite files that aren't in canonical form
  atticus orgpack validate [dir]       Check an org pack against its schemas (default: <root>/org-pack)
  atticus openspec setup               Set up OpenSpec with the org-flow schema in the metarepo
  atticus openspec check               Check the OpenSpec version and validate every change and spec
  atticus workspace sync               Clone or update the base clone of every repo in the manifests
          [--repos a,b]                Only these repos
  atticus workspace open <change>      Create the change's worktrees, repos.yaml and editor workspaces
          --repos a,b                  The repos the change touches
  atticus workspace prune <change>     Remove worktrees whose PRs merged or closed
          [--all] [--force]            All worktrees; also those with uncommitted work

  --root <dir>                         The metarepo (default: the current folder)
  atticus --version                    Print the version
  atticus --help                       Show this help

More commands arrive as the build progresses; see the plan's command reference.`;

/** Run the CLI. Returns the process exit code: 0 ok, 1 problems found, 2 usage error. */
export async function main(argv: string[], io: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      fix: { type: "boolean" },
      root: { type: "string" },
      repos: { type: "string" },
      all: { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: false,
  });

  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  const [group, command, arg] = positionals;
  if (values.help || !group) {
    io.out(HELP);
    return 0;
  }
  if (group === "schema" && command === "export") {
    await schemaExport(arg ?? "schema", io);
    return 0;
  }
  if (group === "catalog" && command === "validate") {
    if (!arg) {
      io.err(
        "catalog validate needs a folder, for example: atticus catalog validate catalog/generated",
      );
      return 2;
    }
    const s = await catalogValidate(arg, { fix: values.fix === true }, io);
    return s.invalid + s.misplaced + s.notCanonical > 0 ? 1 : 0;
  }
  const root = resolve(typeof values.root === "string" ? values.root : process.cwd());
  const repoIds =
    typeof values.repos === "string"
      ? values.repos
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  if (group === "orgpack" && command === "validate")
    return orgPackValidate(arg ? resolve(arg) : join(root, "org-pack"), io);
  if (group === "openspec" && command === "setup") return openspecSetup(root, io);
  if (group === "openspec" && command === "check") return openspecCheck(root, io);
  if (group === "workspace" && command === "sync") return workspaceSync(root, repoIds, io);
  if (group === "workspace" && (command === "open" || command === "prune")) {
    if (!arg) {
      io.err(
        `workspace ${command} needs a change id, for example: atticus workspace ${command} add-transfer-limit`,
      );
      return 2;
    }
    if (command === "open") return workspaceOpen(root, arg, repoIds, io);
    return workspacePrune(
      root,
      arg,
      { all: values.all === true, force: values.force === true },
      io,
    );
  }
  io.err(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
  return 2;
}
