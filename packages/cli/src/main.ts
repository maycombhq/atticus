import { parseArgs } from "node:util";
import { SCHEMA_VERSION } from "@maycombhq/core";
import { catalogValidate, schemaExport, type Output } from "./commands.js";

export const VERSION = "0.0.1";

const HELP = `atticus ${VERSION} (catalog schema v${SCHEMA_VERSION})

Usage:
  atticus schema export [dir]          Write JSON Schema for every catalog record kind (default: ./schema)
  atticus catalog validate <dir>       Check record files: schema, location and canonical form
          [--fix]                      Rewrite files that aren't in canonical form
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
  io.err(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
  return 2;
}
