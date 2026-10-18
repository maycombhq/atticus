import { parseArgs } from "node:util";
import { SCHEMA_VERSION, orgPackDirOf } from "@maycombhq/core";
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
  assistantFiles,
  driftCommand,
  specHandDown,
  specHandUp,
  taskHandoff,
  taskRun,
} from "./run-commands.js";
import { featureSuggestNames } from "./feature-commands.js";
import { isTaskRun } from "@maycombhq/taskrun";
import { runtimeForCli, RuntimeConfigError } from "@maycombhq/ai";
import {
  adoSync,
  planStories,
  snowDraft,
  snowSubmit,
  storyBarCommand,
  templatesDraft,
} from "./plan-commands.js";
import { executorsCheck, todoDone, todoList, todoRun, todoShow } from "./todo-commands.js";
import {
  absorbCommand,
  adoptCommand,
  initCommand,
  reposDiscoverCommand,
  unadoptCommand,
  zeroInstallCommand,
} from "./setup-commands.js";
import { existsSync } from "node:fs";
import { critic, criticStats, findingAction, findings } from "./critic-commands.js";
import {
  catalogMigrate,
  featureLink,
  featureList,
  featureMerge,
  featureName,
  featureShow,
  featureSpec,
  featureSplit,
  featureSuggestLinks,
  featureTag,
} from "./feature-commands.js";
import {
  changeArchive,
  changeConflicts,
  changeHandoff,
  changeList,
  changeNew,
  changeReturn,
  changeStatus,
  changeSync,
} from "./change-commands.js";
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
  atticus change new "<title>"         Start a change from a template: --type <type> --by <you>
          [--template id] [--id id] [--owner role=a,b]... [--system id]...
  atticus change status <id> [--json]  State, next step, what blocks it, risk, approvals and test kinds
  atticus change handoff <id> --by <you>  Open the phase's hand-off PR for approval [--repo]
  atticus change sync <id> [--by <you>]   Merge an approved hand-off and advance the state [--repo]
  atticus change return <id> --by <you> --reason "<why>"  Return the change to the product owner
  atticus change archive <id> --by <you>  Archive a released change
  atticus change list [--json]         Every change and its state
  atticus change conflicts [--json]    Open changes that touch the same systems, records or repos
  atticus critic <change> [--gate g] [--lens l] [--json]  Review a change at a gate: rule checks, then AI lenses
  atticus critic stats [--json]        How often each rule's findings are dismissed or waived
  atticus findings <change> [--json]   The change's findings by gate and round
  atticus finding <change> <id> <action> --by <you>  apply | edit-and-apply | not-relevant | waive | ask
          [--reason text] [--asked-of who] [--edit patch-file]
  atticus feature list [--json]        Features found in code, named by people or proposed by AI
  atticus feature show <id> [--json]   A feature's entry points, flow, owner, links and gaps
  atticus feature name <id> "<name>"   Confirm or correct a feature's name [--description] [--owner] [--by]
  atticus feature tag <id> <tags...>   Tag a feature [--by]
  atticus feature merge <into> <from...>  Merge features [--by]
  atticus feature split <id> <entry-points...>  Split entry points into another feature [--name] [--into] [--by]
  atticus feature link <id> <ref>      Link a work item or page, e.g. ado:1234 [--title] [--by]
  atticus feature suggest-links [--json]  Suggest links between features and work items
  atticus feature spec <id>            Draft an OpenSpec capability spec from a confirmed feature
  atticus catalog migrate [--dry-run]  Rewrite catalog files to the current schema version
  atticus task run <change> <task> --by <you>  Run a task with AI [--level plan|draft|pr] [--mode m] [--approve]
  atticus spec hand-down <change> <task>  Create the task's Spec Kit feature in its repo [--force]
  atticus spec hand-up <change> <task> --by <you>  Read the Spec Kit feature back at the PR [--pr n --pr-url url]
  atticus drift <change> [--json]      Compare design, repo plans and code
  atticus assistant-files [--repo id [--change id]] [--force] [--check]  Generate Copilot and Claude Code files
  atticus feature suggest-names [--mode m]  Ask AI to propose names for detected features
  atticus plan stories <change>        Write stories, stories.md and tasks.md from the approved design [--force] [--mode m]
  atticus plan snow <change>           Draft service-desk requests the change needs [--force]
  atticus plan bar <change>            Measure the story bar [--eval file]
  atticus plan submit <change>         File the drafted requests [--dry-run] [--approve --by you]
  atticus ado sync <change>            Create or update work items [--dry-run] [--approve --by you] [--epic id]
  atticus templates draft              Draft request and work-item templates from wikis, uploads and past tickets [--no-ai]
  atticus todo [--change id] [--all]   Manual steps waiting for a person
  atticus todo show <step> [--export text|csv|import]
  atticus todo done <step> --by <you>  Record a manual step's result [--result k=v]... [--skip --note why]
  atticus todo run <step> --with <executor>  Run a step with a team's own tool [--approve --by you --inputs sha] [--fill-only]
  atticus executors check              Ping configured executors and show what each covers
  atticus init <name> --platform <p>  Create a new metarepo [--from pack] [--owner who]
  atticus adopt <path>                 Use Atticus in an existing repo; writes only .atticus/ [--platform p] [--name n]
  atticus unadopt <path>               Remove Atticus from an adopted repo, leaving it as it was
  atticus repos discover <folder> | --org <org>  Propose repos.manifest.yaml entries [--platform p] [--dry-run]
  atticus absorb <git-url|path> --id <id>  Translate another team's prompts, agents, checklists, Spec Kit or Atticus repo
          [--mode adopt|link|ignore] [--ref r] [--dry-run]
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
      type: { type: "string" },
      template: { type: "string" },
      id: { type: "string" },
      owner: { type: "string", multiple: true },
      system: { type: "string", multiple: true },
      base: { type: "string" },
      repo: { type: "string" },
      gate: { type: "string" },
      lens: { type: "string" },
      "asked-of": { type: "string" },
      edit: { type: "string" },
      description: { type: "string" },
      title: { type: "string" },
      name: { type: "string" },
      into: { type: "string" },
      level: { type: "string" },
      mode: { type: "string" },
      approve: { type: "boolean" },
      pr: { type: "string" },
      "pr-url": { type: "string" },
      change: { type: "string" },
      check: { type: "boolean" },
      resume: { type: "string" },
      eval: { type: "string" },
      epic: { type: "string" },
      "no-ai": { type: "boolean" },
      export: { type: "string" },
      result: { type: "string", multiple: true },
      skip: { type: "boolean" },
      note: { type: "string" },
      with: { type: "string" },
      inputs: { type: "string" },
      "fill-only": { type: "boolean" },
      platform: { type: "string" },
      ref: { type: "string" },
      org: { type: "string" },
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
  if (group === "init") {
    const owner = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    return initCommand(
      resolve(command ?? "."),
      {
        ...(command ? { name: command } : {}),
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        ...(str(values.from) ? { packFrom: resolve(str(values.from)!) } : {}),
        ...(owner ? { owner } : {}),
        json,
      },
      io,
    );
  }
  if (group === "adopt")
    return adoptCommand(
      resolve(command ?? "."),
      {
        json,
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        ...(str(values.name) ? { name: str(values.name)! } : {}),
      },
      io,
    );
  if (group === "unadopt") return unadoptCommand(resolve(command ?? "."), io);
  if (group === "repos" && command === "discover")
    return reposDiscoverCommand(
      root,
      {
        ...(arg ? { from: resolve(arg) } : {}),
        ...(str(values.org) ? { org: str(values.org)! } : {}),
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        dryRun: values["dry-run"] === true,
        json,
      },
      io,
    );
  if (group === "absorb") {
    if (!command) {
      io.err(
        "absorb needs a git URL or a folder, for example: atticus absorb ../payments-metarepo --id payments",
      );
      return 2;
    }
    return absorbCommand(
      root,
      command,
      {
        ...(str(values.id) ? { id: str(values.id)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(str(values.ref) ? { ref: str(values.ref)! } : {}),
        json,
        dryRun: values["dry-run"] === true,
      },
      io,
    );
  }
  const approver = values.approve === true ? str(values.by) : undefined;
  const dryRun = values["dry-run"] === true;
  if (group === "plan") {
    if (!arg) {
      io.err(
        `plan ${command ?? ""} needs a change id, for example: atticus plan stories add-transfer-limit`.replace(
          "  ",
          " ",
        ),
      );
      return 2;
    }
    if (command === "stories")
      return planStories(
        root,
        arg,
        {
          force: values.force === true,
          ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
          json,
        },
        io,
      );
    if (command === "snow") return snowDraft(root, arg, { force: values.force === true, json }, io);
    if (command === "bar")
      return storyBarCommand(
        root,
        arg,
        { ...(str(values.eval) ? { eval: str(values.eval)! } : {}), json },
        io,
      );
    if (command === "submit")
      return snowSubmit(
        root,
        arg,
        { ...(approver ? { approve: approver } : {}), dryRun, json },
        io,
      );
  }
  if (group === "ado" && command === "sync") {
    if (!arg) {
      io.err("ado sync needs a change id");
      return 2;
    }
    return adoSync(
      root,
      arg,
      {
        ...(approver ? { approve: approver } : {}),
        dryRun,
        ...(str(values.epic) ? { epic: str(values.epic)! } : {}),
        json,
      },
      io,
    );
  }
  if (group === "templates" && command === "draft")
    return templatesDraft(
      root,
      {
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        json,
        noAi: values["no-ai"] === true,
      },
      io,
    );
  if (group === "executors" && command === "check") return executorsCheck(root, { json }, io);
  if (group === "todo") {
    if (!command || command === "list")
      return todoList(
        root,
        {
          json,
          ...(str(values.change) ? { change: str(values.change)! } : {}),
          all: values.all === true,
        },
        io,
      );
    if (!arg) {
      io.err(`todo ${command} needs a step id; see atticus todo`);
      return 2;
    }
    if (command === "show")
      return todoShow(
        root,
        arg,
        { ...(str(values.export) ? { export: str(values.export)! } : {}) },
        io,
      );
    if (command === "done") {
      const results = Array.isArray(values.result) ? (values.result as string[]) : [];
      return todoDone(
        root,
        arg,
        {
          result: results,
          ...(str(values.by) ? { by: str(values.by)! } : {}),
          skip: values.skip === true,
          ...(str(values.note) ? { note: str(values.note)! } : {}),
        },
        io,
      );
    }
    if (command === "run")
      return todoRun(
        root,
        arg,
        {
          ...(str(values.with) ? { with: str(values.with)! } : {}),
          ...(approver ? { approve: approver } : {}),
          ...(str(values.inputs) ? { inputs: str(values.inputs)! } : {}),
          fillOnly: values["fill-only"] === true,
        },
        io,
      );
  }
  if (group === "task" && command === "run")
    return taskRun(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.level) ? { level: str(values.level)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(str(values.by) ? { by: str(values.by)! } : {}),
        approve: values.approve === true,
        json,
      },
      io,
    );
  if (group === "spec" && command === "hand-down")
    return specHandDown(root, arg, positionals[3], { force: values.force === true, json }, io);
  if (group === "spec" && command === "hand-up")
    return specHandUp(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.by) ? { by: str(values.by)! } : {}),
        ...(num(values.pr) ? { pr: num(values.pr)! } : {}),
        ...(str(values["pr-url"]) ? { prUrl: str(values["pr-url"])! } : {}),
        json,
      },
      io,
    );
  if (group === "drift") return driftCommand(root, command, { json }, io);
  if (group === "assistant-files" && existsSync(join(root, ".atticus", "adopted.yaml")))
    return zeroInstallCommand(
      root,
      { check: values.check === true, force: values.force === true },
      io,
    );
  if (group === "assistant-files")
    return assistantFiles(
      root,
      {
        ...(str(values.repo) ? { repo: str(values.repo)! } : {}),
        ...(str(values.change) ? { change: str(values.change)! } : {}),
        force: values.force === true,
        check: values.check === true,
        json,
      },
      io,
    );
  if (group === "catalog" && command === "migrate")
    return catalogMigrate(root, io, { dryRun: values["dry-run"] === true });
  if (group === "feature") {
    const rest = positionals.slice(3);
    const by = str(values.by);
    const firstOwner = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    if (command === "list") return featureList(root, { json }, io);
    if (command === "suggest-links") return featureSuggestLinks(root, { json }, io);
    if (command === "suggest-names") {
      try {
        const { runtime } = await runtimeForCli(root, {
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        });
        return await featureSuggestNames(root, { runtime, json }, io);
      } catch (e) {
        if (e instanceof RuntimeConfigError) {
          io.err(e.message);
          return 2;
        }
        throw e;
      }
    }
    if (!arg) {
      io.err(
        `feature ${command ?? ""} needs a feature id, for example: atticus feature show feature.transfers`,
      );
      return 2;
    }
    if (command === "show") return featureShow(root, arg, { json }, io);
    if (command === "spec") return featureSpec(root, arg, io);
    if (command === "name") {
      if (!rest[0]) {
        io.err(
          'feature name needs a name, for example: atticus feature name feature.transfers "Transfer money"',
        );
        return 2;
      }
      return featureName(
        root,
        arg,
        rest.join(" "),
        {
          ...(by ? { by } : {}),
          ...(str(values.description) ? { description: str(values.description)! } : {}),
          ...(firstOwner ? { owner: firstOwner } : {}),
        },
        io,
      );
    }
    if (command === "tag") return featureTag(root, arg, rest, { ...(by ? { by } : {}) }, io);
    if (command === "merge") return featureMerge(root, arg, rest, { ...(by ? { by } : {}) }, io);
    if (command === "split")
      return featureSplit(
        root,
        arg,
        rest,
        {
          ...(by ? { by } : {}),
          ...(str(values.name) ? { name: str(values.name)! } : {}),
          ...(str(values.into) ? { into: str(values.into)! } : {}),
        },
        io,
      );
    if (command === "link") {
      if (!rest[0]) {
        io.err(
          "feature link needs a reference, for example: atticus feature link feature.transfers ado:1234",
        );
        return 2;
      }
      return featureLink(
        root,
        arg,
        rest[0],
        { ...(by ? { by } : {}), ...(str(values.title) ? { title: str(values.title)! } : {}) },
        io,
      );
    }
  }
  if (group === "critic" && command === "stats") return criticStats(root, { json }, io);
  if (group === "critic") {
    if (!command) {
      io.err(
        "critic needs a change id, for example: atticus critic add-transfer-limit --gate design",
      );
      return 2;
    }
    return critic(
      root,
      command,
      {
        ...(str(values.gate) ? { gate: str(values.gate)! } : {}),
        ...(str(values.lens) ? { lens: str(values.lens)! } : {}),
        json,
      },
      io,
    );
  }
  if (group === "findings") {
    if (!command) {
      io.err("findings needs a change id");
      return 2;
    }
    return findings(root, command, { json }, io);
  }
  if (group === "finding") {
    const [findingId, action] = positionals.slice(2);
    if (!command || !findingId || !action) {
      io.err(
        'finding needs a change, a finding id and an action, for example: atticus finding add-transfer-limit f-1 not-relevant --by you --reason "..."',
      );
      return 2;
    }
    return findingAction(
      root,
      command,
      findingId,
      action,
      {
        ...(str(values.by) ? { by: str(values.by)! } : {}),
        ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
        ...(str(values["asked-of"]) ? { askedOf: str(values["asked-of"])! } : {}),
        ...(str(values.edit) ? { edit: str(values.edit)! } : {}),
      },
      io,
    );
  }
  if (group === "change") {
    const list = (v: unknown) =>
      Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : undefined;
    const repo = str(values.repo);
    if (command === "new")
      return changeNew(
        root,
        {
          ...(arg ? { title: arg } : {}),
          ...(str(values.type) ? { type: str(values.type)! } : {}),
          ...(str(values.template) ? { template: str(values.template)! } : {}),
          ...(str(values.id) ? { id: str(values.id)! } : {}),
          ...(str(values.by) ? { by: str(values.by)! } : {}),
          ...(list(values.owner) ? { owners: list(values.owner)! } : {}),
          ...(list(values.system) ? { systems: list(values.system)! } : {}),
        },
        io,
      );
    if (command === "list") return changeList(root, { json }, io);
    if (command === "conflicts") return changeConflicts(root, { json }, io);
    if (!arg) {
      io.err(
        `change ${command ?? ""} needs a change id, for example: atticus change status add-transfer-limit`,
      );
      return 2;
    }
    const by = str(values.by);
    if (command === "status") return changeStatus(root, arg, { json }, io);
    if (command === "handoff")
      return changeHandoff(
        root,
        arg,
        {
          ...(by ? { by } : {}),
          ...(repo ? { repo } : {}),
          ...(str(values.base) ? { base: str(values.base)! } : {}),
        },
        io,
      );
    if (command === "sync")
      return changeSync(root, arg, { ...(by ? { by } : {}), ...(repo ? { repo } : {}) }, io);
    if (command === "return")
      return changeReturn(
        root,
        arg,
        {
          ...(by ? { by } : {}),
          ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
          ...(repo ? { repo } : {}),
        },
        io,
      );
    if (command === "archive") return changeArchive(root, arg, { ...(by ? { by } : {}) }, io);
  }
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
    return orgPackValidate(arg ? resolve(arg) : join(orgPackDirOf(root)), io);
  if (group === "handoff" && command === "done") {
    if (!arg) {
      io.err(
        "handoff done needs the run id from the prompt, for example: atticus handoff done run-20261018060000-0001",
      );
      return 2;
    }
    if (await isTaskRun(root, arg))
      return taskHandoff(
        root,
        arg,
        {
          ...(str(values.by) ? { by: str(values.by)! } : {}),
          approve: values.approve === true,
          json,
        },
        io,
      );
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
