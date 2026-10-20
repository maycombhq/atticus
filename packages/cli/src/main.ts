import { parseArgs } from "node:util";
import { createLog, SCHEMA_VERSION, orgPackDirOf } from "@maycombhq/core";
import { basename, join, resolve } from "node:path";
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
import { askCommand, impactCommand, indexRebuild, queryCommand } from "./index-commands.js";
import { guideCommand, siteBuildCommand } from "./site-commands.js";
import { baselineCommand, setupCommand } from "./baseline-commands.js";
import { digestCommand } from "./digest-commands.js";
import { doctorCommand } from "./doctor.js";
import { supportBundleCommand } from "./support.js";
import { upgradeCommand } from "./upgrade.js";
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
import { registerBuiltInModelProviders } from "@maycombhq/model-providers";
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
  absorbRefreshCommand,
  sourcesRefreshCommand,
  adoptCommand,
  initCommand,
  reposDiscoverCommand,
  unadoptCommand,
  zeroInstallCommand,
} from "./setup-commands.js";
import { existsSync } from "node:fs";
import {
  ciArchiveGate,
  ciDrift,
  ciSnippet,
  glossaryAlias,
  glossaryDefine,
  glossaryLink,
  glossaryList,
  glossaryScan,
  testsGenerate,
  traceCommand,
} from "./quality-commands.js";
import {
  initiativeCommitment,
  initiativeNew,
  initiativePlan,
  initiativeStatus,
  requestFromTeam,
} from "./initiative-commands.js";
import {
  explainCommand,
  learnCheck,
  learnList,
  learnStart,
  sandboxCreate,
} from "./learn-commands.js";
import { defencesScan, evalReport, evalRun } from "./eval-commands.js";
import { conformanceCommand } from "./u1-commands.js";
import {
  outcomeList,
  outcomeRecord,
  releaseEvidenceCommand,
  releaseForecastCommand,
  releaseNotesCommand,
  releasePlanCommand,
  releaseSecurityCommand,
} from "./release-commands.js";
import { uiCommand } from "./ui-commands.js";
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
  dialectTree,
  dialectNew,
  dialectRun,
  dialectTest,
} from "./dialect-commands.js";
import {
  frameworksCheck,
  frameworksDiscover,
  frameworksKit,
  frameworksLearn,
  frameworksSurvey,
} from "./framework-commands.js";
import { onboardAccept, onboardCheck, onboardDraft, onboardEval } from "./onboard-commands.js";

import { VERSION } from "./version.js";
export { VERSION };

