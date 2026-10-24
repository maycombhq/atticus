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
  atticus scan survey <repo>           Your assistant reads the repo and drafts its scan settings (folders to leave out, path prefixes, client base URLs); checked against the code [--attempts 3] [--force] [--max-tokens n]
  atticus scan verify <repo>           Your assistant compares the code with the last scan: what it missed, what it has wrong, a fix for each; checked, kept in proposals/scan/ [--attempts 3] [--json] [--accept] [--max-tokens n]
  atticus spec draft <repo>            Your assistant writes the repo's flows, one per trigger, each step cited and checked [--attempts 3] [--resume run] [--force] [--mode m] [--max-tokens n]
  atticus spec check <repo> [--json]   Check the repo's flows against the catalog, the template and the code; confirms steps on their cited lines
  atticus estate join [--json]         Join each repo's call-outs to the flows their targets start; writes specs/estate.yaml
  atticus estate flow <flow> [--depth 5] [--json]  A flow followed across repos, with the data at each crossing
  atticus estate lineage <flow> <field> [--depth 5] [--json]  Follow a field along a flow to the column it is stored in, or where it breaks
  atticus repo-type detect <repo> [--json]   Match a repo against the org pack's repo types by fingerprint, with the evidence for each signal
  atticus repo-type new <id> --from <repo> [--force]   Draft a repo type from a repo (its build files, dependencies, markers, folders) for you to edit
  atticus scan review <repo>           What the last scan couldn't read: your assistant gives a verdict on each gap and a rule for code it can read; checked [--gaps] [--attempts 3]
  atticus query "<query>"              Find records, e.g. "kind:interface via:gateway -has:pattern"
  atticus query "<words>" --search     Search everything the index holds (records, knowledge items, flows, changes, answered questions, wiki sections, documents), names and ids first [--by words|meaning|both] [--kind k,k] [--limit n] [--json]
          [--limit n] [--json]         (see docs/query-language.md)
  atticus context show <id>            One record, flow, step, knowledge item, change, answered question or wiki section in full, with its file
  atticus context walk <id> [--hops 1] [--kind k,k] [--limit n]  The links from one id, how each was made, at most two hops
  atticus context code <id> [--around 6]  The code a fact cites, a few lines around each cited line, from the workspace checkout
          [--repo r --path p --line n]  (or one line a fact cites)
  atticus context similar <id> [--kind k,k] [--limit n]  What reads like one id, by the local embedding model: a hint where to look, never a link
  atticus context grep "<pattern>" [--regex] [--ignore-case] [--repo r] [--paths glob] [--limit n]  The lines of the workspace clones that match, each repo:path:line; .gitignore'd files skipped
  atticus context files "<glob>" [--repo r] [--limit n]  The clones' files whose paths match a glob
  atticus context outline <repo> <path>  A file's declarations with their annotations, from its syntax tree; a document's headings
  atticus context tools [--json]       The read-only tools a step's model may call beside its pack, and their caps
  atticus context call <tool> --input <json> [--run <run>] [--round n] [--json]  Run one tool call a model made; with --run it is kept in the run's record
  atticus impact <id>                  What a change to a record reaches, with owners and open questions
  atticus ask "<question>"             Answer a plain question from the catalog, showing the query it ran
  atticus setup [--json]               The setup checklist until the catalog is accepted, with a fix for each step
  atticus baseline                     Accept the as-is catalog as the baseline [--note text] [--site dir]
  atticus doctor [--json]              Check this machine: Node, Git, OpenSpec, proxy, TLS, disk, port, assistant
  atticus secret set|check|forget <name>  Keep a model provider's key in this machine's credential store under the name runtime.yaml gives as keyEnv; read from stdin, never printed
  atticus upgrade [--check|--dry-run]  Bring the metarepo's files up to this version (backs them up first)
  atticus support bundle               Collect versions, checks, counts and the redacted log in a zip [--out f]
  atticus digest                       What waits on you: hand-offs to revise, blocking findings [--channel c] [--send] [--json]
  atticus guide <system> [--json]      A system's guide, generated from the catalog: parts, calls, data, runtime, decisions
  atticus site build <dir> [--title t]  The read-only catalog site as static files (only systems open to everyone)
          [--depth n] [--json]
  atticus index rebuild                Rebuild the local index from the catalog files
  atticus index embed                  Give every node of the index its vector from the local embedding model (similar in meaning stays off until then)
  atticus reconcile [diagram...]       Compare draw.io diagrams with the catalog (default: inputs/diagrams)
          [--json]
  atticus sources add <type> <location>  Print the sources.yaml entry for a wiki (git, markdown-folder, ado-wiki, ...), or write it [--save]
          [--id <id>] [--path <folder>] [--ref <branch>] [--submodule] [--kind <k,k>] [--framework <f,f>] [--owner <who>] [--save]
  atticus sources sync [--source s] [--json]  Read the wikis and copy each to a dated snapshot: pages, stale pages, conflicts with code, document-only facts
  atticus sources tag <source> [--kind k,k] [--framework f,f] [--owner o]  Tag a knowledge source in sources.yaml (kinds, frameworks, owner)
  atticus knowledge scan [--source s] [--mode m] [--resume run] [--full] [--batch-tokens n] [--max-tokens n]  Your assistant reads the snapshots into patterns, standards, processes, requests, decisions and constraints; every quote checked. A rescan reads only the pages that changed and says what changed
  atticus knowledge list [--tag t] [--kind k] [--unverified] [--json]  The knowledge items, by tag and kind
  atticus knowledge ask "<question>" [--mode m] [--resume run] [--max-tokens n]  An answer from the knowledge items only, citing them
  atticus knowledge find "<phrase>"   Search every wiki for a term or phrase; your assistant reads the pages that mention it and proposes what isn't a knowledge item yet, each quote checked [--source s] [--mode m] [--resume run] [--json] [--max-tokens n]
  atticus knowledge keep <item>        Keep a found item as a knowledge item you verified [--find <search>] [--as <kind>] [--set <field=value>] [--note <text>]
  atticus knowledge finds [--json]     The searches saved, and how many of each were kept
  atticus knowledge verify <item>      Mark a knowledge item right as read: a green tick wherever it shows [--note <text>]
  atticus knowledge correct <item> --set field=value  Correct an item's details (a list takes a|b|c); the corrected item is what plans read [--note <text>]
  atticus knowledge reject <item> --note <why>  Mark an item wrong: plans and answers leave it out
  atticus bench knowledge [--mode m] [--resume run]  Scan the bench's invented wiki, ask its questions, and score both
  atticus bench design [--mode m] [--resume run]  Read the bench's Figma export, map it against the petclinic estate, and score it
  atticus sources refresh [--json]     Fetch every absorbed source again and show what changed
  atticus patterns scan [--json]       Find integration patterns in the wikis and compare them with the org pack
  atticus coverage [--json]            What the catalog knows per system and area: verified, document-only, unknown
  atticus questions [--json]           Knowledge gaps and the owner questions that close them
  atticus questions list [--state open] [--json]   The questions in questions/ a step raised for a person
  atticus questions answer <id> --option <n> | --text "..."   Write the answer to the file; prints the rerun
          [--scope repo|repo-type] [--type <repo type>] [--by who]
  atticus intake add <files...>        Drop documents, specs and diagrams into inputs/inbox for intake
  atticus intake list [--json]         What intake read from inputs/: kinds, systems, duplicates, versions
  atticus triage [--json]              What needs a person: unknown names, conflicts with code, image edges
  atticus triage decide <item> <n>     Choose option n for a triage item; writes a curated decision
          [--reason text]
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
  atticus plugin test|pin <id>         Run a scanner or model-provider plugin against its golden files, sandboxed; or pin its entry file's sha256
  atticus plugin add <id>              Copy a model-provider plugin Atticus ships (vertex) into the org pack, to review and pin
  atticus onboard <repo> [--name n] [--attempts 3] [--mode m]   Your assistant drafts a dialect for a repo Atticus can't read; checked, kept as a proposal
  atticus onboard check <name> --repo <repo>   Check a proposal (drafted, handed off or hand-written)
  atticus onboard eval <dir> [--mode m] [--json]   Score the assistant's drafts against reference dialects
  atticus onboard accept <name> [--replace]   Accept a proposal into org-pack/dialects/ (or frameworks/)
  atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]   Learn a house framework, your assistant drafts what the learner couldn't; checked, kept as a proposal
          [--attempts 3] [--package a.b] [--mode m] [--no-ai]
  atticus onboard check framework <name> [--from <source>] [--users <repo>,...]   Check a framework proposal (drafted, handed off or hand-written)
  atticus onboard accept framework <name> [--replace]   Accept a framework proposal into org-pack/frameworks/
  atticus frameworks learn <name> --from <repo|jar|tgz>   Learn what a house framework means from its source, JAR or npm package
          [--package a.b] [--dry-run]  (writes org-pack/frameworks/<name>.yaml)
  atticus frameworks discover --group <a.b|@scope>[,...]   The house artifacts and npm packages the repos build on, found here
          [--jars <dir>]... [--learn] [--json]   (.jar and .tgz folders, Maven and Gradle caches, node_modules; never downloads)
  atticus frameworks check [name]      Run each framework model's own tests; a failing model isn't used
  atticus frameworks survey [--package <prefix>[,...]]   How the repos use house frameworks, any language [--json]
  atticus frameworks kit [dir]         Export the framework-model kit for an assistant
  atticus change new "<title>"         Start a change from a template: --type <type>
          [--template id] [--id id] [--owner role=a,b]... [--system id]...
  atticus domain profile <system>      A system as a domain profile, filled from the catalog [--out file]
  atticus change feature <change>      The feature stage: your assistant places the change on the estate's flows and features from the brief, stories or a design; checked and criticised every draft until done [--from-figma f.json] [--mode m] [--resume run] [--force] [--context-tokens n] [--whole-context] [--max-tokens n]
  atticus change architecture <change>  The architecture stage: the target flows (steps added, changed or removed, with fields) as flow deltas; looped the same way [--mode m] [--resume run] [--context-tokens n] [--whole-context] [--max-tokens n]
  atticus change small <change>        The fast path for a small change (ADR 0113): your assistant places it on the flows, writes its target flows and words its stories in one step; every stage's checks, and the critic at the change type's gate [--mode m] [--resume run] [--force] [--context-tokens n] [--whole-context]
  atticus change attach <change> <files...>  Attach a spec, screenshot, PDF, email export or document to a change: copied into its inputs/, read and cited by line or page, read by its steps [--replaces inputs/<file>] [--promote inputs/<file>: copy one into general knowledge] [--json]
  atticus change draft <change>        Your assistant drafts the proposal, spec and interfaces from the brief and the catalog; checked [--attempts 3] [--force] [--mode m] [--max-tokens n]
  atticus change status <id> [--json]  State, next step, what blocks it, risk, the PR to merge and test kinds
  atticus change handoff <id> --approve  Open the phase's hand-off PR; merging it approves the gate [--repo]
                                       (without --approve: say what it would open, send nothing)
  atticus change sync <id> [--approve]   Read the hand-off PR; a merged PR moves the change on (--approve merges a ready one)
  atticus change return <id> --reason "<why>" --approve  Close the hand-off PR and return the change to the product owner
  atticus change archive <id> [--no-rescan]  Archive a released change and rescan its repos
  atticus change list [--json]         Every change and its state
  atticus change conflicts [--json]    Open changes that touch the same systems, records or repos
  atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]  Does the code do what the design says: scan the branch's commit and check it against the target flows; what is missing, still there or not in the design becomes findings on the conform gate (--latest shows the newest check, scanning nothing)
  atticus change estimate <change> [--json]  The change's estimate: its size from the target flows, the org pack's ranges summed, and what drives it, each with its source; never a number nobody stands behind
  atticus change map <change> [--format mermaid|drawio] [--json]  The change's picture: the components, entries and tables its target flows touch, marked + new, ◇ modify or ✕ retire
  atticus critic <change> [--gate g] [--lens l] [--mode m] [--json] [--max-tokens n]  Review a change at a gate: rule checks, then AI lenses (--mode runs them)
  atticus critic <change> [--gate g] --resume  Read in the AI lens answers your assistant wrote (hand-off); handoff done does it per lens
  atticus critic stats [--json]        How often each rule's findings are dismissed or waived
  atticus findings <change> [--json]   The change's findings by gate and round
  atticus finding <change> <id> <action>  apply | edit-and-apply | not-relevant | waive | ask (recorded with you; reaches main with the hand-off PR)
          [--gate g] [--reason text] [--asked-of who] [--edit patch-file]
  atticus feature list [--json]        Features found in code, named by people or proposed by AI
  atticus feature show <id> [--json]   A feature's entry points, flow, owner, links and gaps
  atticus feature name <id> "<name>"   Confirm or correct a feature's name [--description] [--owner]
  atticus feature tag <id> <tags...>   Tag a feature
  atticus feature merge <into> <from...>  Merge features
  atticus feature split <id> <entry-points...>  Split entry points into another feature [--name] [--into]
  atticus feature link <id> <ref>      Link a work item or page, e.g. ado:1234 [--title]
  atticus feature suggest-links [--json]  Suggest links between features and work items
  atticus feature spec <id>            Draft an OpenSpec capability spec from a confirmed feature
  atticus catalog migrate [--dry-run]  Rewrite catalog files to the current schema version
  atticus task context <change> <task> [--json|--markdown]  The task's context for an assistant: its story and criteria, the step it implements with today's code, what applies, the files attached and the files likely to change
  atticus task run <change> <task>     Run a task with AI [--level plan|draft|pr] [--mode m] [--approve]
  atticus spec hand-down <change> <task>  Create the task's Spec Kit feature in its repo [--force]
  atticus spec hand-up <change> <task>  Read the Spec Kit feature back at the PR [--pr n --pr-url url]
  atticus drift <change> [--json]      Compare design, repo plans and code
  atticus assistant-files [--repo id [--change id]] [--force] [--check]  Generate the slash commands, instructions and skills for each assistant runtime.yaml allows (Copilot, Claude Code, Cursor, Gemini CLI, Windsurf, AGENTS.md)
  atticus feature suggest-names [--mode m]  Ask AI to propose names for detected features
  atticus plan stories <change>        Write stories, stories.md and tasks.md from the approved design [--force] [--mode m] [--draft: before approval] [--context-tokens n] [--whole-context] [--max-tokens n]
  atticus change needs <change>        Your assistant says what the change needs from the organisation (requests and processes to raise, standards to follow, teams and vendors to involve), for the change, a feature, flow, story or task; each checked against the change's own words [--mode m] [--resume run] [--context-tokens n] [--whole-context] [--max-tokens n]
  atticus needs [--change id] [--all] [--json]  What changes need from the organisation, open ones first, with lead times and who handles each
  atticus waiting [--group change|kind] [--filter words] [--json]  What waits on you across every change: questions, open needs, manual steps, findings, knowledge to verify
  atticus runs [--change id] [--limit n] [--json]  The model runs: what Atticus asked a model, each round, and whether it was answered
  atticus runs show <run> [--json]     One run: its prompt, its answer and the problems handed back to it
  atticus history [--change id] [--session id] [--filter words] [--limit n] [--json]  The prompts people sent their assistant here and the responses they got, by session, kept on this machine
  atticus history show <id> [--json]   One prompt or response, and its pair
  atticus history add --surface <claude-code|vscode|cli> --kind <prompt|response> [--session id] [--command c] [--change id]  Record one prompt or response, its text read from stdin (the plugin's hooks and VS Code call it)
  atticus history off                  Stop recording prompts and responses on this machine (kept in .atticus/me.yaml)
  atticus history on                   Record them again on this machine (runtime.yaml can still turn it off for everyone)
  atticus needs done <change> <item>   Record a need as done, e.g. with the CTASK number as its note [--for <target>] [--note <text>]
  atticus needs skip <change> <item> --note <why>  Record a need as not needed, and why [--for <target>]
  atticus needs reopen <change> <item>  Open a need again [--for <target>]
                                       (with target flows: the stories stage, a task per changed step with its prompt, requests from knowledge)
  atticus plan snow <change>           Draft service-desk requests the change needs [--force]
  atticus plan bar <change>            Measure the story bar [--eval file]
  atticus plan submit <change>         File the drafted requests (a dry run until you add --approve)
  atticus ado sync <change>            Create or update work items (a dry run until you add --approve) [--epic id]
  atticus templates draft              Draft request and work-item templates from wikis, uploads and past tickets [--no-ai]
  atticus todo [--change id] [--all]   Manual steps waiting for a person
  atticus todo show <step> [--export text|csv|import]  A manual step: what to do, where, and what it needs
  atticus todo done <step>             Record a manual step's result [--result k=v]... [--skip --note why]
  atticus todo run <step> --with <executor>  Run a step with a team's own tool [--approve --inputs sha] [--fill-only]
  atticus executors check              Ping configured executors and show what each covers
  atticus init <folder> --platform <p>  Create a new metarepo named after the folder [--from pack] [--owner who]
  atticus adopt <path>                 Use Atticus in an existing repo; writes only .atticus/ [--platform p] [--name n]
  atticus unadopt <path>               Remove Atticus from an adopted repo, leaving it as it was
  atticus repos discover <folder> | --org <org>  Propose repos.manifest.yaml entries [--platform p] [--dry-run]
  atticus absorb <git-url|path> --id <id>  Translate another team's prompts, agents, checklists, OpenSpec, Spec Kit, TypeSpec or Atticus repo
          [--mode adopt|link|ignore] [--ref r] [--dry-run]
  atticus absorb --refresh <id>        Fetch an absorbed source again and update its proposal
  atticus absorb accept <id>           Copy what the reviewed proposal adopts into the org pack and add its sources.yaml entry [--replace] [--dry-run] [--json]
  atticus tests generate <change> <story>  Generate tests from a story [--framework id] [--force] [--check] [--mode m]
  atticus trace <change> [--json] [--csv] [--no-write]  Requirement → story → test → code → records → feature
  atticus release plan <change> [--json]  Deploy order across the repos, why, rollback per step, waits and release sections
  atticus release forecast <change> [--json]  Forecast ready-to-release day from lead times and the initiative's plan
  atticus release evidence <change> [--out dir] [--json]  The evidence pack for an approval board or an audit
  atticus release notes <change> [--audience business|technical] [--json]  Release notes from the brief, interfaces and data
  atticus release security <change> [--json]  Security review draft: auth, classifications, boundaries, vendors, secrets
  atticus outcome list [--change id] [--json]  The brief's success measures and the values recorded after release
  atticus outcome record <change> <measure> --value <v>  Record a measured outcome [--note text]
  atticus ci drift [repo] --catalog <path>  In a repo's pipeline: compare the repo with the committed catalog
          [--repo id] [--json [file]] [--junit file] [--summary file] [--warn-only]
  atticus ci snippet <github|azure|gitlab|jenkins> [--write dir]  Pipeline template for the drift check
  atticus ci archive-gate <change> [--drift file]...  Whether a change may be archived
  atticus glossary list|scan [--json]  Business terms from wikis, code and people
  atticus glossary define <term> "<definition>" [--owner team]  Define a business term, as you
  atticus glossary link <term> <record-id|schema#field>  Link a term to a catalog record or field
  atticus glossary alias <term> <name>...  Another name people use for a term
  atticus initiative new "<title>" --journey <j>  Start an initiative [--id] [--release YYYY-MM-DD] [--epic]
  atticus initiative plan <id> --target <system>  Plan its changes and commitments [--release d] [--system s]... [--dry-run]
  atticus initiative status <id>       Critical path, at-risk and slipped commitments
  atticus initiative request <id> <party>  Send a team a system card and track the reply [--system s]...
  atticus initiative commit <commitment> <open|at-risk|done|slipped>  Record a commitment's status
  atticus learn [list] | learn start <role|lesson> | learn check [--answer a] [--lesson l] [--step s]
                                       Lessons by role in a practice sandbox: list them, start one, check a step
  atticus sandbox create <dir>         A throwaway practice metarepo
  atticus commands [--json]            Every command as data: its arguments, options, area and how it runs (for an editor)
  atticus explain <id|command>         Explain a record, finding, change or command in plain words
  atticus eval run [--agent a]... [--mode mock|replay|live] [--runs n]  Evaluate AI agents
  atticus eval report                  The latest eval results and AI quality
  atticus bench fetch [--repo id] [--batch n] [--cache dir]  Clone the bench's public repos at their pinned commits
  atticus bench survey [--repo id] [--batch n] [--mode m]  Your assistant drafts each bench repo's scan settings; kept for later runs
  atticus bench verify [--repo id] [--batch n] [--mode m]  Your assistant verifies each bench repo's scan; kept for bench run to score
  atticus bench run [--repo id] [--batch n] [--estate e] [--json] [--specs]  Scan each bench repo and score it against its reference; --specs also scores drafted specs against bench/flows and scans each estate's repos together
  atticus defences scan [path] [--all]  Look for instructions hidden in documents and prompts
  atticus conformance <path> --kind <catalog|org-pack|dialect|plugin|executor>
                                       Check a catalog, org pack, dialect, plugin or executor against the spec
  atticus alias "<name>" <id>          Record that a name used in diagrams or documents means a catalog id
          [--reason text]
  atticus orgpack validate [dir]       Check an org pack against its schemas (default: <root>/org-pack)
  atticus orgpack draft                Draft the profile's systems from the knowledge items: the products and vendors the wikis name, with their aliases and owners, each citing its item [--platform <p>] [--json]
  atticus orgpack accept <platform>    Put the drafted systems into profile.yaml [--only <id,id>] [--verified-only] [--dry-run] [--json]
  atticus openspec setup               Set up OpenSpec with the org-flow schema in the metarepo
  atticus openspec check               Check the OpenSpec version and validate every change and spec
  atticus handoff done <run-id>        Tell Atticus a hand-off artifact is written; it validates it
  atticus next [--all] [--json]        The next step to take, its command and slash command, and why; from the files only
  atticus <step> --handoff [--json]    On scan survey, scan verify, spec draft, knowledge scan, change feature, change architecture, change small, change draft, plan stories, change needs, knowledge find, knowledge ask and critic (its lenses one at a time, as a stage offers its critic lenses after each draft): print only the prompt, the result file and the commands that finish it
  atticus <step> --max-tokens n        On the same steps: the model's limit. The whole prompt fits n tokens (counted as characters / 4, a quarter kept back for the count's error), or the step says before handing off that it can't, with the numbers. The VS Code extension passes its model's limit to every step
  atticus workspace sync               Clone or update the base clone of every repo in the manifests
          [--repos a,b]                Only these repos
  atticus workspace open <change>      Create the change's worktrees, repos.yaml and editor workspaces
          --repos a,b                  The repos the change touches
  atticus workspace prune <change>     Remove worktrees whose PRs merged or closed
          [--all] [--force]            All worktrees; also those with uncommitted work

  --root <dir>                         The metarepo (default: the current folder)
  --by <handle>                        Who is acting (default: the metarepo's Git user, git config user.email)
  atticus mcp                          Serve read-only tools to an assistant over MCP (stdio): next step, catalog, knowledge, changes, needs (the Claude Code plugin starts it)
  atticus ui [--port n] [--open]       Start the app on this machine (127.0.0.1); Ctrl+C stops it
          [--embed vscode]             Let a VS Code panel show the app (the Atticus extension starts it so)
          [--parent pid]               Stop when that process ends (an editor that started it)
          [--show-token]               Print the session token, for an assistant or a script (an editor that starts it gets it)
  atticus --version                    Print the version
  atticus --help                       Show this help

Every command is described in docs/guide/commands.md; atticus explain <command> says more.
```
