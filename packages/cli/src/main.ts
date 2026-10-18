import { parseArgs } from "node:util";
import { SCHEMA_VERSION } from "@maycombhq/core";
import { join, resolve } from "node:path";
import { catalogValidate, orgPackValidate, schemaExport, type Output } from "./commands.js";
import {
  handoffDone,
  openspecCheck,
  openspecSetup,
  workspaceOpen,
  workspacePrune,
  workspaceSync,
} from "./workspace-commands.js";
import { catalogDiff, scanCommand } from "./scan-commands.js";
import { impactCommand, indexRebuild, queryCommand } from "./index-commands.js";
import { aliasCommand, reconcileCommand } from "./reconcile-commands.js";
import {
  coverageCommand,
  patternsScan,
  questionsCommand,
  sourcesAdd,
  sourcesSync,
} from "./knowledge-commands.js";
import { diagramLibrary, diagramRender } from "./diagram-commands.js";
import { stubCheck, stubServe } from "./stub-commands.js";
import { intakeAdd, intakeList, triageDecide, triageList } from "./intake-commands.js";
import {
  dialectGrade,
  dialectKit,
  dialectNew,
  dialectRun,
  dialectTest,
} from "./dialect-commands.js";

export const VERSION = "0.0.1";

const HELP = `atticus ${VERSION} (catalog schema v${SCHEMA_VERSION})

Usage:
  atticus schema export [dir]          Write JSON Schema for every contract and the API's OpenAPI document (default: ./schema)
  atticus catalog validate <dir>       Check record files: schema, location and canonical form
          [--fix]                      Rewrite files that aren't in canonical form
  atticus catalog diff <a> <b>         Compare two catalog folders (exit 1 when they differ)
  atticus scan                         Scan every repo's base clone and write catalog/generated
          [--repos a,b]                Only these repos
          [--full]                     Ignore the scan cache
          [--dry-run]                  Show what would change; write nothing
          [--json]                     Print the result as JSON
  atticus query "<query>"              Find records, e.g. "kind:interface via:gateway -has:pattern"
          [--limit n] [--json]         (see docs/query-language.md)
  atticus impact <id>                  What a change to a record reaches, with owners and open questions
          [--depth n] [--json]
  atticus index rebuild                Rebuild the local index from the catalog files
  atticus reconcile [diagram...]       Compare draw.io diagrams with the catalog (default: inputs/diagrams)
          [--json]
  atticus sources add <type> <location> Print the sources.yaml entry for a wiki (markdown-folder, ado-wiki, ...)
  atticus sources sync [--json]        Read the wikis: pages, stale pages, conflicts with code, document-only facts
  atticus patterns scan [--json]       Find integration patterns in the wikis and compare them with the org pack
  atticus coverage [--json]            What the catalog knows per system and area: verified, document-only, unknown
  atticus questions [--json]           Knowledge gaps and the owner questions that close them
  atticus intake add <files...>        Drop documents, specs and diagrams into inputs/inbox for intake
  atticus intake list [--json]         What intake read from inputs/: kinds, systems, duplicates, versions
  atticus triage [--json]              What needs a person: unknown names, conflicts with code, image edges
  atticus triage decide <item> <n>     Choose option n for a triage item; writes a curated decision
          [--by handle] [--reason text]
  atticus diagram render <view|file>   Draw a view (context, container, data, event, sequence) or a .drawio file
          [--focus id] [--format mermaid|drawio] [--out file]
  atticus diagram library <file>       Write the draw.io shape library
  atticus stub serve <spec|id>         Serve a stub of an API from its spec, or from the catalog (--catalog)
          [--port 4010] [--host 127.0.0.1]
  atticus stub check <spec>            Which operations have examples to answer with
  atticus dialect new <name> --from <repo>[,<repo>...]   Scaffold a dialect from sample repos
  atticus dialect test <name>          Run a dialect's own tests
  atticus dialect run <name> <repo>    Show the records a dialect produces from one repo [--json]
  atticus dialect kit [dir]            Export the dialect build kit for an assistant
  atticus alias "<name>" <id>          Record that a name used in diagrams or documents means a catalog id
          [--by handle] [--reason text]
  atticus orgpack validate [dir]       Check an org pack against its schemas (default: <root>/org-pack)
  atticus openspec setup               Set up OpenSpec with the org-flow schema in the metarepo
  atticus openspec check               Check the OpenSpec version and validate every change and spec
  atticus handoff done <run-id>        Tell Atticus a hand-off artifact is written; it validates it
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

/** A positive whole number from an option, or undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

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
      full: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      depth: { type: "string" },
      by: { type: "string" },
      reason: { type: "string" },
      focus: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      catalog: { type: "boolean" },
      from: { type: "string" },
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
  if (group === "catalog" && command === "diff") {
    const b = positionals[3];
    if (!arg || !b) {
      io.err(
        "catalog diff needs two folders, for example: atticus catalog diff catalog/generated /tmp/other",
      );
      return 2;
    }
    return catalogDiff(resolve(arg), resolve(b), values.json === true, io);
  }
  const root = resolve(typeof values.root === "string" ? values.root : process.cwd());
  const repoIds =
    typeof values.repos === "string"
      ? values.repos
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  if (group === "scan")
    return scanCommand(
      root,
      {
        ...(repoIds ? { repos: repoIds } : {}),
        full: values.full === true,
        dryRun: values["dry-run"] === true,
        json: values.json === true,
      },
      io,
    );
  if (group === "query") {
    if (!command) {
      io.err('query needs a query, for example: atticus query "kind:interface via:gateway"');
      return 2;
    }
    return queryCommand(
      root,
      command,
      { json: values.json === true, ...(num(values.limit) ? { limit: num(values.limit)! } : {}) },
      io,
    );
  }
  if (group === "impact") {
    if (!command) {
      io.err("impact needs a record id, for example: atticus impact ledger-db.entry");
      return 2;
    }
    return impactCommand(
      root,
      command,
      { json: values.json === true, ...(num(values.depth) ? { depth: num(values.depth)! } : {}) },
      io,
    );
  }
  if (group === "index" && command === "rebuild") return indexRebuild(root, io);
  if (group === "alias") {
    const target = positionals[2];
    if (!command || !target) {
      io.err(
        'alias needs a name and an id, for example: atticus alias "Ledger Platform" ledger-api',
      );
      return 2;
    }
    return aliasCommand(
      root,
      command,
      target,
      {
        ...(typeof values.by === "string" ? { by: values.by } : {}),
        ...(typeof values.reason === "string" ? { reason: values.reason } : {}),
      },
      io,
    );
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const json = values.json === true;
  if (group === "intake" && command === "add")
    return intakeAdd(
      root,
      positionals.slice(2).map((f) => resolve(f)),
      io,
    );
  if (group === "intake" && command === "list") return intakeList(root, io, { json });
  if (group === "triage" && !command) return triageList(root, io, { json });
  if (group === "triage" && command === "decide") {
    const [item, option] = positionals.slice(2);
    if (!item || !option || !num(option)) {
      io.err(
        "triage decide needs an item id and an option number, for example: atticus triage decide alias-needed.ledger-platform 1",
      );
      return 2;
    }
    return triageDecide(
      root,
      item,
      num(option)!,
      {
        ...(str(values.by) ? { by: str(values.by)! } : {}),
        ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
      },
      io,
    );
  }
  if (group === "diagram" && command === "render") {
    if (!arg) {
      io.err("diagram render needs a view or a file, for example: atticus diagram render context");
      return 2;
    }
    return diagramRender(
      root,
      {
        view: arg,
        ...(str(values.focus) ? { focus: str(values.focus)! } : {}),
        ...(str(values.format) ? { format: str(values.format)! } : {}),
        ...(str(values.out) ? { out: str(values.out)! } : {}),
      },
      io,
    );
  }
  if (group === "diagram" && command === "library") {
    if (!arg) {
      io.err(
        "diagram library needs a file to write, for example: atticus diagram library atticus.xml",
      );
      return 2;
    }
    return diagramLibrary(arg, io);
  }
  if (group === "stub" && command === "serve") {
    if (!arg) {
      io.err(
        "stub serve needs a spec file or a catalog id, for example: atticus stub serve api/openapi.yaml",
      );
      return 2;
    }
    return stubServe(
      root,
      arg,
      {
        ...(num(values.port) ? { port: num(values.port)! } : {}),
        ...(str(values.host) ? { host: str(values.host)! } : {}),
        catalog: values.catalog === true,
      },
      io,
    );
  }
  if (group === "stub" && command === "check") {
    if (!arg) {
      io.err("stub check needs a spec file");
      return 2;
    }
    return stubCheck(arg, io);
  }
  if (group === "dialect") {
    const rest = positionals.slice(3);
    if (command === "kit") return dialectKit(resolve(arg ?? "dialect-kit"), io);
    if (!arg) {
      io.err(
        `dialect ${command ?? ""} needs a dialect name, for example: atticus dialect test forge`.replace(
          "  ",
          " ",
        ),
      );
      return 2;
    }
    if (command === "new") {
      const repos = [...(str(values.from)?.split(",") ?? []), ...rest]
        .map((r) => r.trim())
        .filter(Boolean);
      if (repos.length === 0) {
        io.err(
          "dialect new needs sample repos, for example: atticus dialect new forge --from workspace/forge-ledger",
        );
        return 2;
      }
      return dialectNew(root, arg, repos, io);
    }
    if (command === "test") return dialectTest(root, arg, io);
    if (command === "run") {
      if (!rest[0]) {
        io.err(
          "dialect run needs a repo folder, for example: atticus dialect run forge workspace/forge-ledger",
        );
        return 2;
      }
      return dialectRun(root, arg, rest[0], { json }, io);
    }
    if (command === "grade") {
      if (!rest[0]) {
        io.err("dialect grade needs a dialect file and an eval folder");
        return 2;
      }
      return dialectGrade(arg, rest[0], io);
    }
  }
  if (group === "sources" && command === "add") {
    const [kind, location] = positionals.slice(2);
    if (!kind || !location) {
      io.err(
        "sources add needs a type and a location, for example: atticus sources add markdown-folder ../wiki",
      );
      return 2;
    }
    return sourcesAdd(root, kind, location, io);
  }
  if (group === "sources" && command === "sync")
    return sourcesSync(root, io, { json: values.json === true });
  if (group === "patterns" && command === "scan")
    return patternsScan(root, io, { json: values.json === true });
  if (group === "coverage") return coverageCommand(root, io, { json: values.json === true });
  if (group === "questions") return questionsCommand(root, io, { json: values.json === true });
  if (group === "reconcile")
    return reconcileCommand(root, positionals.slice(1), { json: values.json === true }, io);
  if (group === "orgpack" && command === "validate")
    return orgPackValidate(arg ? resolve(arg) : join(root, "org-pack"), io);
  if (group === "handoff" && command === "done") {
    if (!arg) {
      io.err(
        "handoff done needs the run id from the prompt, for example: atticus handoff done run-20261018060000-0001",
      );
      return 2;
    }
    return handoffDone(root, arg, io);
  }
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