const HELP = `atticus ${VERSION} (catalog schema v${SCHEMA_VERSION})

Usage:
  atticus schema export [dir]          Write JSON Schema for every contract and the API's OpenAPI document (default: ./schema)
  atticus catalog validate <dir>       Check record files: schema, location and canonical form
          [--fix]                      Rewrite files that aren't in canonical form
  atticus catalog diff <a> <b>         Compare two catalog folders (exit 1 when they differ)
  atticus scan [--no-drift]            Scan every repo's base clone and write catalog/generated
          [--repos a,b]                Only these repos
          [--full]                     Ignore the scan cache
          [--dry-run]                  Show what would change; write nothing
          [--warnings]                 List what the scan left out or couldn't read, not just how many
          [--json]                     Print the result as JSON
  atticus query "<query>"              Find records, e.g. "kind:interface via:gateway -has:pattern"
          [--limit n] [--json]         (see docs/query-language.md)
  atticus impact <id>                  What a change to a record reaches, with owners and open questions
  atticus ask "<question>"             Answer a plain question from the catalog, showing the query it ran
  atticus setup [--json]               The setup checklist until the catalog is accepted, with a fix for each step
  atticus baseline --by <you>          Accept the as-is catalog as the baseline [--note text] [--site dir]
  atticus doctor [--json]              Check this machine: Node, Git, OpenSpec, proxy, TLS, disk, port, assistant
  atticus upgrade [--check|--dry-run]  Bring the metarepo's files up to this version (backs them up first) [--by you]
  atticus support bundle               Collect versions, checks, counts and the redacted log in a zip [--out f]
  atticus digest --as <you>            What waits on you [--group g]... [--channel c] [--send] [--json]
  atticus guide <system> [--json]      A system's guide, generated from the catalog: parts, calls, data, runtime, decisions
  atticus site build <dir> [--title t] The read-only catalog site as static files (only systems open to everyone)
          [--depth n] [--json]
  atticus index rebuild                Rebuild the local index from the catalog files
  atticus reconcile [diagram...]       Compare draw.io diagrams with the catalog (default: inputs/diagrams)
          [--json]
  atticus sources add <type> <location> Print the sources.yaml entry for a wiki (markdown-folder, ado-wiki, ...)
  atticus sources sync [--json]        Read the wikis: pages, stale pages, conflicts with code, document-only facts
  atticus sources refresh [--json]     Fetch every absorbed source again and show what changed
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
  atticus stub serve <spec|id>         Serve a stub of an API from its spec, or from the catalog (--from-catalog)
          [--port 4010] [--host 127.0.0.1]
  atticus stub check <spec>            Which operations have examples to answer with
  atticus dialect new <name> --from <repo>[,<repo>...]   Scaffold a dialect from sample repos
  atticus dialect test <name>          Run a dialect's own tests
  atticus dialect run <name> <repo>    Show the records a dialect produces from one repo [--json]
  atticus dialect kit [dir]            Export the dialect build kit for an assistant
  atticus dialect tree <file> [--language l]   Print a file's syntax tree, for syntax matches
  atticus onboard <repo> [--name n] [--attempts 3] [--mode m]   Your assistant drafts a dialect for a repo Atticus can't read; checked, kept as a proposal
  atticus onboard check <name> --repo <repo>   Check a proposal (drafted, handed off or hand-written)
  atticus onboard eval <dir> [--mode m] [--json]   Score the assistant's drafts against reference dialects
  atticus onboard accept <name> [--replace]   Accept a proposal into org-pack/dialects/
  atticus frameworks learn <name> --from <repo|jar|tgz>   Learn what a house framework means from its source, JAR or npm package
          [--package a.b] [--dry-run]  (writes org-pack/frameworks/<name>.yaml)
  atticus frameworks discover --group <a.b|@scope>[,...]   The house artifacts and npm packages the repos build on, found here
          [--jars <dir>]... [--learn] [--json]   (.jar and .tgz folders, Maven and Gradle caches, node_modules; never downloads)
  atticus frameworks check [name]      Run each framework model's own tests; a failing model isn't used
  atticus frameworks survey [--package <prefix>[,...]]   How the repos use house frameworks, any language [--json]
  atticus frameworks kit [dir]         Export the framework-model kit for an assistant
  atticus change new "<title>"         Start a change from a template: --type <type> --by <you>
          [--template id] [--id id] [--owner role=a,b]... [--system id]...
  atticus change status <id> [--json]  State, next step, what blocks it, risk, approvals and test kinds
  atticus change handoff <id> --by <you>  Open the phase's hand-off PR for approval [--repo]
  atticus change sync <id> [--by <you>]   Merge an approved hand-off and advance the state [--repo]
  atticus change return <id> --by <you> --reason "<why>"  Return the change to the product owner
  atticus change archive <id> --by <you> [--no-rescan]  Archive a released change and rescan its repos
  atticus change list [--json]         Every change and its state
  atticus change conflicts [--json]    Open changes that touch the same systems, records or repos
  atticus critic <change> [--gate g] [--lens l] [--mode m] [--json]  Review a change at a gate: rule checks, then AI lenses (--mode runs them)
  atticus critic <change> [--gate g] --resume  Read in the AI lens answers your assistant wrote (hand-off); handoff done does it per lens
  atticus critic stats [--json]        How often each rule's findings are dismissed or waived
  atticus findings <change> [--json]   The change's findings by gate and round
  atticus finding <change> <id> <action> --by <you>  apply | edit-and-apply | not-relevant | waive | ask
          [--gate g] [--reason text] [--asked-of who] [--edit patch-file]
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
  atticus init <folder> --platform <p>  Create a new metarepo named after the folder [--from pack] [--owner who]
  atticus adopt <path>                 Use Atticus in an existing repo; writes only .atticus/ [--platform p] [--name n]
  atticus unadopt <path>               Remove Atticus from an adopted repo, leaving it as it was
  atticus repos discover <folder> | --org <org>  Propose repos.manifest.yaml entries [--platform p] [--dry-run]
  atticus absorb <git-url|path> --id <id>  Translate another team's prompts, agents, checklists, Spec Kit or Atticus repo
  atticus absorb --refresh <id>        Fetch an absorbed source again and update its proposal
          [--mode adopt|link|ignore] [--ref r] [--dry-run]
  atticus tests generate <change> <story>  Generate tests from a story [--framework id] [--force] [--check] [--mode m]
  atticus trace <change> [--json] [--csv] [--no-write]  Requirement → story → test → code → records → feature
  atticus release plan <change> [--json]  Deploy order across the repos, why, rollback per step, waits and release sections
  atticus release forecast <change> [--json]  Forecast ready-to-release day from lead times and the initiative's plan
  atticus release evidence <change> [--out dir] [--json]  The evidence pack for an approval board or an audit
  atticus release notes <change> [--audience business|technical] [--json]  Release notes from the brief, interfaces and data
  atticus release security <change> [--json]  Security review draft: auth, classifications, boundaries, vendors, secrets
  atticus outcome list [--change id] [--json]  The brief's success measures and the values recorded after release
  atticus outcome record <change> <measure> --value <v> --by <you>  Record a measured outcome [--note text]
  atticus ci drift [repo] --catalog <path>  In a repo's pipeline: compare the repo with the committed catalog
          [--repo id] [--json [file]] [--junit file] [--summary file] [--warn-only]
  atticus ci snippet <github|azure|gitlab|jenkins> [--write dir]  Pipeline template for the drift check
  atticus ci archive-gate <change> [--drift file]...  Whether a change may be archived
  atticus glossary list|scan [--json]  Business terms from wikis, code and people
  atticus glossary define <term> "<definition>" --by <you> [--owner team]
  atticus glossary link <term> <record-id|schema#field> --by <you>
  atticus glossary alias <term> <name>... --by <you>
  atticus initiative new "<title>" --journey <j> --by <you>  Start an initiative [--id] [--release YYYY-MM-DD] [--epic]
  atticus initiative plan <id> --target <system> --by <you>  Plan its changes and commitments [--release d] [--system s]... [--dry-run]
  atticus initiative status <id>       Critical path, at-risk and slipped commitments
  atticus initiative request <id> <party> --by <you>  Send a team a system card and track the reply [--system s]...
  atticus initiative commit <commitment> <open|at-risk|done|slipped> --by <you>
  atticus learn [list] | learn start <role|lesson> | learn check [--answer a] [--lesson l] [--step s]
  atticus sandbox create <dir>         A throwaway practice metarepo
  atticus explain <id|command>         Explain a record, finding, change or command in plain words
  atticus eval run [--agent a]... [--mode mock|replay|live] [--runs n]  Evaluate AI agents
  atticus eval report                  The latest eval results and AI quality
  atticus defences scan [path] [--all] Look for instructions hidden in documents and prompts
  atticus conformance <path> --kind <catalog|org-pack|dialect|plugin|executor>
                                       Check a catalog, org pack, dialect, plugin or executor against the spec
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
  atticus ui [--port n] [--open]       Start the app on this machine (127.0.0.1); Ctrl+C stops it
  atticus --version                    Print the version
  atticus --help                       Show this help

Every command is described in docs/guide/commands.md; atticus explain <command> says more.`;

