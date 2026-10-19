# Command reference

Generated from `atticus --help` by `pnpm docs:commands`; don't edit it by hand. Every command takes `--root <dir>` (the metarepo; default the current folder). `atticus explain <command>` says what one does in plain words.

```text
atticus <version> (catalog schema v2)

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

Every command is described in docs/guide/commands.md; atticus explain <command> says more.
```