/** A positive whole number from an option, or undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 problems found, 2 usage error. */
/**
 * Run `atticus <argv>`. What ran, how it ended and how long it took go to the metarepo's local
 * log (ADR 0050): the command and its flag names, never their values. A crash is logged with
 * its stack and rethrown, carrying the log's path for the message the person sees.
 */
export async function main(
  argv: string[],
  io: Output,
  o: { quiet?: boolean } = {},
): Promise<number> {
  const started = Date.now();
  // runtime.yaml adapters.model.type anthropic, openai-compatible, azure-openai and bedrock work
  // out of the box (ADR 0065); every command that builds a runtime finds them registered.
  registerBuiltInModelProviders();
  const words = argv.filter((a) => !a.startsWith("-")).slice(0, 2);
  const flags = [
    ...new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]!)),
  ];
  const rootAt = argv.indexOf("--root");
  const root = resolve(rootAt >= 0 && argv[rootAt + 1] ? argv[rootAt + 1]! : process.cwd());
  const log = () =>
    isMetarepoRoot(root) ? createLog(root, o.quiet ? { level: "warn" } : {}) : undefined;
  try {
    const code = await dispatch(argv, io);
    log()?.info("command", { command: words.join(" "), flags, code, ms: Date.now() - started });
    return code;
  } catch (e) {
    const l = log();
    l?.error("crash", e, { command: words.join(" "), flags, ms: Date.now() - started });
    if (l && e instanceof Error) (e as Error & { logFile?: string }).logFile = l.file;
    throw e;
  }
}

/** A metarepo, or a repo adopted in place: where Atticus keeps a log. */
function isMetarepoRoot(root: string): boolean {
  return existsSync(join(root, "org-pack")) || existsSync(join(root, ".atticus", "org-pack"));
}

async function dispatch(argv: string[], io: Output): Promise<number> {
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
      kind: { type: "string" },
      executor: { type: "string" },
      fixture: { type: "string" },
      force: { type: "boolean" },
      full: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      depth: { type: "string" },
      by: { type: "string" },
      as: { type: "string" },
      group: { type: "string", multiple: true },
      channel: { type: "string" },
      send: { type: "boolean" },
      site: { type: "string" },
      reason: { type: "string" },
      focus: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean" },
      host: { type: "string" },
      catalog: { type: "string" },
      "from-catalog": { type: "boolean" },
      from: { type: "string" },
      package: { type: "string" },
      jars: { type: "string", multiple: true },
      learn: { type: "boolean" },
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
      attempts: { type: "string" },
      language: { type: "string" },
      replace: { type: "boolean" },
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
      "no-drift": { type: "boolean" },
      warnings: { type: "boolean" },
      "no-rescan": { type: "boolean" },
      refresh: { type: "string" },
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
      framework: { type: "string" },
      csv: { type: "boolean" },
      "no-write": { type: "boolean" },
      junit: { type: "string" },
      summary: { type: "string" },
      "json-out": { type: "string" },
      "warn-only": { type: "boolean" },
      write: { type: "string" },
      drift: { type: "string", multiple: true },
      journey: { type: "string" },
      release: { type: "string" },
      target: { type: "string" },
      answer: { type: "string" },
      lesson: { type: "string" },
      step: { type: "string" },
      agent: { type: "string", multiple: true },
      runs: { type: "string" },
      audience: { type: "string" },
      value: { type: "string" },
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
        noDrift: values["no-drift"] === true,
        warnings: values.warnings === true,
      },
      io,
    );
  if (group === "setup" && !command) return setupCommand(root, { json: values.json === true }, io);
  if (group === "doctor") return doctorCommand(root, { json: values.json === true }, io);
  if (group === "upgrade")
    return upgradeCommand(
      root,
      {
        check: values.check === true,
        dryRun: values["dry-run"] === true,
        ...(typeof values.by === "string" && values.by ? { by: values.by } : {}),
        json: values.json === true,
      },
      io,
    );
  if (group === "support" && command === "bundle")
    return supportBundleCommand(
      root,
      {
        ...(typeof values.out === "string" && values.out ? { out: values.out } : {}),
        json: values.json === true,
      },
      io,
    );
  if (group === "baseline")
    return baselineCommand(
      root,
      {
        ...(typeof values.by === "string" && values.by ? { by: values.by } : {}),
        ...(typeof values.note === "string" && values.note ? { note: values.note } : {}),
        ...(typeof values.site === "string" && values.site ? { site: values.site } : {}),
      },
      io,
    );
  if (group === "digest")
    return digestCommand(
      root,
      {
        ...(typeof values.as === "string" && values.as ? { as: values.as } : {}),
        groups: Array.isArray(values.group) ? values.group.map(String) : [],
        ...(typeof values.channel === "string" && values.channel
          ? { channel: values.channel }
          : {}),
        send: values.send === true,
        json: values.json === true,
      },
      io,
    );
  if (group === "guide") return guideCommand(root, command, { json: values.json === true }, io);
  if (group === "site" && command === "build")
    return siteBuildCommand(
      root,
      positionals[2],
      { ...(typeof values.title === "string" && values.title ? { title: values.title } : {}) },
      io,
    );
  if (group === "ask") {
    if (!command) {
      io.err('ask needs a question, for example: atticus ask "who calls ledger-api?"');
      return 2;
    }
    return askCommand(root, command, { json: values.json === true }, io);
  }
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
  if (group === "initiative") {
    const by = str(values.by);
    const systems = Array.isArray(values.system) ? (values.system as string[]) : [];
    if (command === "new")
      return initiativeNew(
        root,
        {
          ...(arg ? { title: positionals.slice(2).join(" ") } : {}),
          ...(str(values.journey) ? { journey: str(values.journey)! } : {}),
          ...(by ? { by } : {}),
          ...(str(values.id) ? { id: str(values.id)! } : {}),
          ...(str(values.release) ? { release: str(values.release)! } : {}),
          ...(str(values.epic) ? { epic: str(values.epic)! } : {}),
          json,
        },
        io,
      );
    if (command === "plan")
      return initiativePlan(
        root,
        arg,
        {
          ...(str(values.target) ? { target: str(values.target)! } : {}),
          ...(str(values.release) ? { release: str(values.release)! } : {}),
          ...(systems.length ? { systems } : {}),
          ...(by ? { by } : {}),
          dryRun: values["dry-run"] === true,
          json,
        },
        io,
      );
    if (command === "status") return initiativeStatus(root, arg, { json }, io);
    if (command === "request")
      return requestFromTeam(
        root,
        arg,
        positionals[3],
        { ...(by ? { by } : {}), ...(systems.length ? { systems } : {}), json },
        io,
      );
    if (command === "commit")
      return initiativeCommitment(root, arg, positionals[3], { ...(by ? { by } : {}) }, io);
  }
  if (group === "learn") {
    if (!command || command === "list") return learnList(root, { json }, io);
    if (command === "start") return learnStart(root, arg, { json }, io);
    if (command === "check")
      return learnCheck(
        root,
        {
          ...(str(values.answer) ? { answer: str(values.answer)! } : {}),
          ...(str(values.lesson) ? { lesson: str(values.lesson)! } : {}),
          ...(str(values.step) ? { step: str(values.step)! } : {}),
          json,
        },
        io,
      );
  }
  if (group === "sandbox" && command === "create")
    return sandboxCreate(arg ? resolve(arg) : undefined, { json }, io);
  if (group === "explain")
    return explainCommand(root, positionals.slice(1).join(" ") || undefined, { json }, io);
  if (group === "eval" && command === "run")
    return evalRun(
      root,
      {
        ...(Array.isArray(values.agent) ? { agent: values.agent as string[] } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(num(values.runs) ? { runs: num(values.runs)! } : {}),
        json,
      },
      io,
    );
  if (group === "eval" && command === "report") return evalReport(root, { json }, io);
  if (group === "ui")
    return uiCommand(
      root,
      {
        // --port 0 asks for any free port.
        ...(values.port === "0"
          ? { port: 0 }
          : num(values.port)
            ? { port: num(values.port)! }
            : {}),
        open: values.open === true,
        version: VERSION,
      },
      io,
    );
  if (group === "conformance") {
    if (!command) {
      io.err(
        "conformance needs a folder or file to check, for example: atticus conformance catalog --kind catalog",
      );
      return 2;
    }
    return conformanceCommand(
      command,
      {
        ...(str(values.kind) ? { kind: str(values.kind)! } : {}),
        ...(str(values.executor) ? { executor: str(values.executor)! } : {}),
        ...(str(values.fixture) ? { fixture: str(values.fixture)! } : {}),
        json,
      },
      io,
    );
  }
  if (group === "defences" && command === "scan")
    return defencesScan(
      root,
      arg ? resolve(arg) : undefined,
      { json, all: values.all === true },
      io,
    );
  if (group === "tests" && command === "generate")
    return testsGenerate(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.framework) ? { framework: str(values.framework)! } : {}),
        force: values.force === true,
        check: values.check === true,
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
        json,
      },
      io,
    );
  if (group === "trace")
    return traceCommand(
      root,
      command,
      { json, csv: values.csv === true, write: values["no-write"] !== true },
      io,
    );
  if (group === "release") {
    if (command === "plan") return releasePlanCommand(root, arg, { json }, io);
    if (command === "forecast") return releaseForecastCommand(root, arg, { json }, io);
    if (command === "evidence")
      return releaseEvidenceCommand(
        root,
        arg,
        { ...(str(values.out) ? { out: str(values.out)! } : {}), json },
        io,
      );
    if (command === "notes")
      return releaseNotesCommand(
        root,
        arg,
        { ...(str(values.audience) ? { audience: str(values.audience)! } : {}), json },
        io,
      );
    if (command === "security") return releaseSecurityCommand(root, arg, { json }, io);
  }
  if (group === "outcome" && (!command || command === "list"))
    return outcomeList(
      root,
      { ...(str(values.change) ? { change: str(values.change)! } : {}), json },
      io,
    );
  if (group === "outcome" && command === "record")
    return outcomeRecord(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.value) ? { value: str(values.value)! } : {}),
        ...(str(values.by) ? { by: str(values.by)! } : {}),
        ...(str(values.note) ? { note: str(values.note)! } : {}),
        json,
      },
      io,
    );
  if (group === "ci" && command === "drift")
    return ciDrift(
      resolve(arg ?? "."),
      {
        ...(str(values.catalog) ? { catalog: resolve(str(values.catalog)!) } : {}),
        json: str(values["json-out"]) ?? json,
        ...(str(values.junit) ? { junit: str(values.junit)! } : {}),
        ...(str(values.summary) ? { summary: str(values.summary)! } : {}),
        warnOnly: values["warn-only"] === true,
        ...(str(values.repo) ? { repo: str(values.repo)! } : {}),
      },
      io,
    );
  if (group === "ci" && command === "snippet")
    return ciSnippet(arg, io, { ...(str(values.write) ? { write: str(values.write)! } : {}) });
  if (group === "ci" && command === "archive-gate")
    return ciArchiveGate(
      root,
      arg,
      { ...(Array.isArray(values.drift) ? { drift: values.drift as string[] } : {}), json },
      io,
    );
  if (group === "glossary") {
    const by = str(values.by);
    if (command === "list") return glossaryList(root, { json }, io);
    if (command === "scan")
      return glossaryScan(
        root,
        { ...(str(values.mode) ? { mode: str(values.mode)! } : {}), json },
        io,
      );
    const ownerOne = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    if (command === "define")
      return glossaryDefine(
        root,
        arg,
        positionals.slice(3).join(" ") || undefined,
        { ...(by ? { by } : {}), ...(ownerOne ? { owner: ownerOne } : {}) },
        io,
      );
    if (command === "link")
      return glossaryLink(root, arg, positionals[3], { ...(by ? { by } : {}) }, io);
    if (command === "alias")
      return glossaryAlias(root, arg, positionals.slice(3), { ...(by ? { by } : {}) }, io);
  }
  if (group === "init") {
    const owner = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    const dir = resolve(command ?? ".");
    const code = await initCommand(
      dir,
      {
        ...(command ? { name: basename(dir) } : {}),
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        ...(str(values.from) ? { packFrom: resolve(str(values.from)!) } : {}),
        ...(owner ? { owner } : {}),
        json,
      },
      io,
    );
    // A new metarepo starts up to date: record the Atticus that made it (ADR 0051).
    if (code === 0)
      await upgradeCommand(
        dir,
        { ...(owner ? { by: owner } : {}) },
        { out: () => undefined, err: (l) => io.err(l) },
      );
    return code;
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
    if (str(values.refresh)) return absorbRefreshCommand(root, str(values.refresh), { json }, io);
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
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(values.resume ? { resume: true } : {}),
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
        ...(str(values.gate) ? { gate: str(values.gate)! } : {}),
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
    if (command === "archive" && (await ciArchiveGate(root, arg, { json: false }, io)) !== 0)
      return 1;
    if (command === "archive")
      return changeArchive(
        root,
        arg,
        { ...(by ? { by } : {}), ...(values["no-rescan"] === true ? { rescan: false } : {}) },
        io,
      );
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
        catalog: values["from-catalog"] === true,
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
  if (group === "onboard") {
    if (command === "check") {
      const repo = str(values.repo);
      if (!arg || !repo) {
        io.err(
          "onboard check needs a proposal and its repo: atticus onboard check <name> --repo <repo>",
        );
        return 2;
      }
      return onboardCheck(root, arg, repo, io);
    }
    if (command === "accept") {
      if (!arg) {
        io.err("onboard accept needs the proposal's name: atticus onboard accept <name>");
        return 2;
      }
      return onboardAccept(root, arg, { replace: values.replace === true }, io);
    }
    if (command === "eval") {
      if (!arg) {
        io.err(
          "onboard eval needs a folder of cases: atticus onboard eval fixtures/onboard-eval --mode model",
        );
        return 2;
      }
      try {
        const { runtime } = await runtimeForCli(root, {
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        });
        return await onboardEval(root, arg, { json }, { runtime }, io);
      } catch (e) {
        if (e instanceof RuntimeConfigError) {
          io.err(e.message);
          return 2;
        }
        throw e;
      }
    }
    if (!command) {
      io.err(
        "onboard needs a repo: atticus onboard <repo-id|folder> [--name <dialect>] [--attempts 3] [--mode model]",
      );
      return 2;
    }
    const attempts = Number(str(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
      });
      return await onboardDraft(
        root,
        command,
        { ...(str(values.name) ? { name: str(values.name)! } : {}), attempts },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "frameworks" && command === "check") return frameworksCheck(root, arg, io);
  if (group === "frameworks" && command === "kit")
    return frameworksKit(resolve(arg ?? "frameworks-kit"), io);
  if (group === "frameworks" && command === "survey") {
    const pkg = str(values.package);
    return frameworksSurvey(
      root,
      {
        prefixes: pkg
          ? pkg
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : [],
        json: values.json === true,
      },
      io,
    );
  }
  if (group === "frameworks" && command === "discover") {
    const strings = (v: unknown) =>
      (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string");
    const groups = strings(values.group)
      .flatMap((g) => g.split(","))
      .map((g) => g.trim())
      .filter(Boolean);
    return frameworksDiscover(
      root,
      {
        groups,
        jars: strings(values.jars),
        learn: values.learn === true,
        json: values.json === true,
      },
      io,
    );
  }
  if (group === "frameworks") {
    const from = str(values.from);
    if (command !== "learn" || !arg || !from) {
      io.err(
        "frameworks learn needs a name and the starter's source, for example: atticus frameworks learn tide-platform --from workspace/tide-platform",
      );
      return 2;
    }
    const pkg = str(values.package);
    return frameworksLearn(
      root,
      arg,
      from,
      {
        ...(pkg ? { packages: pkg.split(",").map((x) => x.trim()) } : {}),
        dryRun: values["dry-run"] === true,
      },
      io,
    );
  }
  if (group === "dialect") {
    const rest = positionals.slice(3);
    if (command === "kit") return dialectKit(resolve(arg ?? "dialect-kit"), io);
    if (command === "tree") {
      if (!arg) {
        io.err("dialect tree needs a file: atticus dialect tree src/A.java [--language java]");
        return 2;
      }
      return dialectTree(
        arg,
        { ...(str(values.language) ? { language: str(values.language)! } : {}) },
        io,
      );
    }
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
  if (group === "sources" && command === "refresh")
    return sourcesRefreshCommand(root, { json }, io);
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
