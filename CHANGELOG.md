# Changelog

All notable changes to Atticus. Versions follow [Semantic Versioning](https://semver.org); contracts C1 to C6 change only with an ADR, a schema version and a migration (`atticus upgrade`).

## Unreleased

### A big repo's first read (A-big, ADR 0124 addendum A-big)

- **Coverage and the estimate count less that isn't code.** Translation bundles under a locale folder (`i18n/`, `locales/`, `lang/`, `translations/`) and JSON or XML files over 2,000 lines or 200 KB are no longer source. Build, config, API and migration files count whatever their size.
- **`atticus map <repo> --estimate` proposes what to leave out.** Folders that are mostly data or docs, or that hold a library's own LICENSE and no build file, are listed with their tokens, the tokens before and after, and a ready `exclude:` block for `org-pack/scan/<repo>.yaml`. Atticus never writes it: a person accepts it in a pull request.
- **A repo bigger than one session is read in parts.** Over 150,000 tokens of source, the estimate proposes parts by folder, balanced by tokens, and `/atticus-map` reads one part per session or sub-agent into the same facts file, verifying after each.

### VS Code: /verify checks the facts

- **`@atticus /verify <repo>` and _Atticus: Verify a repo's facts against its code_ run `atticus verify`** (ADR 0124), with no model: the chat shows what was rejected and offers `--write`, or sends the rejected facts back with `/map`. They ran the older scanner's `scan verify` with Copilot's model before. That check stays, as `/scanverify` and _Verify a repo's last scan_, behind `atticus.fullUi`.

### A criterion is written once and accepts several tasks (B-once, ADR 0124 addendum B-once)

- **Stories are shorter.** A story criterion may list `also: [<task ids>]`, the other tasks of its story it accepts, so a behaviour a field takes through entry, validation, write and response is written once, not on each task. The stories prompt asks for this. On the deliverBy fixture the story says in 4 criteria what took 8.
- **The checks read a task's own and shared criteria.** A task needs criteria only when none accepts it; its fields may be checked, and its error case said, by a criterion written on another task. A criterion may check its `also` tasks' fields. An `also` naming a task the story doesn't have is refused (`stories.unknown-also`).
- **Every output carries them.** The story file lists each criterion once, with "(also accepts tasks 1.2, 1.3 and 1.4)"; each task's list and prompt, and `atticus task context`, give the task every criterion that accepts it; `atticus bench stories --change` puts a shared criterion on each step it accepts. An answer without `also` reads and renders as before.

### Lean batch prompts: each batch carries only the rules its files need (A-lean, ADR 0124 addendum A-lean)

- **`atticus map <repo>` (`--handoff`, `--copy`, `--mode model`) fits smaller models.** Each batch prompt now carries the reading protocol's core rules and only the topic rules its files need: front end, back end, routes, stores, deploy, config, gRPC, SOAP, GraphQL and events, and flows. A file's kinds come from its path. When the path can't say, the file gets the rule. The instructions were 2,971 tokens for every batch. They are now 2,648 for a back-end batch, 2,180 for a front end's and 1,419 for a deploy batch's. The Forge ledger fixture now batches from 6,814 tokens, down from 7,042.
- **The plan counts each batch's own rules**, so every prompt still fits `--max-tokens`. A read whose files leave too little room beside their rules is refused with the tokens it needs.
- **`/atticus-map` and the Claude Code plugin are unchanged.** An assistant that reads the whole repo still gets every rule, word for word.

### Org knowledge in every stage: the walk's design gaps (B2, ADR 0124 addendum B2, C4 2.24.0)

- **The feature stage picks the knowledge that applies.** From the brief and the flows and systems it leads to, it selects the patterns, standards, decisions, processes and requests, lists them in the change's `knowledge.yaml` and sends them to the placer, whose rules now ask it to name an item where it bears on a gap or question. The Feature design tab's Knowledge panel is filled from the first stage. The stage tests' pinned feature prompt was re-keyed, with its hand-written answer re-written for the new rule (its gap names the two requests that bear on it).
- **Every stage picks wiki and document sections, vendors and glossary terms too.** Apart from the estate and the items, each stage selects them by the index's own retrieval (BM25 over the index, fused with the title's search, ADR 0116) against its own input, within a share of its room (at most 15% and 1,500 tokens). The top three go to the drafter in the page's words with where they are read from, the rest one line each; a vendor or a term is one line, never its record, and a term nothing defines is left out. They are listed in `knowledge.yaml` with why, and can be confirmed or excluded like items. A page no item covers (an API guide's webhook section) now reaches a change.
- **The rules reach the prompts.** A pattern or standard the architecture stage sends in full carries its rules, and a decision what it decided. The stories stage sends the standards that apply, with their rules, beside the processes; an integration pattern stays the architecture stage's.
- **A document in `inputs/` is indexed once**, from the file (cited by its file, section and page), not again from its knowledge snapshot; a file the sync skipped (a copy of a wiki page, a file dropped twice, an older version) isn't indexed.
- **The Knowledge panel shows titles and why in plain words.** `knowledge.yaml` keeps each item's and near-miss's title; `GET /api/changes/{id}/knowledge` gains `title` and `reason` (C4 2.24.0, additive; `docs/api/openapi.json` regenerated), and an older list takes an item's title from its record. The panel shows the title with the id beside it, the kind in words, and "The change names it", "Linked to northwind-pay", "Its words match the change's title and words" instead of the search's ranks. `atticus change knowledge` and the hand-off PR's list show the same.
- **`atticus handoff done` checks a knowledge scan's answer** as the scan does (each quote on its page, the values tied to it, an id used twice, a superseded page, each conflict and flagged passage) and lists what fails, keeping the run open to fix; after three checks the answer goes in as it is. A `knowledge scan --resume` whose answer failed says which checks failed before handing the next attempt over.
- **`atticus knowledge correct --set` takes a field by the scan's name too** (`lead_time`, `handled_by`) and writes the record's (`leadTime`, `handledBy`).
- **A critic round a crash left behind doesn't use up the gate's rounds:** a round folder with neither its record nor a finding isn't counted.
- **`atticus knowledge ask` has its own agent,** `knowledge-asker`, introduced as what it does. An org pack may define its own; a budget set for `knowledge-reader` still holds for ask.

### What the second stories bench run found, fixed (B-run2-fixes, ADR 0124 addendum B-run2-fixes)

- **The store facts of a store with no migrations name the table's own files.** For each table the change's flows use, the architecture prompt lists the schema file that creates it and the entity mapped to it (`declaringFiles`), not the first four files any of the store's columns is cited in. A superclass or a model shared with other tables is left out.
- **A task's places are where what it adds or changes is declared.** A field a schema already holds is a change there only when the step makes it required; naming it is not. So a validator or a handler that cites one existing field is no longer a place, nor is an API contract no message of which changes. A read or lookup of a column adds no table files. A screen's fields that several screens' files share name the files today's flow cites.
- **Two tasks the target flow puts at the same file and line are one implementation step**, with both tasks and both tasks' criteria (in the story file and the bench draft). Tasks placed only after their neighbour stay apart.
- **The stories bench matches an error case with no field** (`not-found`, `forbidden`, `unavailable`) by the step (strict) or the entry (by entry), the rule and a word its `when` shares with the draft's, whatever field the draft keys it on.
- **The stories prompt says which rule word fits which failure** (`range` for bounds and dates, `format` for shape, `limit` for a total across requests or items, and the others).
- **`atticus repos discover` follows links to clones**, one level, never a link to its own folder or one above it, and a clone two links name once. The repo's folder is the link.
- **`atticus next` skips the reader path for a repo mapped from its verified facts** (its spec's template is `facts@1`): no survey, scan, verify or spec steps, straight to the change.
- **An answered question reaches the next prompt with what the option means and changes**, or the person's own words, not its label alone.
- **Schema problems say what is wrong:** "story 1's interface 1's field 1's side is text ("both"): write one of request, response, message", not "storie 1's interfaces: Invalid input". A field today's entry already returns or takes (its catalog Schema holds it, as a list's `count`) is no longer refused as given nowhere.
- **A new gRPC status on an rpc is an interface change** in design.md.
- **A change's estate index is its own estate's** in a metarepo several estates share: the repos it touches, their systems, the repos joined to them, and outside systems such as vendors.

### The estate fixes: publishes name their event, entries without a flow are listed, errors match branches (C-estate, ADR 0124 addendum C-estate)

- **`atticus verify` rejects a publish step that names no event.** A flow's `publish` step whose `ref` is missing, or isn't a call fact of `callType: event-topic` or `mq-queue`, is rejected as `publish-no-event` (a new reject code, additive like `call-out-no-call`), with the step, its line and what to name. The estate join follows a publish to its listeners only through that call.
- **`atticus verify` lists the entries no flow follows.** Every listener (`event-topic`, `mq-queue` entry) and every `rest` or `grpc` entry that no flow starts is listed under `entriesNoFlowFollows` in `<repo>.verify.yaml` (left out when none) and in the printed summary, with its id and line. It is a note, not a rejection: the run still exits 0. `/atticus-map` asks the reader to write a flow for each that does real work.
- **The reading protocol's flow rule** (`FACT_RULES`, `/atticus-map`, the batch prompt) says a publish's `ref` is the event's call, and that an ORM's eager fetch, cascade or lazy load the code triggers is a `read` step cited where it is declared. The Claude Code plugin is regenerated.
- **The estate scorer matches an error path to a branch.** In `scoreEstateFlows`, a drafted flow's `errors[]` entry stands where its cite falls in the flow and matches a reference `branch` step of its repo cited in the same file within 3 lines. `stepsOnly` (per flow, and in the total with its strict figure) keeps the steps-alone figure. On the bench facts: petclinic 58 → 61 of 87 steps in order, eShop 54 → 55 of 163, microservices-demo 139 of 173 unchanged; fields at crossings unchanged.

### Org knowledge, walked end to end (B2)

- **A guide:** `docs/guide/knowledge.md` covers adding a wiki, a document or an API guide, the snapshot, the scan, asking and searching, what applies to a change, and confirm or exclude.
- **Two sources with a page at the same path** (a team wiki and the org wiki both with `integration-patterns.md`) no longer fail the knowledge scan. Each quote is checked on the page it is on. A quote on neither page says to write `<source>/<page>`, and the prompt asks for that form when sources share a path.
- **Confirming an item now does something.** Every later stage that takes the item's kind selects it, so a near-miss you confirm reaches the next stage. Excluding still keeps an item out of every later stage, and that is now tested on a stage run.
- **`atticus plan stories --handoff --resume` no longer crashes** with "Unrecognized key: locateText". The crash came when a judged doubt waited for the critic's lenses.
- **A critic finding that cites a file by its metarepo path** (`openspec/changes/<id>/design.md`) is now kept. It was dropped as having no evidence.
- **`atticus change knowledge` and the app's Knowledge that applies panel no longer send you to the feature stage**, which picks no knowledge. They name the architecture stage and say which kinds each stage picks. The list ends with how to confirm or exclude an item.
- **`atticus sources add` prints the `--owner` and tags it was given**, as `--save` writes them.
- **`atticus intake add` says how a document becomes knowledge:** `atticus sources sync --source inputs`, then `atticus knowledge scan`.

### Names a framework derives verify (A-derived, ADR 0124 addendum A-derived)

- **`atticus verify` accepts a name no line writes when the framework derives it from a line the fact cites.** ORM tables: JPA entities under Spring's snake_case (`OrderLine` is `order_line`), their join tables (`ordertable_order_line`), join and foreign key columns (`customer_customer_id`) and element collections; Django's `<app_label>_<model>` (`users_baseuser`), many-to-many tables and `<field>_id`; Rails' and Laravel's plural tables (`doc_classes`, `article_tags`) and Laravel's pivot tables; TypeORM's entity and join tables; Prisma's implicit `_CategoryToPost`. Routes: Rails' `root` (`/`, under its namespace), Devise's routes from the modules the model lists (`/users/sign_in`, `/users/auth/github/callback`), Spring Data REST's `/order` and `/order/{id}`. Workers: an ActiveJob or Sidekiq class with its modules, a Celery task's `<module>.<function>`. Each is accepted only when the cited line, or a `cite.with` part, declares the source, and the claim is the derived name exactly.
- **A word can be put together from `cite.with` parts**, as a path already could: a rake task's `namespace:task`, a key a helper prefixes.
- **`/atticus-map`** (and the batch prompt and the Claude Code plugin): write a derived name as the framework makes it, cited where its source is declared; a background worker is a `batch-job` entry named by its job; a framework's admin, health and ops routes (`/up`, `/admin`, a queue's web UI) are not entries. Read a repo again to use them.

### A changed file invalidates only what cites it (A-incremental, ADR 0124 addendum A-incremental)

- **A moved checkout is re-read, not read again whole.** When a repo's facts are of an earlier commit, `atticus map <repo> --estimate` compares that commit with HEAD (local `git diff --name-status -M`, renames followed) and lists three things. The facts that still hold, because every file they cite is unchanged: kept as they are. The facts that cite a file edited, renamed (with its new path) or deleted since: read again, then rewrite or drop. The changed source files, which are the only files to read. The token and batch estimate covers only those files. `--estimate --json` gains `reread` (and `notComparable` for a commit the clone doesn't have).
- **`atticus map <repo> --handoff` and `--copy` batch only the changed files.** The first prompt says it is a re-read and hands back the facts to rewrite with their lines, and the rest are carried.
- **`atticus verify <repo>` carries facts of an earlier commit.** A fact whose cited files (with `cite.with` parts and flow step cites) are all unchanged is checked against its line at HEAD and written back with `commit` set to HEAD. The carry is recorded under `carried` in `<repo>.verify.yaml`, with the commit each fact was read at. A fact citing a changed file is rejected as `cite-changed` (a new verifier code), saying how the file changed. A fact of a commit the clone can't compare is still `wrong-commit`. The facts schema doesn't change.
- **`atticus scan` uses carried facts** instead of falling back to the readers, and its note says how many facts were carried and how many were left out until the repo is read again. The readers stand in only when the two commits can't be compared.
- **`/atticus-map`** has a re-read step: read the listed files, rewrite or drop the listed facts, keep the rest. The Claude Code plugin is regenerated.
- The same commit, facts and answers give the same catalog bytes whether the facts were carried or read at HEAD (tested).

### The bench gains a held-out batch 3

- **Six new public repos, in stacks the bench lacked, with hand-checked references written before any read** (`bench/repos.yaml`, `batch: 3`): codetriage (Ruby on Rails), django-styleguide (Django and DRF), laravelio (PHP Laravel), wild-workouts (Go over gRPC and chi, Firestore), kotlinconf (Kotlin Ktor and Multiplatform clients) and microservice-kafka (Spring Boot over Kafka). 193 entries, 49 calls, 62 tables and 7 platforms, every `at` line-checked against the pinned clone, each judgement call in the reference's `notes`. The session that wrote them never saw a reader's facts, so the first read of batch 3 measures the map on code nobody tuned on (`bench/README.md`).

### Search by meaning as a plugin you add, and the twelve commands first in VS Code (D-bundle, D-editors, ADR 0124 addenda D-cli and D-bundle)

- **The npm package brings the embedding plugin only as optional dependencies.** `@maycombhq/cli` lists `@maycombhq/embed` and `@maycombhq/embed-model`, and `@maycombhq/index` lists `@maycombhq/embed`, under `optionalDependencies` (the `onnxruntime-*` packages already were optional dependencies of `@maycombhq/embed`). `npm install --global --omit=optional @maycombhq/cli` leaves the plugin and onnxruntime out, and a mirror without them doesn't fail the install. The command line runs without them, as the default bundle does: doctor's note, a scan and a search by words and names (tested by running the built command line with the plugin's packages hidden from Node's module resolution). `atticus index embed` says the plugin isn't installed and exits 1, as before. `pnpm install --frozen-lockfile` works with the updated lockfile.
- **`pnpm bundle --embeddings-plugin` builds the plugin zip**, `atticus-<version>-embeddings-plugin.zip` (about 0.25 MB on Linux x64, 238 files): `@maycombhq/embed`, `@maycombhq/embed-model`, every `@maycombhq/onnxruntime-*` and `onnxruntime-common`, with each package's `pins.json` and none of the files it pins, so it is the same zip on every platform. Its `install.ps1` or `install.sh` copies them into the installed Atticus of the same version (checked against `SHA256SUMS`, no network). Then the person runs `node <Atticus folder>/embeddings-plugin/fetch-model.mjs`: it fills the model, this machine's onnxruntime and the WebAssembly fallback from their pinned sources, each checked against its sha256. On a machine that can't reach them, `--list` names the files, `--from <folder> --offline` takes them from a folder (matched by sha256), and `--check` says what is missing. The install guide's offline section says how. `pnpm bundle:test <default zip> --plugin <plugin zip>` installs both and checks the step finds the model missing (and, with `--plugin-from .cache/pinned`, fills it offline and searches by meaning; CI's bundle job does that). Doctor's fixes name the plugin zip and its step.
- **The VS Code extension lists the twelve commands first.** Run a command… (behind `atticus.fullUi`), a repo's and a change's commands and `@atticus /run` show the commands `atticus commands --json` marks `legacy: false` under _The twelve commands_, in `atticus help`'s order, then every other command by area under _Legacy · <area>_. An older command line without the field is listed by area as before. The Get started walkthrough maps the repos (map, verify, the Map) and starts a change (stories, the critic) first; scanning and spec drafting are its last two steps, _Legacy: …_. IntelliJ is unchanged.

### The places a change goes into are in the map (B-places, ADR 0124 addendum B-places)

- **A front end's model types, forms and displayed fields are fields of the map.** The reading protocol (`/atticus-map`, the batch prompt and the Claude Code plugin) asks for them. A model or client type's properties are the request or response fields of each call that sends or receives them. A form's fields and the fields a screen shows are `side: screen` fields of the screen's entry. A generated client that isn't committed is cited at its call site. A task that adds a field a call sends or gets back now names the model type's file, and one on a screen names the form or the view. A changed call-out that doesn't say where it goes uses today's call. Read a front end again with `/atticus-map` to record them.
- **An added step goes where the target flow says.** A target flow's added step may give `at: path:line` (the line it goes after) or `path:function`. The architecture stage checks the file is the repo's (in its checkout or the catalog), the line and the function (`delta.at-unknown`, `delta.at-line`, `delta.at-function`). The task is cited there. Without `at`, a task says it is placed after the step before it. Target flows without `at` read as before.
- **Migrations come from the facts.** A column or store fact cited in a migration file (Flyway, Liquibase, Alembic, Prisma, EF, TypeORM, Rails, Django or numbered SQL) makes a Migration record in the catalog on `atticus verify --write`. The architecture stage names a new migration in their folder with the next name. It refuses an existing migration, or a file of another kind, as the change's migration. A task no longer lists an existing migration as a file to touch, and a store with no migrations is told which schema files to change in place. Run `atticus verify <repo> --write` again to add the records. No schema bump: Migration is a C1 kind already.

### Better with every correction: drafted against merged, measured, and fed back (H1 to H3, ADR 0087 addendum)

- **What Atticus drafted is kept beside what merged.** When `atticus change sync` finds a stage's hand-off PR merged, it writes `stage/<stage>.drafted/` (the stage's files as the draft commit had them), `stage/<stage>.merged/` (as the merge commit has them) and `stage/<stage>.capture.yaml` (both commits, and each file's status). It reads them from the clone's git, with no fetch and no Git host call beyond the sync's own. A merge you haven't pulled yet waits, and `atticus change learn` completes it after a pull. The next hand-off PR carries the pairs.
- **`atticus change learn [--json]`** says how much people changed the drafts, per merged change and stage: lines added, removed and changed per file, and per story the criteria and fields added and removed and the parts reworded. It also gives the trend by merge date, comparing the earlier half with the later half once a stage has three merged changes. It is deterministic, from the kept pairs.
- **Past corrections in the next draft.** The feature, architecture and stories stages' prompts get at most two past pairs of the same stage. Each shares a repo, table, flow, system or entry with the new change, and is quoted as "the draft said … the team changed it to …", within 5% of the stage's budget. With no past pair, the prompt is byte for byte what it was, so recorded replays keep passing.
- Not yet: H4 (repeated corrections become proposed critic rules), and past corrections for `change draft` and `plan stories` on the change-draft path.

### The Map with its evidence, and a stage tab's findings with a comment box (F3 and B10, ADR 0124 addendum D-app, C4 2.23.0)

- **Every citation on the Map shows its quote.** On the estate canvas's details panel (a box's evidence and the links that start or end on it), each flow step and error path, and each contract's evidence, a citation is a button: hover or focus it for the file, the line, the quote the reader kept, who made each fact on that line and who checked it. Escape hides the tooltip; pressing the citation opens the facts on the line and the open questions that read it.
- **Gaps are marked, not coloured.** A box, link, step or contract with no fact verified from code, an open question on its line, or a correction `atticus verify` hasn't applied yet says so with a shape and words; on the canvas the gaps join each box's and link's, so the outline reads them out.
- **Correct a fact from the Map.** Correct this marks a fact wrong (with why) or puts its claim or line right. The app appends the correction to `facts/<repo>.corrections.jsonl` and shows the `git add … && git commit …` command and `atticus verify <repo>`. The verifier (and every `atticus map` batch) applies the file on every run: a fact marked wrong is left out, an edited one becomes a person's fact (`by: person`, `verified: person`) and is still checked on its line. A correction finds its fact again when a new read gives it another id.
- **A stage tab's findings, with options and a comment box.** Feature design, Architecture (for the change in its address) and Stories show the critic's findings at the stage's gate, each with only the options it allows (make the fix, not relevant, waive where the rule allows it, ask a knowledge gap's owner), the stage's own questions to answer in place, and the stage's command. A comment on a finding is written as a question you answered, listed in the stage's loop file, so the stage's next run hands it to your assistant as your answer with the next draft.
- **Local API 2.23.0 (additive):** `GET /api/facts/{repo}`, `POST /api/facts/{repo}/corrections`, `GET /api/changes/{id}/stages/{stage}`, `POST /api/changes/{id}/stages/{stage}/comments`. `docs/api/openapi.json` is regenerated.

### A story's implementation steps follow the places in the code that change (B-steps, ADR 0124 addendum B-steps)

- **Each story file has an Implementation steps section**, after Scope: one numbered step per place the change goes into, in the tasks' order. A step is each task's own code (the line its flow step is at, or the line an added step goes in after), each file a task declares a field or column in (the files to touch from the map's citations, B-fixes: one step per file, with every task's lines and reasons), and each new migration file. A new flow's tasks that cite no code are one step of new code, because the map can't tell their places apart. Each step names its tasks, and their acceptance criteria accept it. The tasks are unchanged and are still what a developer runs. The steps are worked out from the tasks (`storySteps` in the planner) and aren't stored. The stories prompt is unchanged, so no recording was re-recorded.
- **`atticus bench stories --change` scores those steps.** The draft's steps are the story's places. A file step is cited at `file:line` (its first cited line) so the scorer matches it by file and line, and a file two stories touch is one step. A criterion is written on its task's own step and again on each file step of that task, cited there. On the run's three changes, re-scored without re-drafting: changed steps went from 2 of 8 to 4 of 8, 1 of 2 to 1 of 2, and 3 of 8 to 6 of 8. Strict error cases went from 0 to 1 of 5, 0 to 2 of 4, and 0 to 3 of 5. Fields (all found), invented fields (none) and sections (17 of 17) are unchanged.
- The fraud check's golden story (`fixtures/stages/stories/expected/s1-place-order.md`) gains the section. The bench golden (`fixtures/stages/stories-bench/expected/forge-fraud-check.yaml`) gains the write's schema file and migration as steps, and its score against the invented reference is unchanged.

## 2.0.0-rc.1 (2026-10-24)

Atticus 2 (ADR 0124): your assistant reads the code, and Atticus verifies every fact it writes against the line it cites.

- **The map.** The assistant writes facts (entries, calls, stores, fields, deploys, config and flows), each with a citation. `atticus verify` checks every claim on its line, and `--write` projects the kept facts into the catalog (C1, additive) and renders `map.md`, flows and OpenAPI contracts. The built-in readers are now an optional cross-check.
- **Three assistant tiers and a probe.** The tiers are agentic, chat with a token limit (`--handoff`) and copy and paste (`--copy`); `atticus probe` measures which one your assistant is.
- **The estate join.** Each call is joined to the entry that serves it, citing both ends, with field lineage across the crossing.
- **A change in three stages.** Feature, architecture, then stories and tasks. Each stage has code checks before the critic: consumers of a breaking change, the deploy order, and a story's sections and completeness.
- **The critic's four questions.** True, complete, safe, ship.
- **Knowledge per change.** The knowledge that applies to a change is listed in its `knowledge.yaml`.
- **Surfaces.** Twelve commands, with every other command under `atticus legacy` and still running by its own name. The app has six entries, with the rest behind `atticus ui --full`. VS Code has three views, with the rest behind `atticus.fullUi`. The offline bundle is 20.1 MB, without the embedding model.
- **Measured** on the public bench: map batch 2 (held out) 88% precision and 84% recall, against the readers' 57% and 33%. The bars (95% and 85%, the estate's 80% and 90% on petclinic and eShop, the stories' step coverage) are not met yet; see `docs/build-status.md`.
- **Upgrading.** Run `atticus upgrade` once: the catalog moves to schema version 3 (`required` on Schema fields, ADR 0125), with only the number changed. A component id two repos share becomes `<repo>-<component>` when both repos are written again with `atticus verify --write`.

### Atticus 2: the assistant reads, Atticus verifies (ADR 0124 and 0125)

#### The editors: three views and the steps, the rest behind a setting (Phase D, ADR 0124 addendum D-app)

- **VS Code shows three views:** **Next and Waiting** (the next step, then what waits on you under it), **Questions** (each answered in a dialog beside the lines it read) and **Changes**. The Command Palette offers fifteen commands; `@atticus` offers the steps, run with the editor's model: `/next`, `/map <repo>` (new), `/verify`, `/feature`, `/architecture`, `/stories`, `/task <change> [task]` (new), `/critic <change>` (new) and `/answer`. The Atticus tab opens on the app's Home.
- **Nothing is removed:** the setting `atticus.fullUi` brings back the Knowledge, Repos, Catalog and Model runs views, **Run a command…** for every command (ADR 0096), the rest of the palette and of `@atticus`, and the app with every page (`atticus ui --full`).
- **IntelliJ:** its parity table places VS Code's two new commands (map and the critic, as their slash commands); its parity test reads the app's screens however Prettier lays them out. The plugin's own actions are unchanged (not built here: it needs the IntelliJ Platform download).

#### Twelve commands, one install page, a 20 MB offline bundle (ADR 0124 addenda D-cli, D-install, D-bundle)

- **`atticus help` shows twelve commands**, one line each: `init`, `map`, `verify`, `join`, `change`, `critic`, `stories`, `task`, `questions`, `knowledge`, `next`, `ui`, and how to reach the rest. `atticus help <command>` still explains any command, and `atticus help --all` lists every one, grouped as before.
- **Three new names** for commands that exist: `atticus join` is `atticus estate join`, `atticus stories <change>` is `atticus plan stories <change>` (with `--handoff`, `--draft` and the rest), and `atticus task <change> <task>` is `atticus task run <change> <task>`.
- **`atticus legacy`** lists every other command, grouped by area (`--all` adds Atticus's own quality commands). `atticus legacy <command>` runs one exactly as `atticus <command>` does. **Nothing is renamed or removed**: every old name still runs as before, with nothing added to what it prints, so scripts, the editors and the tests keep working.
- `atticus commands --json` gives each command `legacy: true|false` (additive; the editors read the rest as before). `atticus explain` knows `join`, `stories`, `task`, `legacy` and `ui`.
- **The install guide is one page** (`docs/guide/install.md`): minute 0 to a first map and a first change for Claude Code or Copilot agent mode, Copilot Chat without tools, and copy and paste; the offline bank install; `atticus probe`. The command reference shows the twelve first, then the legacy commands.
- **The offline bundle leaves out search by meaning**: about 20 MB instead of about 113 MB (Windows) to 120 MB (Linux). The embedding model and its runtime (`@maycombhq/embed`, `@maycombhq/embed-model`, `@maycombhq/onnxruntime-*`, `onnxruntime-common`) are an optional plugin: `pnpm bundle --with-embeddings` builds `atticus-<version>-offline-embeddings.zip` with them, as before. Without them Atticus searches by words and names (FTS5, BM25) and the graph walk.
- **`atticus doctor` no longer fails where the embedding plugin isn't installed**: it says "not installed (@maycombhq/embed, an optional plugin)" as a note, and warns only when runtime.yaml names a model it can't run. The context engine says "search by meaning is an optional plugin that isn't installed" where it said the model couldn't be read.

#### What the stories bench run found, fixed (B-fixes)

- **Two repos' components with one name stay two components.** When two repos of an estate both have a component called, say, `frontend`, each gets its repo's id in front (`fastapi-template-frontend`, `microservices-demo-frontend`), with its own endpoints and flows; before, they became one component owned by the repo written first. A component no other repo has keeps its id, so nothing changes for a catalog without such a pair. If yours has one, run `atticus verify <repo> --write` for both repos again (the new ids show in the map and `specs/`); a change already drafted on the old ids needs its architecture stage run again.
- **`atticus verify` rejects a flow whose call-out step names no call** (`call-out-no-call`), with the step and what to name: the call fact it makes, or, for a call through a cloud SDK with no path, the config fact of the client's setting. Before, the flow passed verify and failed later at `--write`. `/atticus-map`'s rules say the same.
- **A task names the files its change goes into**: where the fields and columns it adds or changes are declared, from the facts' citations (the request or response DTO and the OpenAPI spec, the table's schema file and entity, the migrations' folder). They are in the story file's "Files to touch", the task's prompt and `atticus task context`.
- **The stories prompt carries the code the tasks cite**: each cited line with three lines either side, read from the repo's checkout under `workspace/`, within a fifth of the stage's token budget (what doesn't fit is counted). An assistant that can't open files can now write the auth, validation messages, error handling, tests and migrations from the code. With no checkout the prompt is as it was.
- **A key-value or cache store (a key-pattern table) has no columns**: a read or write of one isn't asked to name a column, and what it holds is no new column needing a migration.
- **data.md takes a new column's migration from the write that adds it**, not from a lookup before the write that names the column.
- **`atticus bench stories` also scores error cases by entry**: an error case found on another task of the same endpoint, with the same field and rule, counts there (`errorsByEntry`), beside the strict figure by step, which stays.

#### The stories bench scores the stories Atticus drafts (B-stories-bench)

- **`atticus bench stories --change <change> --story <id>`** scores the stories the stories stage drafted for a change (give its id, or its folder) against the reference story in `bench/stories/<id>.yaml`: the change's stories become one bench story (each task a changed step with today's file and line, each criterion split into given, when and then, each error criterion an error case), scored as `--draft` scores a file. `--out <file>` keeps the converted draft.
- **`atticus verify <repo> --write` no longer stops half way** when a flow from the facts isn't a valid flow (a call-out step that names no call): the catalog and the other flows are written, and it says which flow was left out and what to fix in its fact.
- `atticus verify <repo> --write --root <dir>` reads `--root` again; it was taken as `--write`'s value.

#### The tier your assistant reads a repo at is measured, not assumed (ADR 0124 addendum A-probe)

- **`atticus probe`** writes a file holding a code it never prints and says what to do in your assistant: **`/atticus-probe`** asks it to open the file, write the code to `answer.txt` beside it and run `atticus probe answer <code>` itself. An assistant that can't run commands gives you the line to paste with `--pasted`; a web chat answers `none`. Opened, wrote and ran is agentic (tier 1); opened and wrote is the batched hand-off (tier 2); anything less is copy-paste (tier 3). A wrong code records nothing, and a probe more than a day old must be started again.
- **The model's limit is only what someone states**: `--max-tokens n` on `atticus probe` or on the answer. Nothing guesses it.
- The result is kept per assistant in `.atticus/probe/<assistant>.yaml`, on this machine only (never committed; `probe/` joins `.atticus/.gitignore`, which `atticus upgrade` adds to an existing metarepo). No shared system is touched.
- **`atticus doctor`, `init`, `adopt` and `map --estimate` prefer the measured tier** and say which it is: "measured on 2026-10-24" or "from runtime.yaml" (with `atticus probe` as the way to measure it). A measurement older than 90 days is still used, and doctor warns to measure again. `map --estimate` and a hand-off or copy read use the limit stated at the probe when `--max-tokens` isn't given; `map --estimate --json` adds `maxTokensFrom`, and its tier adds `source` and `measured`.
- `map --estimate` now says "Your assistant: <tier>, <where it comes from>." where it said "The org's assistant (runtime.yaml)".

#### A Schema field says whether it is required: catalog schema version 3 (ADR 0125)

- **`required` on a Schema field** (C1): true, it must be sent; false, it may be left out; left out, nobody knows. Nothing ever takes an unknown for optional.
  - An assistant's field fact fills it.
  - No reader does yet.
- **Catalog schema version 3.** Readers accept versions 1, 2 and 3; writers write 3.
  - Run `atticus upgrade`, or `atticus catalog migrate`, once. Its new step `catalog-schema-v3` rewrites version-2 files, and only `schemaVersion` changes.
  - `atticus upgrade --check` and conformance list the files still at version 2.
- **A new required field breaks callers.** A target flow's entry step can list the request fields it requires (`fields.required`). The architecture stage counts it as breaking when either:
  - the field is new to the entry: today's flow doesn't read it and the catalog doesn't have it;
  - the catalog has it as optional.

  A change that breaks callers must list them, as any other breaking change does.

- **Stories show the catalog's required.** A field whose required the story writer leaves out shows the catalog's value, marked "(catalog)", in the Interface changes table and the task's prompt. When neither knows, it says "not said".

#### Several repos' facts become one estate map (ADR 0124 addendum C-join)

- **`atticus verify <repo> --write` joins the repo's calls to the entries of the repo that serves them**, reading the other repos' verified facts (`facts/<repo>.jsonl`): by the call's `to` (a component, or a repo, of the estate), by a host or a base URL from a config fact that a repo lists under `hosts:`, or, when the call names nothing, by the one entry of the estate with that method and path (or gRPC or SOAP name). A publish joins every listener of its topic. Each joined Interface cites the caller's call, the callee's entry and the config fact that ties the base URL to the host. The other repos' calls into the repo are joined again, so the catalog is the same whichever repo is written first. `atticus scan` joins the repos it reads from facts the same way.
- **A host no repo lists is asked** (`Which repo answers on <host>?`), never guessed, even when an entry elsewhere has the path. A call two or more entries could answer is asked too, offering only those entries. A call whose named repo has no entry for it is said.
- **Field lineage across crossings**: the caller's request fields to the callee entry's, the callee's response fields back, a message's fields to the listener's, each with the column the receiving side stores it in, as C1 `FieldMapping` records on the joined Interface. A field sent that the callee doesn't take is said.
- `atticus estate join` follows a flow written before its callee was read, through the Interface a later write made.
- One cross-repo change end to end on the Forge fixture (`fixtures/estate-facts/`): the map names each changed entry's callers from the joins, and the architecture stage's deploy order runs each migration before its code and each callee before its caller, across three repos.
- **The bench scores the estate**: `scoreEstateFlows` (`packages/evals`) follows a reference flow through the joins and counts its steps in order and the fields at each crossing. On the facts of petclinic, microservices-demo and eShop: 25 of 87, 0 of 173 and 9 of 163 reference steps in order, and 27 of 48, 0 of 100 and 15 of 46 fields at crossings. Short of the exit bar (80% and 90%): the facts files have few flows (microservices-demo 2, eShop 8, the Angular app none for a page load), so most reference steps have no flow to match. The join itself cites both ends of 30 of petclinic's 30 Interfaces (0 before), 29 of microservices-demo's 33 (9 before) and 53 of eShop's 58 (16 before).

#### The architecture stage checks who a change breaks and the order it deploys in (ADR 0124 addendum B-arch)

- A change that breaks who uses an entry or a table today lists them: `consumers` on the target flow, or `store.consumers` on the step. Breaking means a field the response returns is gone, the entry reads one field in place of another, the entry, the response or the flow is removed, a column gets another type, or the step is marked `breaking`. The consumers come from the map (Interface records, the specs' calls, the table's readers and writers), and the architect sees them before its first draft. One the map knows that the draft leaves out goes back to the drafter.
- The target flows give a **deploy order** (`deploy`): each migration before the code that reads or writes its table, each callee before the caller of an entry it adds or changes, and every repo and migration of the change. A wrong order goes back to the drafter. design.md shows the order, and the breaking changes with who they break.
- A type given for a column the table has, other than the catalog's, is a type change: it needs its migration, it breaks the table's readers, and data.md says so.
- A call to a component the map has no entry of is a note: nothing confirms it. So is a breaking change to a flow whose trigger names no endpoint.
- No deploy order is a note for now, not blocking, so drafts recorded before it keep passing.

#### A story a developer can build without asking (ADR 0124 addendum B-stories)

- **Every story file has the sections of a professional story**: Context (what the code doesn't say, then today's flow with its citations and error paths, and the flow once the change is in, each changed step naming its task), Scope in and out (the tasks, and the steps the flow keeps), Acceptance criteria, Interface changes (each entry with its fields' side, type, required, default and validation, breaking or additive, and its consumers), Data changes (each column the steps add, with its type, nullable, default, migration, classification and retention), Non-functional (auth, audit, timeouts and retries, performance), Tests and Test notes, Depends on, and a Definition of done from your org pack's test strategy and build and qa gates.
- **Each task names** the files to touch (from its citations, and the migration it adds), the tests to add, and the command to run (the repo's `build` in `repos.manifest.yaml`). A criterion can name the entry it exercises, the validation it relies on, and for an error its rule and status.
- **`stories.md` fills Depends on** when a story calls an entry or uses a table another story of the change adds.
- **The stories stage checks a story is complete** before the critic sees it, and sends it back with the list: every entry the target flows add is in the interface changes; every request field an entry of the repo gains has a validation and an error criterion; no section names a field, column, entry, consumer, story or repo the target flows and the catalog don't know; a column's facts match the target flow's; every write that adds a column names its migration. A section a story leaves out is reported but doesn't stop the stage yet, so answers written before this still pass.

#### A path written across lines can be cited (ADR 0124, A4)

- **`cite.with`** in a fact: the other lines its path is built from (a class prefix, a base URL, a context path, a route template, a proto package). `atticus verify` checks every part is written on one of the lines.
- A route template without a leading slash (`[HttpPost("upload")]`) now verifies; config keys with `:` or `__` (`ConnectionStrings:Default`) are read by their last part; `TokenUrl` is no longer taken for a secret.

#### Home is one page; Change's tabs start with All changes and At a glance (ADR 0124 addendum D-app, 2026-10-24)

- **Home** is one page: what needs you first (the setup checklist, the step to run next, Waiting on you and Needs a person), then what is scanned and trusted (repos cloned, with scan settings and scanned; how many repos' maps are trusted and which aren't, with a link to Map › Trust) and each change in flight with the stage it is at and its command, a blocking finding marked; then the key numbers, the gate pipeline, the catalog, the system map, the findings and the slash commands. The Overview is part of it: it is gone from the `--full` list, Ctrl+K finds Home by "Overview" and "Waiting on you", and `#/dashboard` (the VS Code panel's default) opens Home.
- **Change** has six tabs: **All changes**, **At a glance**, Feature design, Architecture, Stories and Tasks, and opens on All changes. A change's tab whose address names no change says to pick one in All changes, with a link, instead of opening on a change it guessed. The At a glance and All changes links in a stage tab's header are gone: the tabs replace them.
- The tour says so.

#### The app has six entries; everything else is behind `atticus ui --full` (ADR 0124 addendum D-app)

- The menu is **Home**, **Map** (Estate canvas, Flows, Contracts, Impact and Trust), **Change** (a tab per stage: Feature design, Architecture, Stories, Tasks), **Questions**, **Knowledge** (items, sources, documents, search) and **Set up** (Repos, AI, Org pack). A change's At a glance and its list are linked from every stage tab.
- The other pages (Estate's features, mappings, diagrams, reconcile, governance and initiatives; the separate brief, UX, architecture review, breakdown, estimate, conformance, trace, task board, manual steps, release and service-desk pages; scans, intake, the org pack from the wikis, teams and vendors, settings, the Overview; Model runs, Prompt history, AI quality and Learning) are out of the menu, the tabs and Ctrl+K. Every old address still opens its page. **`atticus ui --full`** brings them all back as tabs, and Atticus's own pages as a seventh entry.
- **Map › Trust** says, per repo, how far to trust its map: the facts the verifier kept and rejected, how much of the code they cover and which files no fact cites, whether the facts are of the commit the checkout is at, whether the catalog is built from the facts or the built-in readers, and the command to run next (`GET /api/trust`, API 2.22.0).
- **Change › Feature design** lists the org knowledge that applies to the change (`knowledge.yaml`), with Confirm and Exclude. The app writes the file and shows the `git commit` command to run (`GET /api/changes/{id}/knowledge`, `POST /api/changes/{id}/knowledge/{item}`).
- The app now also updates when `facts/` changes, and the tour names the six entries.

#### The critic asks four questions (ADR 0124 addendum, Part 4)

- **Four questions instead of seven lenses.** The critic asks every draft: is it true to the code, is it complete, is it safe to build, can it ship. Each rule and check answers one of them (a rule may say which with `question`), and one AI lens per question reviews what the rules can't, in a fresh session, bound to evidence as before. Findings carry the question as their lens.
- **Code answers more before a model is asked.** Two new constitution checks, never waivable and blocking: an entry another system calls with no auth fact (asked of its owner when unknown, blocking when the catalog says none), and a change to an operation other consumers call that the change doesn't plan for (retired breaks them; a change is the `breaking` judgment, asked of a person when nobody has made it).
- **Two new checks in the starter review**, the organisation's to change, retire or delete (`checklists/review.yaml`, risks): a synchronous call with no timeout (`review.call-timeout-stated`), and a table written with no rollback step in design.md (`review.store-write-rollback`). A metarepo gets them with the starter review from `atticus init` or `atticus adopt`; one whose `review.yaml` was written before can copy the two rules from the starter, since `atticus upgrade` never edits that file. An org pack whose gates name their checklists names `review` to run them.
- **The default change types list the four questions** instead of the old lens names: each type asks the questions its old lenses covered (bug-fix and emergency-fix: complete and ship; config-change: true, safe and ship; tech-debt: true, complete and safe; the others all four). So a rule written for an old lens now applies to every default type that asks its question: the small-change type, for one, now gets the starter's business and delivery rules (`review.brief-outcomes-placed`, `review.requests-raised-in-time`).
- **The spec hand-up's review of a task asks the complete question.** Its lens is the complete lens's agent (`complete-critic`), with the complete rules that review a task's code and tests: those written for the old code-and-test lens, and complete rules that read code or tests. Its answer is `tasks/<task>/review-complete.yaml` (a hand-off begun with `review-code-and-test.yaml` still finishes). There is no built-in `code-and-test-critic` any more; an org pack that still defines one has the complete lens made of it when it defines no `complete-critic`.
- **Org packs written for the old lenses keep working.** Business, story, UX and code-and-test rules ask the complete question; architecture rules ask true; delivery and release rules ask ship. A change type that still lists old lens names takes the rules it took before, `--lens` takes an old name, and old lens agents are combined into the question's agent, as strict as they were. Define `<question>-critic` (true-critic, complete-critic, safe-critic, ship-critic) to set a lens's agent yourself.
- **Service-desk drafts are a manual step.** The constitution no longer blocks on snow.md: `atticus plan` drafts each request the change triggers and `atticus release plan` lists them, with their missing fields, for a person to file.

#### Your assistant reads a repo into facts, at any tier (ADR 0124, A3a)

- **`/atticus-map <repo>`** is the reading protocol for an assistant that opens files and runs commands itself (Claude Code, Cursor, Copilot agent mode, Gemini CLI, Windsurf, AGENTS.md tools), generated for each one and for the Claude Code plugin. Outline the repo, read whole only the files that hold facts, write one cited fact per line to the facts file (the field list is generated from the facts schema), keep secrets out (`source: env:NAME`), ask what the code can't settle, then loop on `atticus verify` until it passes.
- **`atticus map <repo>`** reads a repo in batches for an assistant without file tools. It orders the source files (build and deploy files, config and entry points first) and slices them into prompts that fit `--max-tokens`. Each batch goes through the hand-off (`--handoff`, `--next`) or is printed to paste (`--copy`, the answer read back with `--answer <file>` or `-`). Each answer is verified at once, and what it rejected goes back in the next prompt with the lines it cited. In model mode every batch runs in one call. `--estimate` says what the first read costs.
- **`atticus verify`** also raises the questions the assistant wrote to `<repo>.questions.jsonl` for a person, each evidence line checked.
- **The tier** your assistant reads at is said by `atticus doctor`, `atticus init` and `atticus adopt`, from runtime.yaml's assistants and editors.

#### The assistant's facts become the catalog, and the map is rendered from it (ADR 0124, A3b)

- `atticus verify <repo> --write` puts the kept facts in the catalog when nothing is rejected: they replace the records from that repo, every other repo's records stay as they were, and the scan's merge and your curated decisions apply over them. The flows go to `specs/<repo>/`.
- A call to a host no repo lists asks which repo answers on it; any other call with no target asks which repo or system answers it. The answer is read on the next write.
- `atticus map render <repo>` (also run by `--write`) writes `map/<repo>/map.md` with a trust line and every fact linked to its file and line, a page per flow with its sequence diagram, and an OpenAPI 3.1 file per component.

#### The bench measures the assistant's facts, fields and config, and drafted stories (ADR 0124 §6)

- `atticus bench facts [<repo>] [--facts file]` scores the facts file an assistant wrote against the bench reference: the facts are projected into the catalog as `atticus verify` projects them and scored with `bench run`'s matcher, per kind, so the numbers compare with the readers'.
- Five bench references (spring-petclinic-rest, todo-csharp-sql, todo-nodejs-mongo, fastapi-template, podinfo) now cover fields (586: request and response fields of entries, columns of tables) and config (51 keys that name another system, a timeout or a flag), each cited to its line. `bench run` and `bench facts` score them where a reference covers them and report the old four kinds' total beside the total over all.
- The stories bench: `bench/stories/rubric.md` says what a professional user story holds, three reference stories on public bench repos cite the code each criterion changes, and `atticus bench stories --draft <file>` scores a draft on changed steps, fields, error cases, invented fields (a failure) and the rubric's sections.

### Since 1.0.0-rc.1, before Atticus 2

#### The drafter checks its own draft, and a person's answer settles the judge (ADR 0087, 0111 and 0117 addenda)

- A stage's drafter checks its draft with the stage's own checks before handing it in. In model mode it gets a `check_draft` tool. Headless Claude Code is told to run `atticus stage check <change> <stage> <file>`. With Copilot, `atticus handoff done` lists the problems with their lines and keeps the run open until the file is clean. After `draftSelfChecks` checks (change policy, default 3) the file is handed in as it is.
- A returned field worked out from columns says how: `fields.derived: { edited: "edited_at is not null" }`. The expression's columns are checked against the flow's, and the field no longer counts as coming from nowhere.
- `atticus critic` no longer reviews a draft its stage refused, and `change status` no longer sends a person to the critic while the phase's stage is stopped.
- A person's answer to the covers-field judge is stored as their verdict, so the judge isn't asked again. An answer in their own words is read by a judge of the answer where a model is called directly, and otherwise stands as their words. Only an answer that asks for a change can stop a draft, and the stop quotes it.
- Old one-per-field judge questions are retired, saying what replaced them, and asked again as one question per criterion.
- A criterion checks a field when its outcome depends on the field's value: a given that fixes it, and a then that follows from it, counts. Refusal cases are their own criteria, asked for in the stories prompt from the first draft.
- `edit-and-apply` with only a reason says "Recorded what you did: …". The context line leaves out names the change's own target flows declare.

#### The critic looks in the code, a person's fact holds at every gate, and each flow shows its trigger (ADR 0115, 0116 and 0118 addenda)

- **A lens looks before it calls something missing.** When repos are cloned, every lens's prompt names them and says to search them before reporting that a check, class, screen, endpoint or flow doesn't exist. Headless Claude Code reviewers can now read the clones (added read-only; any edit there is refused). In model mode and in VS Code the lenses already had the code tools.
- **A "missing" name is checked.** A lens lists the names its finding says are missing (`absent`). Atticus looks each one up in the catalog (an endpoint by method and path) and in the code (by declaration, or as a file). If it finds one, the finding becomes a note (`idea`) that cites where it was found. It is never dropped.
- **What a person recorded reaches every later gate.** Facts and decisions people recorded with a reason (`edit-and-apply`, `waive`, `not-relevant`) go to every lens as data, with who and when. The lenses are told not to raise them again without new cited evidence. A dismissal, a waiver, or a gap whose fact a person wrote in now carries to later gates by fingerprint, with a link to where it was decided. An applied fix that comes back is still raised again.
- **A web app in a folder is its own component.** A repo with a Spring API in `api/`, a React app in `web/` and an Android app in `android/app/` now has one component per part. Before, it was a single component typed as an Android app, and nothing recorded the web app. The component reader also runs when the repo's root has no build file (component 1.3.0), and the apps reader types only the module its marker is in (apps 0.2.0).
- **Each flow shows its trigger entry.** In the estate the drafter and the lenses read, a flow's line now names its trigger as method and path. An endpoint's line names the flow it starts. The endpoints the brief names come with the flow each one starts (`brief-endpoints`). `briefEndpointNotes` gives a note when a design leaves that flow alone; the architecture stage doesn't call it yet.

#### Known names and values aren't gaps (ADR 0116 and 0118 addenda)

- **A name is in the code when a source file declares it.** The gap check used to match any word in any file, so it cited a markdown plan for a class and missed classes the code declares. It now reads only files a reader has a grammar for. It finds a class, interface, record, enum, function or type by its declaration, cited to that line. A comment, a use or a sentence in a repo's `docs/` doesn't count. A name only used and never declared, such as a parameter's type from a library, is a gap.
- **A file of the repo is found by its path.** A migration such as `V10__chat.sql`, or `ChatController.java`, is no longer asked about. Nor is a migration file the catalog records.
- **What the change adds is known.** Names from the change's own target flows are never gaps: a new flow's id, name and trigger endpoint, a step's new target, a new table and the columns a step adds. Each is cited to its line, whatever its path parameters are called.
- **A name a person answered for the change stays answered.** The gap check reads the change's answered questions itself. The index now also matches an answered endpoint however its parameters are named.
- **Values the code defines.** The SQL reader reads `CHECK (column IN (...))` constraints, `ENUM(...)` column types and `CREATE TYPE ... AS ENUM`, and drops a check its migration drops. A Column record carries them as `allowedValues` (C1, optional, cited to the line; migrations extractor 1.4.0). The architecture and stories drafts and their lenses get them for the tables the steps store into (`allowed-values`), so a value the code defines isn't called unknown.

#### The order of a flow's steps, foreign keys, and answers a person can fix (ADR 0087, 0111 and 0117 addenda)

- The critic's lenses read each target flow as it will be, with its steps numbered in their final order (`target-flows-merged`). They no longer work the order out from `after`, so they no longer raise findings like "placed after 5, the same position as the lookup". A new check hands back a respond step that returns a field, or a call that sends one, before any step gives it (`delta.returned-before-given`), naming both steps.
- A store block can declare a foreign key: `keys: { order_id: { references: forge-orders-db.orders.id, onDelete: cascade } }`. It is optional, on the table's one definition. The referenced table and column must be in the catalog or this change, and the column one of the table's. data.md lists keys, and the lenses see them. The flow delta stays at version 2.
- When a stage stops on an answer that doesn't read, the answer is copied to the file the stop names (`stage/<stage>-answer.yaml`; a valid one there is kept aside). The stop quotes the failing line and its number. An answer that isn't YAML goes back to the drafter once, with that line and how to quote, before it counts as a draft. The stop also lists the other findings the drafts kept failing on, by rule, with a count and an example.
- A person who fixes the named file and runs the stage again gets it checked as their draft, and the stage is done when it passes. "Nothing in it reads" is gone: when a stage can't take an edit, it says to use `--force`.
- The gap rule shows `relies_on_gaps` as a quoted block list, and the stories stage reads its own answer file with the same reader as the model's answer.
- The stories stage now selects estate records as context on every path, from the brief, the target flows and the design. Before, it selected none.
- The covers-field judge asks one question per criterion, not one per field. The question gives the judge's quote and why, has three options, and cites the criterion's line in the story file. A doubt goes back to the drafter once before a person is asked. One stop asks at most `questionsPerStop` questions (change policy, default 5) and says how many more wait.
- `edit-and-apply` names the files the person changed. A stage that wrote nothing new says "Kept your target flows: nothing changed." An open gap with nothing blocking is said the same way in `change status` and in the stage's done: it waits on its owner, and the hand-off waits for the answer. Every message states the checking round as one rule: "a person acted since round N, so one more checking round is due".

#### A new table's one definition everywhere, and plainer stage files (ADR 0111 addendum)

- data.md and design.md read a new table from its one definition, however the flows sort. A flow that uses the table before the flow that creates it no longer turns its columns into "add column" rows with no migration, so the critic no longer raises false missing-migration findings. Where several steps still mark the table new, the step with the migration and the columns is the definition.
- A stage file's schema problem is said in plain words, with its file and line: "target-flows/x.yaml:14: step 2's fields.sends is empty: write a list, such as [orderId], or leave sends out." The model's answer gets the same, at its line.
- A target flow's write can say which column a field it sends is: `fields.as: { id: order_id }` (optional). A path parameter that is a column of another name is then stored as that column. The hand-back says to use it, not to put the field under `checks`.
- A migration name's example uses the table's SQL name (`V4__create_order_pin.sql`), not its catalog id.
- `atticus change status` reads the classifications in the change's target flows. A new column classified confidential now counts as personal data. The line says which levels count as personal and where that comes from: the change policy's `privacy.classifications` when they are the org pack's own levels, else that list and the pack's levels above internal. This can raise a change's risk where a catalog column is classified above internal.

#### A person's fix is never drafted over, and a new table is defined once (ADR 0087, 0111, 0115 and 0116 addenda)

- **A stage never drafts over a person's edit.** Atticus keeps the hash of every file a stage writes (`written` in `stage/<stage>.yaml`). When a stage's files differ from what it wrote, the person's version is the stage's draft. It is checked and reviewed as theirs, and nothing is redrafted. If it fails, the stage stops and says what still fails, with the file and line. A copy of the person's files is kept first, in `stage/<stage>-by-person/<n>/`, and the loop records the draft as a person's (`byPerson`). The assistant drafts again only with `--force`, or after a person answered a question, and then it starts from the person's files. This holds in every stage: feature, architecture, stories and the fast path. Before this, a person who fixed `target-flows/` as the stop message said, then ran the stage again, had their fix overwritten by three more drafts.
- **A new table is defined once, by the step that creates it.** That step marks it `new: true` and gives its columns, types, classification, migration and retention. Every other step that writes or reads the table names it without `new`, and only the columns it uses. The checks read the definition from that one step. A second step that marks the table new is one finding naming every such step (`delta.table-new-twice`). A column another step uses that the definition lacks is handed back, naming the creating step.
- **One question for each table.** Retention and classification are asked once for the table, not once for each flow change that touches it. The classification question lists every unclassified column, and the answer applies to the table's definition. A retention that came back after a draft had it is also one question for the table.
- **Every classification is checked against the org pack's levels**, wherever it is written: on a step that only restates the table, and in a delta whose flow isn't in the specs. Before, the second case skipped the check.
- **The facts come with the first draft.** The architecture and fast-path prompts carry the org pack's classification levels and the rule that every field a write sends is stored or listed under `checks`. They also carry, for each store the change may write, up to three migration file names with the next free name and the folder, and the column types its tables use (`store-facts`). The hand-backs give the same facts: the next migration name in the store's numbering, and the store's column types for a column that has none.
- **One stop, one message.** A stage that stopped for questions and also on findings the assistant kept getting wrong now prints one report. The questions come first, then the findings, then one next step. The next draft gets the answers and those findings.
- **Names in the code aren't gaps.** A name the change uses that a cloned repo's code names, as a whole word, is no longer a knowledge gap. Examples are a class or a field from today's flows. The step lists where the code names it (`names-in-code`, `inCode`). A gap now says the code was searched, and which repos (`namesInCode` in `@maycombhq/index`).

#### A person's answer, read for the rest of the change (ADR 0115 and 0117 addenda)

- A question a person answered isn't asked again in other words. The draft's prompt lists each answered question with its answer, and says the answer is part of the brief and is never asked again. Where a model is called directly (model, headless Claude Code), a new judgment, `answered-by`, reads the answer and says whether it already decides a new question; with a hand-off the drafter says so itself (`sameAs` with verdict `answered`, quoting the answer). A question the answer decides reads that answer. One nothing settled goes back to the drafter once, with the answer, before it goes to a person.
- The critic's lenses read the answers people gave for the change, as data, in a stage and in `atticus critic`, and are told a scope a person set by answering isn't a finding. A lens that still reports one names the answer (`answered`, checked word for word); the finding is kept as a risk linked to the answer, not a block. A rule that can't be waived still blocks.
- A checking round past a gate's limit is due once nothing blocking from the newest round is open and a person acted since it ran: on any of its findings (a gap included) or by answering one of the change's questions. A stage no longer stops with "act on each blocking finding of round 3" when round 3 has none; the refusal says what makes a round due.
- Once a checking round has run, the gate says "its 2 critic rounds and the checking round are used" in `atticus critic`, `atticus findings` and `atticus change status`, which now prints a used-up gate's status.
- `atticus finding <change> <id> apply` on a knowledge gap says that a fact you already wrote in by hand is recorded with `edit-and-apply --reason "<what you wrote>"`, no patch needed.
- In hand-off mode, the questions a draft raised are no longer lost while its critic lenses are with the assistant.

#### Branches you can see and choose (ADR 0123)

- `atticus workspace sync` asks each remote which branch it calls its default. When it isn't the manifest's `defaultBranch`, it says so, and `atticus doctor` warns, offline. Atticus never changes the default by itself.
- A manifest repo may list `branches`: the other branches people work on. `atticus scan --ref <branch>` reads each listed repo's branch in a read-only checkout beside its base clone, and keeps the catalog in `catalog/branches/<branch>/`, never in `catalog/generated`. It says what the branch adds, removes and changes against the baseline. `--repos` names repos instead.
- **Set up › Repos** shows each repo's default branch with the commit the baseline was read from, the remote's default when it differs, and the other branches with their scans. It can scan a branch, compare it with the default, and edit the branches in the manifest.
- VS Code's repo rows show the branch and the scanned commit.
- The local API gains `GET /api/repos/branches`, `GET /api/repos/compare` and `PUT /api/repos/{id}/branches`, and the scan job takes `ref` (API 2.18.0).

#### The org pack's owner, without editing YAML

- `atticus orgpack owner [<handle>]` says who looks after the org pack, or sets it in `pack.yaml`, keeping the rest of the file and its comments. VS Code's "Who looks after the org pack" asks for the handle in a form and runs it, instead of opening the YAML.

#### VS Code runs a next step without a terminal

- A next step that is a command now runs as Run a command runs it: with progress and Cancel, what it printed in a notice, the dry run and a person's yes for a shared write, and the views read again when it ends. Only a server (`atticus ui`, a stub) opens a terminal. Not yet tried in a live VS Code.

#### The hand-off PR says what changed since the last round

- The PR body gains **Since the last round**: for each reviewed gate, its newest critic round against the one before (which findings closed, which are new, how many stay open), or that it is the first round.

#### What the words mean

- Twenty of Atticus's own words (metarepo, org pack, hand-off, gate, lens, critic, target flow, dialect, base clone, service desk and the rest), each in one plain sentence: on a new page, **Atticus › What the words mean**, with a **Words** link beside Help, and from `atticus explain <word>` (a word Atticus knows, before a command of the same name).
- The app and the command line hold the same list; a test fails when they differ.
- Not built yet: a word underlined with its sentence where a screen first uses it.

#### Every step prompt checks first

- Each step's slash command (`/atticus-survey` to `/atticus-next`) starts by running `atticus assistant-files --check`. When the command line isn't installed, the folder isn't a metarepo, or the prompt files are out of date, the assistant says exactly that and stops. The zero-install commands (`/atticus-ask`, `/atticus-impact` and the rest) read committed files only and need no check.
- `atticus assistant-files` outside a metarepo says so, the same way `atticus next` does, instead of listing the files it would write.

#### One question at a time

- `atticus questions show <id> [--json]` shows one question on file with its options, evidence and answer. A subcommand `questions` hasn't (`questions shwo`) is refused with the three it has, instead of listing the knowledge gaps.
- Answering a stage's question says it was answered "for this change, <id>", not "for this repo".

#### Ask through MCP

- The MCP server gains `ask` (a plain question read as a catalog query or an impact walk, as `atticus ask` does, saying the query it ran) and `knowledge_ask` (the knowledge items that may answer a question, by words and meaning, each with its quote and page; the assistant answers only from them and cites each, or says none answers). Both are read-only, like every tool.

#### The tour and focus

- The first-run tour has five steps: home, asking, one change at a glance, running a step in your assistant (`/atticus-next`), and approving by pull request. It takes focus when it opens, keeps Tab inside it, and gives focus back when it closes.
- Moving to another screen puts focus on its content, so a keyboard or screen reader user starts there rather than in the menu.
- The accessibility journeys fail on a moderate axe violation too, not only serious and critical ones; every screen passes in both themes.

#### IntelliJ as a peer of VS Code

- A **Waiting on you** tab: a tree of the questions to answer, each change with something open and the knowledge no one has checked, read in the background and again when the metarepo's files change. A question opens a native answer dialog with each choice, what it means and the lines it read, or your own words.
- The **status bar** says the questions, the next step and how many changes you watch, as VS Code's does; a click shows the next step, which is now read in the background.
- **In the gutter**, each line a flow or a record cites, with the changes in flight on it; a click opens the flow, a change, or what breaks. The new `atticus cites --repo <r> --path <p>` (or `--file <path on disk>`) gives the same as `GET /api/cites` to any editor.
- New actions: Answer a Question, New Change (from an earlier change if you pick one), Watch a Change, Create a Metarepo, Use Atticus in This Project (it asks first), Try a Practice Metarepo. Change Diagram and Estimate pick the change from a list.
- Lists are searchable dialogs; a metarepo's name and platform are checked before `init` runs; the path to atticus has Browse and Check; one notice when the command line can't be found, with Don't show again; an AI step's slash command is offered only where its prompt file is, with Write the prompt files otherwise.
- `ParityTest` places every VS Code command in IntelliJ (an action, Run a Command, a screen of the app or a tab) and fails on a new one that isn't.
- Not yet run inside the IDE: compiled, its logic tested and the plugin built.

#### Start from an earlier change

- Archived changes are read into the index by their brief, and found only when asked for: no step's context and no name's resolution includes them.
- `atticus change similar "<brief>"` (or `--change <id>` for a change's own title and brief) lists the archived changes nearest it: by meaning where the embedding model is on, by shared words where it isn't, and it says which.
- `atticus change new … --like <archived change>` and `atticus change attach <change> --like <archived change>` attach the earlier change (what it asked for, where it was placed, its target flows and its tasks) to the change's inputs/ as `like-<id>.md`. Its steps read it as an example, as data, never as an instruction.
- The change's At a glance page lists "Earlier changes like this one" with **Use as an example**. VS Code's New change offers them after the title.
- The local API gains `GET /api/past-changes` and `POST /api/changes/{id}/like`, and a new change takes `like`.

#### Your first hour

- A new lesson for everyone, whatever their role: `atticus learn start everyone` (and the Learning screen, where it comes first). In a scanned sandbox it walks `atticus next`, a change at a glance, asking the catalog, `atticus watch` and how approving works, and checks each step was done.
- `atticus watch` is listed with the other "what waits on you" commands in `atticus help`.

#### Act on several waiting items at once

- Home's "needs a person" list has a checkbox on each need and manual step. With some selected, one action applies to all of them with one reason: mark the needs done (with the ticket or note), mark them not needed (with why), or skip the manual steps (with why). The button says how many it changes, and the result says how many couldn't be changed.
- A manual step's result and a knowledge item's verdict stay one by one: each needs its own values or a look at its quote (Knowledge's review mode is for that).

#### Watch a change

- Follow a change without being on it: `atticus watch <change>` (`--off` to stop), **Watch this change** on its cockpit, or on a change in VS Code's sidebar. It is kept in your own `.atticus/me.yaml`, never committed.
- Your digest gains "Changes you watch", one line each: where it is, how many things block it, the questions that wait, and the next step. `atticus watch` with no change prints the same. Watched changes don't count as waiting on you.
- The local API gains `PUT /api/me/watch`, and `GET /api/me` lists what you watch (API 2.21.0).
- VS Code's status bar says how many changes you watch, and its tooltip says how each is doing. IntelliJ has no status-bar count yet.

#### A page for each system

- Estate gains **Systems**: pick a system and read its guide (generated from the catalog, every fact citing code, with what it doesn't know yet), the open questions about it and the changes in flight in its repos, each opening the change at a glance. The ecosystem map's guide links to it.

#### Review mode for knowledge

- Knowledge items has **Review what no one has checked**: it walks the items nobody has reviewed, or whose page changed since, one after another, with the quote and its page beside the item. Keys: j or ↓ next, k or ↑ back, v verify and go on, c correct, r reject. The keys act while the item's panel has the focus, never while typing in a form.

#### What passes through a line of code

- VS Code's lenses over a cited line now also say which changes are in flight on a flow through it ("change add-tags is in flight here"), opening the change at a glance, and offer "what breaks if this changes" for the records read from the line, opening the Impact screen. `GET /api/cites` gives each flow's changes in flight (those whose target flows touch it).
- Not built yet: the same in IntelliJ (a gutter icon).

#### A hand-off PR that reviews itself

- The PR `atticus change handoff` opens now ends with what an approver would otherwise open the app for: what the change does as a picture (Mermaid, which GitHub and Azure DevOps draw), its estimate as a range with what drives it, and the findings still open at its gates, blocking first.
- Not built yet: "what changed since the last round" for a PR updated after changes were requested.

#### The code beside a question

- Answering a question now shows the lines it cites, the cited line marked. The app's Questions page shows a few lines around each, read from the repo's base clone (or the metarepo, for a change's question; `GET /api/questions/{id}/evidence`, API 2.20.0). VS Code's answer picker lists each cited line's text under "What it read"; picking one opens the code there and comes back to the answers.
- A line that can't be shown says so: the file isn't here, or the line is past its end. Nothing outside the repo or the metarepo is read.
- IntelliJ shows the same in the app panel; a native IntelliJ answer dialog isn't built yet.

#### One change at a glance (the change cockpit)

- A change's first page is now **At a glance**, its cockpit. It shows where the change is on its stage path, with each stage's drafts, critic rounds and open questions; the next step with its slash command and command; what blocks it; and each repo's change branch, base and pull request (`GET /api/changes/{id}/cockpit`, API 2.19.0).

#### Knowledge files in the metarepo's inputs/ (ADR 0122)

- Files dropped in the metarepo's `inputs/` are now general knowledge. `atticus sources sync` reads them as a source called `inputs`, with the wikis or alone (`--source inputs`), and needs no wiki configured. The knowledge scan reads the snapshot into items, each quote checked against the file.
  - Intake decides which copy counts: a file dropped twice is read once, and an older version is kept but not read.
  - Markdown, text, HTML, Word, PowerPoint, Excel and PDF are read into text; Markdown as it is, so a quote's line is the file's line.
  - A picture goes to a person. Specs, diagrams and payload samples are left to intake. Each is listed with the reason.
  - `sources.yaml` may no longer call a wiki `inputs`.
- Knowledge has a **Documents** tab. It lists every file in `inputs/` with its kind, the systems it names, whether it was read (or why not), its age and the items that quote it, filtered by kind, system or words. It has **Add files** and **Sync inputs/** buttons, and the knowledge scan's command for the assistant.
- A file attached to a change can become general knowledge. **Copy to general knowledge** on the change's Files attached panel, or `atticus change attach <change> --promote inputs/<file>`, copies it into `inputs/inbox/`; the change keeps its copy.
- VS Code and IntelliJ have **Add to Atticus knowledge** on the right-click menu, beside **Attach to Atticus change**.
- The local API gains `GET` and `POST /api/knowledge/documents` and `POST /api/changes/{id}/inputs/{name}/promote` (API 2.17.0). `atticus intake add` and the upload share one function.
- Not built: OCR for a scanned PDF with no text layer; listing the changes whose steps cite a file's items.

#### Four fixes from a live run of the stages (ADR 0087, 0115 and 0117 addenda)

- A fix a person applies when the gate has no critic round left no longer leaves the change stuck. Once a person has acted on every blocking finding of the gate's newest round (applied, waived or dismissed), the gate allows one checking round past its limit; `atticus critic` and the stage run it. If it finds something blocking, a person decides again, and the stage stops without drafting over their fix. `atticus finding … apply` says what really comes next instead of "the next critic round checks the fix". `gateStatus` and `atticus findings --json` show `checkRound`.
- `atticus change status`, `canAdvance` and `change handoff` follow the path a change is on. On the stage path (feature, architecture, stories) a phase is due its stage's files and its loop done, not `proposal.md` and `specs/`; the hand-off PR carries the stage's files. The path is the change policy's new `stages` section, so an org pack can change it.
- A criterion that checks a field without naming it is no longer handed back with "name it in its then clause". Where a model is called directly a judge reads it (`covers-field`); with a hand-off it is a note under the criterion in the story file for the story lens and the reviewer, never a stop. It reads verdicts with `settle()` from `@maycombhq/ai`.
- The architecture and stories stages refuse while an earlier stage isn't finished (its loop not done, or its gate blocked), naming the stage, the gate and the command. They may still run before the earlier hand-off PR merges.

#### Any assistant, set up from the app (ADR 0121)

- The app has an **AI** tab under Set up. It sets whether AI runs here, which assistants your people use and the default one, the modes a step may run in and the default, and the model provider, with one field for each setting the provider accepts. It shows whether the provider's key variable is set on this machine, by name.
- **Save** writes the org pack's `runtime.yaml`. It keeps everything the tab doesn't change, is checked against the schema, refuses anything that looks like a key, and says to commit the file in a pull request.
- A provider's key can be kept in this machine's credential store instead of an environment variable, under the name `runtime.yaml` gives as `keyEnv`. The runtime reads the environment first, then the store. `atticus secret set|check|forget <name>` manages it: the key is read from stdin and never printed. The AI tab has a password field, "Set the key on this machine" (`POST /api/settings/ai/key`). It uses the system's own command, so no dependency is added: on Windows the key is encrypted with DPAPI for the current user; on macOS it goes in the Keychain; on Linux in the Secret Service.
- **Test the provider** asks the configured provider one short question, with nothing of the estate in it, and says whether it answered.
- The local API gains `GET` and `PUT /api/settings/ai` and `POST /api/settings/ai/test` (API 2.16.0). `@maycombhq/model-providers` exports each provider's accepted settings (`PROVIDER_SETTINGS`).
- VS Code: **Atticus: Pick the model** (also in the Next view's menu, and the button when no model is found) lists every chat model VS Code offers, under its vendor, not only Copilot's. It also offers Copilot's default and **Atticus's configured model**. The choice is kept in `atticus.model` as `vendor/family`; a bare family still means Copilot's. A step started from the chat runs on the model picked there, whatever its vendor.
- Atticus's configured model runs the step on `runtime.yaml`'s model provider, through the command line in model mode, so it needs `model` among the modes allowed. `atticus <step> --handoff --json --mode model` runs the step that way and prints its end as JSON.
- One line says what runs a step here, for example "Hand-off to GitHub Copilot · model mode allowed: anthropic claude-opus-5-5". It is on Home (with a link to Set up › AI), at the top of VS Code's Next view (beside the model VS Code runs steps on; a click picks the model), in `atticus next --json` (`runs`) and in `GET /api/settings/ai`.
- The setup checklist gains "Choose how AI runs here". It is optional, and done once `runtime.yaml` is no longer as `atticus init` wrote it.
- The AI tab also edits the models allowed (one a line) and the budgets: the tokens for a step, and per agent as `architect: 300000` lines. A line that doesn't read is named before anything is saved.
- IntelliJ can run an AI step itself, for the first time: where `runtime.yaml` allows model mode and names a provider, the AI step and Next step offer **Run it on Atticus's configured model**. It runs the step with `--mode model` in a console. Both say how AI steps run here. `atticus next --json` gains `modelMode`, as data.
- **Model-provider plugins.** For a provider Atticus has no built-in for, an org pack can add `plugins/model-providers/<id>/`, and `runtime.yaml` names it as `adapters.model.type`.
  - The plugin's code only translates: `request` builds the request and `response` reads the answer. It runs in the plugin sandbox.
  - Atticus makes the call itself, over HTTPS to the hosts the manifest names, and adds the key. The plugin never sees the key.
  - It is pinned by sha256 like a scanner plugin. `atticus plugin test` runs its request and answer golden files, and `atticus plugin pin` pins it.
  - `atticus plugin add vertex` copies the Vertex AI plugin Atticus ships. It covers Anthropic's models through `rawPredict` and Gemini through `generateContent`.
  - The AI tab lists plugins beside the built-ins, says when one isn't pinned, and its Test goes through the plugin.
  - Not built yet: tool calls from a plugin, and refreshing a token.

- `runtime.yaml` may now allow `cursor`, `gemini-cli`, `windsurf` and `agents-md` (Codex and any tool that reads `AGENTS.md`) beside `copilot` and `claude-code`. `atticus assistant-files` writes the same slash commands, instructions and skills for each one, in its own files:
  - Cursor: `.cursor/commands/` and an always-applied rule.
  - Gemini CLI: `.gemini/commands/*.toml` and `GEMINI.md`.
  - Windsurf: `.windsurf/workflows/` and a rule.
  - AGENTS.md: an `AGENTS.md` section listing each command and the file to follow, in `.atticus/prompts/`.
- Every v1 `runtime.yaml` stays valid as it is.
- `atticus next` says where to type the slash command, from the default assistant ("In Cursor's chat: /atticus-feature …").
- Outside a metarepo, `atticus next` now says the folder isn't one and how to make or open one, instead of suggesting a step.
- `doctor` looks for each allowed assistant's program.
- A critic lens on headless Claude Code runs in an empty folder of its own under the system's temp folder, not in its run folder: outside the metarepo, and a short path. Windows can't start a program in a folder over 260 characters, and a run folder under a deep metarepo can pass that; a real run hit it. Its findings are kept in the run folder. When Windows still can't start Claude Code in a long folder, the message says so instead of blaming PATH.
- Running headless Claude Code no longer stops the command line on a pipe error (`ENOTCONN` on Windows): an error on the process or any of its streams fails that run with its reason (`collectChild`).

#### More judgments by the model, checked by facts (ADR 0117 addendum)

- Six more word rules are gone, each now a closed question to the judge with a fact that settles what it can first, kept in `judgments/<kind>/`: whether an API change breaks callers (release notes; a new or retired operation is settled by its change kind), which sentences say how a deployment step is undone (deployment plan; a sentence naming another step is about that step), which lines name a secret (security review; a token in a known format stays a fact, is listed as a gap and is never shown), whether a new column holds personal data (the critic and the security review; `looksPersonal` and its word list are deleted, an org's `personalHints` still apply), which of the readiness bar's checks a definition-of-ready item asks for (Atticus's default items keep their checks), and how a wiki sentence says one system reaches another (`atticus sources sync`; `judgeFacts`).
- The judge is asked only where runtime.yaml's runtime calls a model directly. With the hand-off runtime nothing is asked and nothing is guessed: the release notes say `check (not judged)`, the plan says which lines a person reads for a rollback, the review lists the fields and lines not judged, the critic asks the table's owner which columns hold personal data (a knowledge gap), the bar lists the items it couldn't check, and `sources sync` prints the sentences no one has judged.
- `fixtures/judgments/` gains the failing cases of each rule, both ways; the judgment bench scores them: the old rules got 30 of 67 right, the judge 67 of 67, the hand-off said yes wrongly in none.
- The release notes' table says who settled "Breaking" (its change kind, a model, a person, or not judged); the security review's "Looks personal" column is "Personal data" (yes, no, unsure or not judged).

#### The critic's lenses run on headless Claude Code (ADR 0115 addendum)

- A feature stage run with `--mode headless-claude-code` no longer stops because its lenses may not run there. The built-in lens agents allow headless Claude Code, and each lens runs in its own run folder, so the only file it can write is its findings, never the draft it reviews. Found by a run on a real metarepo.
- An org pack's own lens agents keep the runtimes they list; a stage that can't run them stops and names the agent and its allowed runtimes.
- A lens answer that doesn't read (a value with ": " left unquoted, say) goes back to that lens once in the same round, with why and its earlier answer as data, before the lens counts as failed. In hand-off mode `handoff done` already offers it again.
- A critic round in which every lens failed to start (Claude Code missing, a timeout, an outage) no longer counts toward the gate's round limit: it reviewed nothing.
- A done architecture stage of a change in build or later stays done when a rescan moves today's flow: the change's own code moved it. It says so in a note; before build, it drafts again as before.
- The VS Code chat records the change a request ran on in the prompt history (`history add --change`), once the participant has resolved it. A prompt is written as soon as its change is known, not when the step ends.

#### Retrieval's defaults: the best-scoring model, and the expansion on (ADR 0116 addendum)

- The product owner's decision ("use the best model", "turn rewording on"): `runtime.yaml` `retrieval` now defaults to `embeddings.model: bundled` (all-MiniLM-L6-v2: 0.96 recall on the retrieval cases, against 0.81 by words alone and 0.84 for arctic-embed-xs) and `expansion: true`. `rerank` stays off: it isn't measured. A pack without the section and one with `retrieval: {}` get the same defaults, from one helper (`retrievalOf` in `@maycombhq/core`) every reader uses. An organisation can still set `model: off` or `expansion: false`.
- Where the bundled model or onnxruntime isn't installed, the context engine searches by words and names, never fails a step and downloads nothing. `atticus doctor` says so under "Embedding model": a note when it is the default, a warning when `runtime.yaml` names a model that can't be used.
- With the expansion on, a vendor or system the brief names only in prose is a gap again (a fixture: the invented Northwind Pay in a sentence, unknown to the estate).
- In hand-off mode the expansion is one extra round per step, first. Its answer is now kept by what the model was shown (the input and the estate's names) rather than the index's generation, so a stage's own drafts don't make it ask again: a feature stage is the expansion, then its drafts, as before. Run again without `--resume`, a step waits on the same expansion prompt, or reads in its answer, rather than handing a new one off. An answer that fails its check is left out with a note in the step's context, and the step goes on by words and names.
- The context eval's step rows run with the model and the expansion off in their roots, so they measure the engine itself, the same on every machine.

#### Retrieval by meaning in the context engine (ADR 0116)

- A harder eval: 61 retrieval cases in `fixtures/retrieval` (identifier words, paraphrases, glossary synonyms, two links away, 208 look-alike records, facts only in a Word document, a sentence deep in a long wiki section, exact names, inputs nothing answers), scored by recall, precision, MRR and tokens at a normal and a tight budget in each mode. `pnpm --filter @maycombhq/evals eval:context` writes `docs/evidence/context-eval.md`. All answered cases: 0.72 recall before, 0.81 now without a model, 0.96 with the local model's recorded vectors.
- Without a model: search finds the words an identifier is made of (`renamedAt` for "the renamed timestamp"; index version 3, rebuilt once); a glossary term or alias the input uses brings its other names and the columns it defines, and a GlossaryTerm links to those columns; a wiki section is named by its heading path and a long one is cut into parts that keep their line; documents in `inputs/` (Word, PowerPoint, Excel, PDF, Markdown, HTML, text) are indexed section by section after the ingested-content screen, ranked below records; the searches are fused by reciprocal rank and every seed says which found it.
- A local embedding model (`retrieval.embeddings.model` in `runtime.yaml`: `bundled`, the default, `off`, or a model folder): `@maycombhq/embed` runs an fp32 ONNX model on the CPU with onnxruntime-node (WASM fallback), vectors kept in `.index/vectors.sqlite` by model and text hash as int8, scored by an integer dot product. "Similar in meaning" ranks only once every node has a vector, and the selection says how far it is. `atticus index embed`; `atticus query --search --by words|meaning|both`; `atticus context similar <id>` and the `similar` tool (the MCP server too); `atticus doctor` reports the model. Similarity never makes a link, a name, a gap closed or a fact. The model is listed in the SBOM with its sha256 and licence; DirectML never ships; the bank approves shipping the model.
- The model's expansion of a step's input and its rerank of the candidates (planner `expand.ts`, `rerank.ts`), each one small call, checked (ids the index has, the input's own words, only candidates it was shown), kept in `judgments/` and shown in the run record (version 3, `retrieval`; versions 1 and 2 still read), `atticus runs show`, the transcript (API 2.15.0) and the Model runs screen. In hand-off mode each is a hand-off of its own. Both off by default (`retrieval.expansion`, `retrieval.rerank`): the eval's expansion answers are stand-ins, not Copilot's.
- The gaps' word lists (small words, verbs, Given/When/Then words, Title Case lines) are gone: with the expansion on, the model names what the input uses and the index checks it lacks each; with it off, only names in backticks and endpoints are asked about.
- The model comes with Atticus (ADR 0116, its second addendum), so the `bundled` default works after an install: `@maycombhq/embed-model` (all-MiniLM-L6-v2, fp32, 87 MB) and onnxruntime 1.30.0 repackaged per platform (`@maycombhq/onnxruntime-<platform>-<arch>`, its CPU build with no install script and no DirectML, and `@maycombhq/onnxruntime-wasm`, the WASM fallback) install with `npm install @maycombhq/cli` and nothing else. Their files are not in git: `prepack`, `pnpm model:fetch` and `pnpm bundle` fetch each from its pinned source and check it against the sha256 in the package's `pins.json`, through a cache (`.cache/pinned`). The offline bundle carries them for its platform (about 113 MB on Windows; `ATTICUS_BUNDLE_MODEL` and `ATTICUS_BUNDLE_ORT` are gone). Tests run with `ATTICUS_EMBEDDINGS=off`.

#### One experience on every surface: state that tells the truth (ADR 0119)

- The local server follows the metarepo's files: what an assistant, the CLI or a person writes (a change's files, specs, questions, knowledge, the catalog, proposals, inputs, model runs, the prompt history) reaches the app as a `file.changed` live event within about a second. The app in a browser and in IntelliJ's panel now updates as VS Code's does, without a reload. It never follows the base clones, the index or Git. `startServer({ watch: false })` turns it off.
- Explore, Questions, Learning, Settings and Across now read again when files change, as the other screens do (`useReloadOnFiles`).
- Cancel stops the work: a job runs inside an abort signal, which a model call stops on at once (the run is recorded as cancelled) and a scan checks between repos, before it writes. A cancelled job ends as cancelled, not failed. The Scans panel and Run with the model show Cancel while they run.
- The Scans panel says a job's state in words and lists each error on its own line.
- VS Code: a failed read of a change's tasks says so instead of "no tasks"; lenses that can't be read and a startup check that fails say why in the output. Its app panel also follows proposals, inputs, the model runs and the prompt history.
- `atticus ui` prints the session token only when an editor started it (`--embed`, `--parent`) or with the new `--show-token`.
- The command line refuses a flag no command knows, with the nearest one and exit 2, running nothing: `--aprove` says "Did you mean --approve?". Every flag the help names, the editors pass and the slash commands use is known.
- The app's server keeps the catalog it read in memory while it runs and reads the files again on any change its watcher hears, its own writes or a scan (`keepCatalogsInMemory`, `forgetCatalogs` in `@maycombhq/scanner`); it reads the catalog as it starts. On a real metarepo of 1,537 records, a change's page went from 7 s to about 1 s, Home from 10 s to under 3 s, the Overview from 2.7 s to 0.5 s. A one-shot command reads the files as before.
- From a real run on a metarepo: `atticus change new` without `--type` lists the change types the org pack has; `atticus help change new` shows its options (`--template`, `--id`, `--owner`, `--system`), which the help had under `change draft`; `doctor` says when AI steps may also run in headless Claude Code; the Changes list's tab is "All changes" (or "This change" on a change), and Knowledge's first tab "Knowledge items", so no breadcrumb repeats itself.
- The app's menu is six sections, in the order a person uses them: Home (Waiting on you, and the Overview that was the Dashboard), Changes, Knowledge, Estate, Set up and Atticus. Each page is a tab of its section, shown above it with where you are; a change's pages are grouped by phase (Define, Design, Plan, Build, Release), and moving between them keeps the change. More is gone. Every address still opens its page; an unknown one opens Home. "Knowledge explorer" is now "Search the catalog" (it searches the catalog), "To-do and manual steps" is "Manual steps", "Dashboard" is "Overview".
- VS Code: Open on the Architecture canvas, the Change diagram and the Estimate pick the repo or change from a list instead of asking for a typed id. When a window opens, what it found (Copilot not set up, an upgrade to run, what `doctor` says) is one notice with Show all, Upgrade or Set up Copilot, and Don't show again, which holds until the set changes; before, up to three toasts each time. Messages say what happened in words instead of "It exited 2", and a command's result starts with what it said, not the command line (that goes in the output). After an answer, Run the next step is one click. A second practice metarepo gets a folder of its own.
- One set of slash commands on every surface: `metarepoCommands()` in `@maycombhq/assistant-files` is the one list; the app's Help, the Claude Code plugin's README (now generated from it), the roles guide and IntelliJ are tested against it, so a command missing from any of them fails the build. New: `/atticus-draft <change>` (proposal, spec and interfaces), `/atticus-knowledge-ask <question>`, and `/atticus-critic <change>` now runs the critic's AI lenses one at a time with `--handoff` instead of describing files the change no longer has. `/atticus-snow` and `/atticus-release` run `atticus plan snow`, `change status` and `release plan`; `/atticus-plan` is the old name of `/atticus-stories`, kept for one version. The app's list gains `/atticus-small`, `/atticus-attach`, `/atticus-draft` and `/atticus-knowledge-ask`.
- IntelliJ told a person to type `/atticus-plan` for `change draft`; it now says `/atticus-draft`, and `/atticus-knowledge-ask` and `/atticus-critic <change>` for those steps.
- The MCP server's tools say `readOnlyHint: true` in the protocol, so an assistant can call them without asking.
- `atticus doctor` (and Settings, This machine, in the app) says how AI steps run here: handed off to your assistant, or model mode with which provider and whether its key variable is set (by name; never the value, and no call). It also says whether the `/atticus-*` slash-command files are there and current, with how many are missing, out of date or edited by hand.
- `atticus --help` groups the commands by area (setting up, repos, knowledge, the catalog, changes, plans, release, every AI step, every command); Atticus's own quality commands (bench, eval, conformance) show only with `atticus help --all`.
- `atticus help <command>` (and `atticus <command> --help`) prints that command's usage and options instead of the whole help; a misspelled command says the nearest one ("Did you mean atticus change list?") instead of printing all 230 lines.

#### What an adversarial review of the stage loop found (ADR 0115 addendum)

- A lens that didn't review is never a clean review. An empty answer, a refusal or prose (no `findings` list) fails `atticus handoff done` and is offered again; in model mode it records the lens `failed`. A failed lens in a gate's newest round now stops the gate's hand-off (`lens-failed`) until a new critic round reviews. This applies to the code-and-test lens's hand-up review too.
- A lens run that is gone or cancelled is recorded `failed` and the next lens is offered. The draft is kept: when every lens is in and one didn't review, the stage stops, and running it again sends the same draft to a new critic round. Before, the stage kept waiting on the dead lens and dropped every later draft.
- A stage waits on its own round's lenses, even when someone runs `atticus critic` at the same gate in the meantime.
- When the gate's critic rounds are used up (`maxAuthorRounds`), the stage stops for a person to decide. It no longer says nothing blocks. A draft that fails the stage's own checks uses no critic round.
- A done architecture stage, checked again after the change's code merged and was rescanned, is not drafted again: its own migration (by its file name), and a table or entry it marked new, may now be in the catalog.
- A question the loop raises is linked to its finding by the question's id, never by its words. A finding a person answered that comes back in a draft given the answer stops the loop, so the assistant can't draft for ever. Note: since the questions moved to the code repo (ADR 0111 addendum), questions answered before under the change id are asked once more.
- A resume names this stage's own draft or a lens of its round, or it is refused: another change's run is never read in as this change's draft. `--handoff --json` offers only the run the step reports, as data, and only the step's change's runs. A lens offered again after its answer failed the check is `stillWaiting` and counts toward the runner's limit.
- The last draft's findings and people's answers go to the drafter as a data block (`hand-backs`), screened by the defences, never inside Atticus's trusted instructions.
- A lens's quotes are checked against the draft it was given. The draft is kept in the run's folder when the lens is handed off.
- `feature.yaml` goes to the architecture drafter as it is on disk, so `feature.yaml:N` cites the file's line N. Attached files are cited by their path in the change folder (`[inputs/refund-rules.md:12]`), so a question resting on an attachment is asked. A cited line whose path has a space is kept.
- `inputs/index.yaml` can't point a step at a file outside `inputs/read/`.
- Attaching never replaces a file because of its name. A file named like one already attached is kept beside it, both are read, and a note says how to replace it: `atticus change attach <change> <file> --replaces inputs/<old>`. This also works for a file already attached.
- `delta.sent-not-stored` flags a sent field only when the step says nothing else about it. A qualified name (`order.id`) is read by its last part, and a key the write matches rows by goes under `checks`. A step kind that must name a table, and so has no `to`, comes from the spec template's step rules, so a lookup may have a `to`.
- Conformance: a migration named with its folder is found, a table whose columns no scan read lists them as unchecked rather than missing, concurrent scans of one commit each get a folder of their own, and two missing columns of one step get their own finding ids.
- The prompt history tags a record with a change only when the surface passes one (`atticus history add --change <id>`) or the branch is `change/<id>`. It no longer finds a change id in the prompt's words.
- The VS Code runner reads a batched knowledge scan's pages left from the `pagesLeft` field, not from the printed words. `run.json` is written atomically, and a stage run while it is half written waits instead of drafting twice.
- The Claude Code history hook never hands Windows' `cmd` an argument it would expand (`%…%`).
- Not built: the VS Code chat doesn't pass `--change` to `history add` yet; a done stage whose today's flow changed because its own change merged is still reported stale (`delta.stale`).

#### The model searches the code (ADR 0118)

- Three more read-only context tools beside search, show, walk and show_code: `grep` (lines that match a pattern the model chooses, literal or a regular expression, case-insensitive if asked, limited to a glob of paths, in one repo or every clone; each hit `repo:path:line: text`; 30 hits by default, at most 100), `files` (paths a glob matches, at most 500) and `outline` (a file's declarations from the syntax tree the readers parse, nested, with the annotations, decorators or attributes written on each; a Markdown or AsciiDoc file's headings, a YAML or properties file's keys). They read the base clones under `workspace/` only, with the same path guards, and skip `.git/`, links, binary files and everything the repo's `.gitignore` files ignore.
- A hit is a pointer, never a fact: `show_code` by repo, path and line may now show a line a `grep` or `outline` hit of the same run returned (in a call made elsewhere, the hits are read back from the run record), and facts still cite their file and line, checked at that line. The calls are kept in the run record and shown in Model runs.
- Offered everywhere the context tools are: the model runtime, the VS Code extension's `vscode.lm` tool calls, the MCP server (`grep`, `files`, `outline`) and the commands `atticus context grep`, `atticus context files` and `atticus context outline`.
- `atticus scan survey` tells the model to search for the code that sets a prefix, a base or a folder the material doesn't show (an in-house annotation, a wrapper) and to cite the line it found; the survey, dialect draft and scan review offer their repo to the tools by its id even when it was given as a folder. Spec draft and scan verify say the tools may be used where they are offered.
- Not built: `show_code` through the MCP server still takes an id only; a language without a shipped grammar outlines to nothing.

#### Judgments by the model, checked by facts (ADR 0117)

- A closed question about meaning (is this question one on file, does this criterion check this field, does this span state this value, does this process apply to this step) goes to the model through the AI runtime: one word of a closed set or "unsure", every quote checked word for word, catalog facts vetoing first. Unsure becomes a question to a person or a hand-back, never a guess.
- Judgments are kept in `judgments/<kind>/<key>.yaml`, the key a hash of the inputs: the same inputs read the stored verdict, a changed one asks again for itself only, and a person's verdict is never replaced. Commit them for review as `questions/` are.
- Questions: matched by id, then candidates, then a veto (two questions naming different ids, fields or numbers are never the same: `renamedAt`'s classification is never read for `renamedBy`), then the step's own reading (`sameAs`, from the questions on file now listed in its prompt) or the judge. A question that may be the same as one on file is raised with it under `related`. An answered question is read for another only when the new one names nothing it doesn't. Questions are at schema version 2; `atticus upgrade` rewrites older files.
- Stories: each criterion says which fields it checks (`checks`); every field of a task must be checked, and a field the then clause doesn't name is judged, or handed back with a hand-off. The story writer names each request a step meets, quoting its applies-when; where a model can be called a judge looks for any it missed. The old word matches (`namesField`, `suggestRequests`) are gone.
- Knowledge: an item cites the words for its lead time, status and dates (`lead_time_quote`, `status_quote`, `date_quotes`) and gives its lead time's reading (`lead_time_days`). "3 days" is no longer found in "3 approvers and take 15 days", nor 1 March 2027 in "March 2027 ... 1 pilot"; a status is never read from a word list. `atticus change needs` and the next-step list plan by the reading, not by parsing the words.
- A step's answer lists the gaps it relies on (`relies_on_gaps`); a gap it only mentions is not asked.
- `atticus knowledge ask` meets "process" with "processes"; testgen no longer reads a `javascript-spa` repo as Java.
- The evals score each replaced judgment against the rule it replaced, on `fixtures/judgments/` (the audit's failing examples among them).

#### A starter review every metarepo gets (ADR 0120)

- `atticus init` and `atticus adopt` write `org-pack/checklists/review.yaml`: ten AI rules for the critic's business, architecture, story and delivery lenses, each a plain-words prompt that judges a draft's meaning against the estate and the brief and quotes the line it cites. Define: every outcome is placed; a flow the change alters isn't marked only read; a capability the brief assumes that nothing in the estate does is named as a gap. Design: every outcome has its target-flow steps; data a step returns or shows comes from somewhere; a new column has its classification and migration; each hop's pattern fits it. Plan: each outcome has a story; criteria are testable and name their data; requests are raised in time. With the default gates and change types, a new metarepo's drafts are now reviewed by a model, with Copilot too.
- It is the organisation's configuration, not the constitution: change, waive, retire or delete its rules, or delete the file to turn it off. `init --from <pack>` doesn't add it.
- `atticus upgrade` adds it once to a metarepo whose org pack has no AI review of its own, with the checklists README beside it, backed up first; it leaves a `review.yaml` or any checklist with an AI rule alone, and doesn't add it back once deleted.
- In a stage's review, the change's brief now goes to every lens with the draft, so a lens whose rules read other artifacts (the story lens) still judges against the brief.

#### What a live run with Copilot found (ADR 0111 addendum)

- The fast path and the architecture stage check that every field a plan returns comes from somewhere, that a write stores what it sends, and that a read or write names its table under `store`; a column in other casing, a classification outside the org pack's levels and a misnamed Flyway migration are handed back.
- A citation of a data block (`atticus-data:brief.md:5`) is read as that block's file: the block's id is Atticus's own. Mistakes about meaning are handed back with hints the catalog gives (the flow an endpoint starts, the nearest entries, the `store` form), never rewritten.
- Questions: one that cites no file and line isn't asked; reference errors are the draft's to fix, not a person's; a column's classification is asked plainly with the org pack's levels as choices; every question is filed under its own repo.
- A stage run again while its hand-off waits offers the same run again; one whose run is gone drafts again; one whose answer was checked but never read in reads it in.
- The task context puts a new migration in the folder the store's migrations are in; an estimate of one unit says "1 unit of work".

#### The critic's AI lenses review every draft, with Copilot too (ADR 0115)

- In hand-off mode (Copilot in VS Code, `--handoff`), `atticus change feature`, `change architecture`, `change small` and `plan stories` now hand off the critic's AI lenses after a draft passes the rules, one at a time: the step ends on the lens's run, and after `atticus handoff done` its resume offers the next lens. When every lens is in, their blocking findings go back with the next draft, as the rules' findings do, and their knowledge gaps become questions. Before, the lenses were recorded as not run and left to `/atticus-critic`.
- Each lens now reviews the stage's draft (`feature.md`, `feature.yaml`, the target flows and the artifacts the stage writes) with the estate the drafter read, against the brief, including what the draft left out. It may cite the draft's lines. The lens's prompt says so.
- Which lenses run comes from the org pack, as before: the gate's checklists, the change type's lenses and each rule's artifacts. AI off keeps them off. A draft with a blocking finding of its own goes back first, without lenses.
- `--handoff --json` adds `lens` to a lens's hand-off. The VS Code runner doesn't count a lens's first offer toward its limit of eight hand-offs, but a lens offered again counts.
- `round.yaml` records each lens that ran, with the draft files it read under `artifacts`.

#### Prompt history (ADR 0110)

- What people type to their assistant in a metarepo and what it answers, kept beside the model runs: one record per prompt and per response in `.atticus/history/<yyyy-mm>.jsonl`, on this machine only (`history/` joins `.atticus/.gitignore`; `atticus upgrade` adds it to an older metarepo). Each record has its id, time, surface (`claude-code`, `vscode` or `cli`), session, kind, text, size, its slash command, and the change it is about when that can be told exactly (the one change its text names, else the branch `change/<id>`). Text is cut at 64 KB and marked; what matches the log's secret patterns is masked and the record marked. Text is data, never instructions.
- `atticus history add --surface <s> --kind prompt|response [--session id] [--command c]` records one, reading the text from stdin; `atticus history [--change id] [--session id] [--filter words] [--limit n] [--json]` lists the turns (each prompt with its response) by session, newest first; `atticus history show <id> [--json]` prints one and its pair; `atticus history off` and `history on` stop and start recording on this machine (`.atticus/me.yaml`). The org pack turns it off for everyone with `history: { record: false }` in `runtime.yaml` (optional; no schema version bump).
- The Claude Code plugin: `UserPromptSubmit` and `Stop` hooks record each prompt and each reply (the transcript's last assistant message) in a metarepo, printing nothing; the read-only MCP tool `prompt_history`.
- The VS Code extension records every `@atticus` request and the reply it streamed through `atticus history add`, a session per chat; **Atticus: Open the prompt history** opens the screen. Copilot's other chats can't be recorded: VS Code gives extensions no access to them.
- The app: a **Prompt history** screen (More, Run, `#/history`), the turns grouped by session, each prompt beside its response in a box of its own, with a filter box, a change filter and whether recording is on. The IntelliJ plugin's **Atticus: Prompt History** action opens it (Copilot in IntelliJ gives plugins no chat, so nothing typed there is recorded).
- The local API: `GET /api/history` (`?change=`, `?session=`, `?q=`, `?limit=`) and `GET /api/history/{id}`. API 2.10.0.

#### Checks that tie each value to its source (ADR 0111)

- The knowledge scan and `atticus knowledge find` check each lead time, date, owner and status against the item's quotes (numbers folded from words, "five" is 5; units exact), and each number a rule states against its page; a value no quote states goes back to the assistant, which quotes its line under `also_on`. The bench reference quotes its three lead times so.
- `atticus change needs`: a need's quote has at least 12 letters and a word that isn't a stop word, and when it is needed comes from the item's lead time (20 working days or more before design, 5 or more before build, less before release), not the assistant's word.
- Scan settings: an exclude cites a file in the folder or a line that names it, and can't leave out more than half the code or the main source folder unless a build or config file leaves it out itself; a prefix is the value on its line (or its URL's path or placeholder default); `atticus scan survey` hands back an empty answer for a repo with entry points or calls unless it says why under `nothing_to_set` with the lines it read.
- `atticus change architecture`: a call's entry must be one of the callee's endpoints (or `new: true`, and then not one of them), a new table must not be in the catalog, and a read names columns the table has. Each target flow records the version of today's flow it was written against (flow delta schemaVersion 2; version 1 files read and are flagged as not pinned), so a spec drafted again shows "today's flow changed since this target was written" instead of re-targeting steps by number.
- The critic keeps an evidence entry only with a quote of at least 12 characters on the line it cites (or on just one line of the file); a line number alone no longer counts.

#### Every prompt fits the model it goes to (ADR 0112)

- `--max-tokens n` on every AI step (scan survey and verify, spec draft, knowledge scan, find and ask, change feature, architecture, draft and needs, plan stories, critic): the whole prompt fits n tokens, counted as characters / 4 with a quarter kept back for the count's error and 400 tokens for the hand-off's frame (8,658 of GPT-4o mini's 12,078). The context engine's steps take that room as their budget; the others cut their lowest-priority sources to it. A knowledge scan given only the limit sizes its batches from it.
- A step whose smallest useful prompt (its instructions and what it can't do without) can't fit says so before handing off, with the numbers and what to do: a model with a bigger limit, or, for the knowledge scan, fewer pages at a time.
- The VS Code extension passes its model's limit to every step, not only the knowledge scan, and every round keeps it. The app's server passes the configured model's limit to each step it starts when `runtime.yaml` gives one (`adapters.model.settings.maxInput`, a new optional setting).
- Spec draft and scan verify send code as numbered excerpts, 20 lines either side of each cited line, merged where they overlap and ranked by how many facts cite them; spec draft keeps the cited code ahead of other repos' entry points.
- Scan verify gets the code around each record and must cite each confirmation: the record, the line that shows it in the file it was read from, and a quote of at least 8 characters found there that names its path, method or table. An uncited confirmation (including a bare id) is handed back and never pinned as verified.

#### Small changes fast, files into a change, and the task's context (ADR 0113)

- The fast path: `change-types.yaml` version 2 (C6) lets a change type be `size: small`, a standard type let its brief say `Size: small` (`smallWhenBriefSays`), and name the gate its critic runs at (`fastGate`). `atticus upgrade` moves a version 1 file (`change-types-v2`), every type still standard. The built-in types gain `small-change` (plan, build, release) with its own brief template; `config-change` and `tech-debt` let a brief say small.
- `atticus change small <change>` (and `/atticus-small`, `--handoff`, the VS Code runner, `@atticus /small`): one AI step from brief to tasks. The assistant places the change, writes its target flows and words its stories in one answer; Atticus runs the feature, architecture and stories checks on it, derives the tasks from the target flows, runs the critic at the type's gate on every draft and writes every file the full path writes, plus the proposal while it is still the template. `atticus next`, the app's Run next and the stage pages name it for a small change.
- `atticus change attach <change> <files...>`: specs, screenshots, PDFs, email exports and documents copied into the change's `inputs/`, listed with who and when in `inputs/index.yaml`, a duplicate refused, a newer version kept beside the older, each screened for hidden instructions and read by intake's readers into `inputs/read/` with every line or page cited. The feature, architecture and fast-path steps and the task context read them as data; the context engine indexes them.
- The local API's `GET` and `POST /api/changes/{id}/inputs` (API 2.10.0; the upload in base64, up to 15 MB, guarded like every write) and `fastPath` on a change; the app's Files attached with **Attach a file** on a change's page and the Feature page; VS Code's **Attach to Atticus change** (Explorer, sidebar, palette); IntelliJ's **Attach to Atticus Change…** (Project view, editor tab); `/atticus-attach` for Copilot and Claude Code.
- `atticus task context <change> <task> [--json|--markdown]`: a task's story and criteria, the target-flow step with today's step and the file and line it is cited at, today's flow, the needs, standards and decisions that apply, the files attached and the files likely to change. The `task_context` MCP tool reads it; `/atticus-task <change> <task>` loads it in Copilot's agent mode or Claude Code; VS Code's **Start this task in Copilot** opens Copilot Chat in agent mode with it; IntelliJ's **Atticus: Start a Task in Copilot** puts it on the clipboard; `atticus task run` puts it in its pack.

#### The context engine (ADR 0107)

- The index holds knowledge items, flows and their steps, changes (brief, placement, needs, target flows), answered questions, wiki sections and the profile's systems, with typed links that record how each was made; it updates per file and rebuilds an old index once.
- `atticus query "<words>" --search` and the `search` MCP tool search everything the index holds, names and ids above prose.
- `change needs`, `change feature`, `change architecture` and `plan stories` send the context the change leads to, fitted to the budget, and say what they left out; `--context-tokens n` sets the room, `--whole-context` sends the whole lists as before. The eval (`docs/evidence/context-eval.md`) scores each step with and without the engine; under a tight budget the whole lists lose what the engine keeps.
- The model asks for more (ADR 0107 addendum): read-only context tools beside a step's pack (`search`, `show`, `walk`, `show_code`), defined once in `@maycombhq/index` and run against the index and the workspace checkout (`show_code` shows a few lines at each line a fact cites, never outside a repo's clone). The model runtime offers them through the Anthropic, OpenAI-compatible, Azure OpenAI and Bedrock tool-call APIs; the VS Code extension through Copilot's language model tools, each call run as `atticus context call --run <run>`; Claude Code through the new `show`, `walk` and `show_code` MCP tools. At most 6 rounds of calls and 12,000 tokens from tools in a run (3,000 a call); the run record says when a cap stopped them.
- `atticus context show|walk|code|tools|call` run the same tools from the command line.
- The run record is at version 2 (C5): it keeps the tools offered, every call and what it returned, and the cap that stopped them; a version 1 record still reads. Model-runtime runs are kept under `.runs/` too. `atticus runs show`, `GET /api/runs/{runId}/transcript` (`tools`, API 2.10.0) and the app's Model runs screen show what the model looked up.
- Gaps (ADR 0107 point 5): `change needs`, `change feature`, `change architecture` and `plan stories` list the names the change uses that nothing Atticus has read says anything about, tell the model not to guess, and turn each gap the answer relies on into a question to a person (one per gap and change, whichever step meets it first). An answered gap is indexed as asserted knowledge, the name is known from then on, and the answer goes in the change's later packs. Fewer false gaps: capitalised words in headings, Title Case lines, Given/When/Then, days and months, fields, files and commands in backticks, a known name with a generic word after it (Northwind Pay API) and a phrase a wiki or record already uses are not gaps.
- The context eval runs each step a third way, with the engine and the tools a scripted model calls: at the tight budget the tools bring back what the pack left out (needs: recall 0.50 to 1.00), at more tokens in all, so packs don't start smaller yet.

#### A change drawn from its target flows (ADR 0108)

- `atticus change map <change> [--format mermaid|drawio] [--json]`, `GET /api/changes/{id}/map` (API 2.9.0), the app's Change diagram (More, Design), `@atticus /changemap` in VS Code (drawn in Copilot Chat as Mermaid), IntelliJ's Atticus: Change Diagram and the `change_map` MCP tool: the components, entries and tables a change touches, marked + new, ◇ changed or ✕ retired from the target flows' own marks, the rest as context. A part the catalog lacks is unknown, never new by that alone; a step sent elsewhere draws today's line retired and the new one added. The legend reads + New, ◇ Modify, ✕ Retire in every view.

#### Estimates (ADR 0109)

- A change's estimate: its size counted from its target flows, each changed step a class of work, the org pack's ranges (new optional `estimates.yaml`, with who agreed them) summed by a seeded simulation, the drivers named with their sources, the calendar beside the release forecast's waiting, and never a number nobody stands behind; a unit no class matches says it needs one. `atticus change estimate <change> [--json]`, `GET /api/changes/{id}/estimate` (API 2.10.0), the app's Estimate (More, Plan; linked from the Architecture stage), `@atticus /estimate` and Open a change's estimate in VS Code, IntelliJ's Atticus: Estimate, and the `change_estimate` MCP tool. It says it isn't calibrated: past changes don't record their effort yet.

#### Does the code do what the design says? (ADR 0114)

- `atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]`: each repo's branch (the change branch, a task's branch, or `--ref`) is scanned at its commit and at its base, from a detached worktree of the base clone with the scan cache (nobody's working copy is touched), and checked against the change's target flows: every call a step adds is an Interface from the flow's component, every table, column and migration a step names exists, a new flow's endpoint exists, every call a step removes is gone; what the branch adds that no target flow names (a call, publish, endpoint, table or column) is out of scope. Every item cites its file and line in the new code, or the target-flow file and step for what is missing. No AI; planned (Spec Kit) records never count as code.
- Missing and still-there items are blocking findings, out-of-scope items risks, on a new built-in `conform` gate that holds back the Build hand-off like drift, hand-up and trace; a person dismisses one as not relevant, and the dismissal survives the next check. Each repo's newest result is kept at `conform/<repo>.yaml` in the change folder.
- `atticus task run` (and `atticus handoff done` for a task run) checks the task branch's commit against the task's steps when its build passes, and says what it found in the run's notes.
- `GET /api/changes/{id}/conformance` (API 2.11.0), the app's Code against design (More, Build; linked from the Tasks stage) with every item, its step, task, citation and finding state, and the read-only `change_conformance` MCP tool.
- Golden test on the Forge fixtures (`fixtures/conform`): forge-ledger after part of the transfer limit, with the hand-written result and findings.

#### Model runs, and what waits, in every surface

- The app: a Model runs screen (More, Run, `#/runs`) lists every model run, newest first, with a filter; one run shows its prompt beside its answer and, per earlier round, the problems the checks handed back with the answer that failed them, all as text. Every AI step the app shows as a command gets **Run with Copilot** in a VS Code tab, or **Run with <model>** in a browser when `runtime.yaml` configures one; otherwise it stays a command to copy. Each AI step's page links to its runs.
- The critic runs as an AI step (ADR 0106 addendum): `atticus critic <change> --handoff [--json]` offers its AI lenses one at a time, oldest first, each resume the next, and ends with the gate's verdict; so Run with Copilot, Run with the server's model, the VS Code runner and the IntelliJ console review a change. `atticus task run` stays a command (it edits code, in the assistant's agent mode).
- The app: a step run with the server's model links to the run it made (the job's result names it); Onboarding's survey step links to the surveys' runs.
- The app: Waiting on you lists what needs a person grouped by change (blocking first), then what belongs to no change; one filter box ("Filter: words to match") on Waiting on you, Questions (with a repo picker), Manual steps, the cross-change views and Knowledge items.
- A knowledge scan reads a big wiki in batches that fit the model: `atticus knowledge scan --batch-tokens <n>` reads only the changed pages that fit, keeps what it read, records only those pages as read, and says how many are left; the next scan carries on. The VS Code extension passes the model's room (its limit less 4,000 tokens for the instructions; GPT-4o mini on Copilot takes 12,078) and runs batch after batch until every page is read. Every page is still sent once; only the instructions repeat per batch.
- Model runs (ADR 0106): what Atticus asked a model, what it answered and what the checks handed back, kept under `.runs/` and now shown. `atticus runs [--change id] [--json]` and `atticus runs show <run> [--json]`; the local API's `GET /api/runs` (with the server's model, if any) and `GET /api/runs/{runId}/transcript`; and `POST /api/runs`, which starts an AI step on the server with `runtime.yaml`'s model, as a job, where one is configured (only the AI steps; never an argument that starts with `-`). API 2.8.0.
- `atticus waiting [--group change|kind] [--filter words] [--json]` (ADR 0105): what waits on a person across every change, grouped by change (blocking first) or by kind, with a filter.
- The Claude Code plugin's MCP server gains `waiting_on_you`, `open_needs`, `model_runs` and `model_run`; a session in a metarepo starts with how much waits on you.
- The IntelliJ plugin: **Waiting on You** and **Model Runs** actions (the toolbar and the Tools menu) open those app screens in its tool window, and a hand-off run in the console offers **Open the prompt**.
- The VS Code extension: Waiting on you grouped by change (or by kind), a filter on Waiting on you, Changes, Knowledge and Model runs, a Model runs section, Open the prompt and Open the answer on a step's ending, and Run with Copilot for the app in its tab; see its changelog.

#### One arrangement in the app and the plugin

- The app's menu follows a working day (ADR 0105): Dashboard, Waiting on you (was Command center), Changes, the phase screens, Knowledge. More is regrouped into Code, Knowledge, Org pack, Define, Design, Plan, Build, Release and Run. Questions is a section of Waiting on you and stays at `#/questions`. No route is removed or renamed.
- Needs across changes: `#/changes?across=needs` lists every open need of every open change, with Done, Not needed and Reopen as on a change's page. Waiting on you shows questions, open needs, manual steps and blocking findings, each with its count and a link.
- The Dashboard's slash commands card, and every line that named Copilot Chat, say the commands are in Copilot Chat (`atticus assistant-files`) and in Claude Code (the Atticus plugin, ADR 0104).
- The VS Code sidebar in the same order: Next, Waiting on you (was Questions), Changes, Knowledge, Repos, Catalog; see the extension's changelog.

#### Atticus for Claude Code

- A Claude Code plugin (ADR 0104), in this repository's marketplace: `/plugin marketplace add maycombhq/atticus`, then `/plugin install atticus@maycombhq`. Every step and catalog command as a slash command, the same files `atticus assistant-files` writes; a session in a metarepo starts with its next step; and the read-only `atticus` MCP server. `pnpm claude-plugin` writes `plugins/atticus` from the same commands, and a test fails when it is out of date.
- `atticus mcp`: read-only tools over MCP (stdio) for an assistant: the next step, catalog queries, explain and impact, knowledge items, changes and their status, needs and findings, open questions, features, triage and manual steps. Each runs the command's own code; a value can never be read as an option; nothing writes.

#### A pair of glasses

- Atticus's mark is Atticus Finch's glasses (`docs/brand/glasses.svg`): two fine round lenses and a straight bridge, with a small curved glint at the outer top of each lens, like an eyebrow. Where the logo stands alone it carries the name below (`docs/brand/atticus-lockup.svg`): the VS Code Marketplace icon and the IntelliJ plugin icon. The app's header keeps the name beside the glasses; the favicon, the VS Code activity bar and the IntelliJ tool window use the glasses alone.

#### Every screen says what is happening

- The browser app has a light theme. It follows your computer's light or dark setting by default; a Theme switch in the top bar (System, Light, Dark) is remembered in the browser. It uses the same colours as VS Code's light mode, and every screen passes WCAG 2.1 AA in both themes.
- Escape closes the Correct and Reject forms on Knowledge items, the Done and Not needed notes on a change's needs, and the artifact editor, and puts the keyboard back on the button that opened them.
- The app's words, screen names, menu groups, the tour and the Ask box among them, come from the copy file; a test fails when a screen has English typed straight into it.
- Verify, Correct, Reject, Keep, Done, Not needed and Reopen keep the keyboard on the item or need you acted on, and say "Working on it…" while they save.
- A need whose knowledge item was rejected says so; each need's buttons are named for the need; a reopened need is "open again".
- Opening a saved search keeps the search you typed; each Keep button names its candidate.
- An item link that no longer resolves says so; a never-synced source says "Not synced yet" rather than that its snapshot is too old; pages read `page.md (Heading)` on every screen.
- No screen scrolls sideways at 320 px; scrolling tables and code blocks take keyboard focus. The journeys add a keyboard run through knowledge review, a search's Keep and a change's needs (spec 16).
- A stopped server is said in words: one note at the top of the page names `atticus ui` and how to start it again (in a VS Code panel, Atticus: Open the app), with Try again; each panel only says it couldn't load. When the server answers again the screen loads afresh. No more "Failed to fetch", and a reply that isn't Atticus's says so with its status.
- A load that fails offers Try again. A screen that works on one change shows that the changes are loading, or why they didn't load, instead of a skeleton that waits forever (Feature brief, UX, reviews, mappings, Breakdown, Task board, Test trace).
- Every action button says it started ("Working on it…") and then what happened. The critic's outcome on a change's page no longer hides behind the hand-off's; each task's Run with AI keeps its own outcome.
- No silent clicks: an empty Ask, wiki search, impact search or sandbox folder says what to type; Check again (Reconcile, Settings) says "Checking…" and when it answered; searching the wikis for the same words searches again; the Architecture canvas no longer offers Open on the box it shows or a button for where you already are; Esc closes the tour.
- Disabled buttons say why: Not relevant and Waive need a reason, a rule that can't be waived says so, Check they answer says no tool is set up.
- The empty states say what to do next: a page that works on a change gives `atticus change new` to copy and the way to Changes; Knowledge items and Teams, vendors and products link to Knowledge sources and give `atticus knowledge scan` and `/atticus-knowledge` to copy; the Command center shows a dash, not a 0, for a count it couldn't read.
- The command line's "Re-run with --force" is said in the app's words: tick the box on the Service desk queue, or the command to run for stories.
- Links that leave the app (a hand-off PR, a request in the desk, a knowledge item's links) open beside it and say so to a screen reader; in a VS Code panel the editor opens them. The evidence pack, which a VS Code panel can't save as a file, is shown there to copy, with `atticus release evidence <change> --out <folder>`.
- The journeys' empty-state check covers all 41 screens, and the server-unreachable check covers seven, with axe on each; `ATTICUS_CHROMIUM` points the journeys at an installed Chromium.

#### Knowledge and needs in the app

- The app has it all (ADR 0102), under More, Know:
  - **Knowledge sources**: each wiki with its git ref, folder, checkout, tags, owner and newest snapshot (with its commit), Sync for each, the `sources add` form (saved into `sources.yaml`, comments kept), what the last scan changed and the reviews to check again. Reading a source with the AI is given as `atticus knowledge scan --source` and `/atticus-knowledge` to copy.
  - **Knowledge items**: grouped by kind and searchable, each with its fields, quote, page and links; Verify, Correct (only the fields its kind allows, lists as lists, links as label and address) and Reject (with the reason), as you.
  - **Search the wikis**: the plain page search runs at once; `/atticus-find` to copy for the AI step; the saved searches, new and known, with Keep as the kind you choose.
  - **Teams, vendors and products**: what each team owns and uses, who owns each product, and their other names.
  - **Org pack from the wikis**: the drafted systems, verified or not, Draft and Accept the picked ones.
- A change's page (Changes, Feature design, Stories, Tasks) shows what it needs from the organisation, grouped as `needs.md`, with lead time, who handles it, links, steps and why, the tick or "not yet verified", and Done, Not needed and Reopen; or `atticus change needs` / `/atticus-needs` to copy before it has run.
- The local API 2.7.0 (additive): `/api/knowledge/sources`, `/api/knowledge/scan`, `/api/knowledge/items`, `/api/knowledge/search`, `/api/knowledge/finds`, `/api/changes/{id}/needs` and `/api/orgpack/draft`.

#### Knowledge managed in the metarepo

- Wikis kept in git (ADR 0101): `type: git` in `sources.yaml`, an ADO or GitHub wiki or a docs repo, with `ref`, `path` and `checkout: clone` (into local state) or `submodule` (pinned under `knowledge/repos/`). `atticus sources sync` clones or updates it, dates each page by git and records the commit in the snapshot. `atticus sources add git <url> --save` writes the entry for you.
- People review what the knowledge scan read: `atticus knowledge verify|correct|reject <item>` writes `knowledge/reviews/<item>.yaml`. A correction (`--set catalogueItem=... --set steps="a|b"`) is what plans, answers and lists read from then on; a rejection leaves the item out of plans; `knowledge list` shows a tick, and "check again" when a rescan changed the item since.
- Rescans: `atticus knowledge scan` reads only the pages that changed since the last scan, keeps items' ids, and says what is new, changed and gone; `--full` reads every page.
- What a change needs (`atticus change needs <change>`, `/atticus-needs`): your assistant reads the change and the knowledge items and says which requests and processes to raise, standards to follow and teams to involve, for the change, a feature, flow, story or task, quoting the change's words; Atticus checks each. `needs.yaml` and `needs.md` carry each item's how-to, lead time and who handles it; `atticus needs`, `needs done|skip|reopen` record what a person did. The stories stage's suggested requests join the same list, and `atticus next` asks for it once a change is placed.
- Search the wikis: `atticus knowledge find "<term or phrase>"` (`/atticus-find`) finds the pages that mention it, has your assistant read just those and propose what isn't known yet, each quote checked; `atticus knowledge keep <item> [--as kind]` keeps one as an item you verified; `atticus knowledge finds` lists the searches.
- Links: knowledge items keep the links their page gives (a request's service-desk form, a runbook) in `urls`, checked on the page; a change's needs carry them to `needs.md`.
- `atticus setup` no longer ticks the org pack in a new metarepo: "The org pack's files are valid", then "The org pack has an owner", which waits for `pack.yaml`'s owner.
- The org pack drafted from the wikis: `atticus orgpack draft` proposes the profile's systems from the products and vendors the knowledge names, with their aliases and owners, each citing its item; `atticus orgpack accept <platform> [--only] [--verified-only]` puts them into `profile.yaml`. The scan reads aliases too.
- Unverified knowledge is used and marked: `needs.md` says which needs come from items no person has checked, a task's prompt includes the change's needs, and `atticus next` asks a person to check them (`atticus knowledge list --unverified`), syncs a wiki whose snapshot is over 14 days old, and asks for the org pack draft when the wikis name systems it lacks.
- Teams, vendors, products and projects: the knowledge scan reads them too, as `Party` records (with what a team owns and uses) and the new `Product` kind (C1, additive; API 2.6.0).

#### Everything from the VS Code plugin, guided

- Start or bring in (the + in the Next section): create a metarepo, use Atticus in a repo, a practice metarepo, add repos, onboard a repo, bring in another team's repo, accept it, add knowledge; always there, not only in an empty window (ADR 0100).
- The setup checklist (`atticus setup`) in Next until the catalog is accepted, each step a click to what fixes it.
- Onboard a repo: clone, scan settings, scan, check the scan, spec, its questions, in order, each with its state; pick one to run it and the list comes back updated.
- A next step with a part to fill in (`atticus repos discover <folder>`) opens the screen that asks for it, not a terminal with the placeholder in it.
- `atticus absorb accept <id>`: copy what a reviewed absorb proposal adopts into the org pack (or OpenSpec, or inputs/) and add its `sources.yaml` entry; `--replace`, `--dry-run`, `--json`. Nothing is committed.
- `atticus absorb` reads TypeSpec: each `.tsp` file becomes a reference with its namespace, operations and models, read, never compiled; the compiled OpenAPI is absorbed for intake.
- Fixed: the sections refreshed only after a run's notification was closed; a made metarepo's "open it" slipped into the bell; empty sections' rows did nothing; came-back questions looked the same; `scan review` got the scan's options as required ones and `scan` lost `--repos` in the command catalogue; a repo not cloned yet scanned as `spawn git ENOENT`. Extension 0.2.0.

#### An IntelliJ IDEA plugin

- `packages/intellij` holds a Kotlin plugin, built with Gradle against the IntelliJ IDEA on the machine (ADR 0099). Install the zip it writes with Settings → Plugins → Install Plugin from Disk….
- The Atticus tool window: it shows the app (`atticus ui`, on 127.0.0.1) in a metarepo. Without a metarepo it offers Create, Use Atticus in this project and a practice metarepo, and it says how to install `atticus` when the command line is missing.
- Atticus: Run a Command… lists every command by area, in plain words. The AI steps name their `/atticus-*` slash command for Copilot Chat, since IntelliJ's Copilot gives plugins no model. Shared writes run as a dry run first, and run for real only after Approve and run.
- Atticus: Next Step says the next step in plain words, with a way to do it.

#### The VS Code extension for a first-time user

- Fixed: clicking the app's menu in the Atticus tab did nothing (ADR 0098). The bundled page's `<base>` sent the links elsewhere, and VS Code's panel also cancels every `#…` link click; the app now follows its own links in a panel. Extension 0.1.1.
- In the Atticus tab the app follows VS Code's theme: light, dark and both high-contrast themes, with every colour a theme token and AA contrast in each. In the browser it looks as before.
- Start from nothing: with no metarepo open, the sidebar offers Open, Create (`atticus init`), Use Atticus in this repo (`atticus adopt`) and a practice metarepo. A missing command line or Copilot Chat is said, with how to fix it.
- A Get started walkthrough, from installing the command line to a first change.
- Add repos (the Repos section's +): found in a folder of clones or a Git host organisation, shown with their types, added when you say yes.
- Plain words: the next step says what it does, and Run a command leads with what each command does. The developers' own commands are hidden (`atticus.showDeveloperCommands`).
- A Questions section, by repo.
- Shortcut keys: Ctrl+Alt+Shift+A (run a command), N (next step), D (the app).
- `pnpm --filter atticus test:vscode` runs the extension's checks inside a real VS Code.

#### Ready for the Marketplace

- The VS Code extension has what a Marketplace listing needs:
  - a 256×256 PNG icon;
  - a dark gallery banner;
  - keywords, a homepage and an issues link;
  - its own CHANGELOG.md.
- `marketplace` and `marketplace:pre-release` scripts, with the steps in `packages/vscode/PUBLISHING.md`.
- The app's fonts are under the SIL Open Font License. It is now allowed for font packages only (decisions-pending item 19), and their licence text ships in the extension's THIRD-PARTY-LICENSES.txt.
- The Architecture outline says a gap every part shares once, on the part they are inside.

#### The diagrams inside VS Code, from the extension's own files

- The Atticus tab loads the app from the extension's own files (ADR 0097), with a strict policy. Its calls go through the extension to the local API, so nothing on 127.0.0.1 is framed. It works where framing a local page is blocked, and over SSH or in a container.
- What it shows: the Architecture canvas, flows, target flows and every other screen. A file change refreshes the open view. Going to another view keeps the person's arrangement.
- The layout worker starts from a same-origin copy of its script.
- `atticus.appIn: frame` keeps the framed page.

#### Every command in VS Code

- `atticus commands [--json]` (ADR 0096): every command as data. It records each command's arguments and what they refer to, its options, its area, and how it runs (with an assistant, as a shared write that needs approval, as a server, or locally). It is built from the help text, and a test fails if a command has no area.
- The VS Code extension offers all of them:
  - **Run a command…** and `@atticus /run` offer every command, each argument asked with a picker for its kind. A shared write shows its dry run and waits for your yes.
  - **Starting a change:** New change (the + button, or `@atticus /new`) asks for the type, opens the brief, then offers the feature stage.
  - **On a repo or a change:** "Run on this repo/change…" offers every command that takes it.
  - **New sidebar parts:** a change's Tasks, each with Run the task, and a Knowledge section with the sources and the items.
  - **Title bars** of the sections carry the everyday commands.
  - **Health:** an upgrade and machine check runs when the window opens.

#### A change's target flows, before and after, and loops and retries as frames

- The Flows screen draws a change's target flows (ADR 0095) as one sequence. Each step says Added, Changed (with what it did before) or Removed, and shows the delta's reason. Components and tables the change adds are lanes marked new. Pick the change in the Flows screen's Change list, or follow the link on the Architecture page or the Target flows item in the VS Code sidebar.
- `GET /api/changes/{id}/target-flows` and `.../target-flows/{flow}` (API 2.5.0) give the steps merged and marked.
- Flow schema version 2: a loop or retry names the steps it repeats in `repeats: { from, to }`. They may come before it (a retry of a save) or after it (a loop over the next steps). The screen draws them as a frame. Version-1 flows still read. Run `atticus upgrade` to rewrite them.
- `atticus spec check` asks every loop and retry for `repeats` (`template-requires`), and `atticus spec draft` tells the drafter to write it.

#### Cited lines in one call, record lenses, and acting on findings in VS Code

- `GET /api/cites?repo=&path=` (ADR 0094, API 2.4.0): each line of one file that a flow step or a catalog record cites. It uses an index the app builds at start-up and again when specs or the catalog change.
- The CodeLens uses it, one call per file. A line a record was read from says which records, and a click opens the record (`atticus.codeLens.records` turns these off).
- A finding in the sidebar has "Act on the finding": Apply the fix, I fixed it by hand, Not relevant, Waive it or Ask someone. It offers only what the critic allows and shows a patch before applying it.

#### The VS Code extension shows Atticus's data beside the code

- A sidebar with Next, Repos, Changes and Catalog (ADR 0093):
  - **Repos:** each repo's flows, down to every step. A step opens the code at the line it cites.
  - **Changes:** each change's files and findings; a click opens the file.
  - **Catalog:** each kind's records; a click opens the record's YAML or the code it was read from.
- CodeLens in the code: above each line a flow cites, which flow and step cite it and whether a check confirmed it; a click opens the flow beside the code with the step marked (`atticus.codeLens` turns them off).
- A status bar item with the open questions and the next step.
- The Flows screen marks and scrolls to `&step=N`.

#### Flows drawn as sequence diagrams

- The Flows screen (ADR 0092, under More → Know): a repo's spec flows, and the picked one drawn as a sequence of steps across lanes. The lanes are who starts it, the gateway, the component, and each component, table and topic it reaches. Each step shows its data, its file and line, and who confirmed it. A call another repo's flow answers links to that flow, and the error paths are listed with their citations.
- The specs API (API 2.3.0): `GET /api/specs`, `GET /api/specs/{repo}` and `GET /api/specs/{repo}/flows/{flowId}`, read from the spec folders and `specs/estate.yaml`.
- `@atticus /diagram <repo> <flow>` opens a flow in the VS Code tab; the Architecture details panel of a repo links to its flows.
- The Architecture canvas: a gap every part shares is said once, a fit never zooms below the size words can be read at, the tour stays closed inside an editor's tab, and a label in a primary button keeps its contrast.

#### A VS Code extension runs the AI steps with Copilot

- `packages/vscode` (ADR 0090): an `@atticus` chat participant and a side view. `@atticus /next` reads `atticus next`, sends each AI step's prompt to the Copilot model the person picked, writes the result file and runs the step's finishing command. Atticus's command line still does every check; the extension only carries prompts and files. It stops at a question for a person and says what it is.
- `atticus <step> --handoff --json` prints the prompt, the result file and the finishing commands as one JSON object, for the extension.
- The app in a VS Code tab (ADR 0091): Open the app shows the app, its diagrams included, beside the code; `@atticus /diagram <repo>` opens the Architecture canvas on that repo. `atticus ui --embed vscode` lets only a VS Code panel frame the app, and the API keeps every header. `#/architecture?node=<id>` opens the canvas on one node.
- Not built yet: IntelliJ and a Marketplace listing. The extension is installed from its `.vsix`.

#### Spec flows draw the steps a person draws

- `atticus spec draft` and `atticus spec check` (ADR 0089): a UI flow starts at the person's action (the form, the button; a page's route) and ends with what the screen does after the response. Two new findings say when it doesn't: `ui-start-not-action` and `ui-end-missing`, for action and page triggers only.
- A flow an entry point starts names who calls it and how the call arrives, in `trigger.caller` (the vendor or component, and the gateway or direct). When nothing in the code or config says, `atticus spec check` asks a person at once (`caller-unknown`), one question per component.
- Every validation layer is a step, and a transform step goes wherever data crosses types; `field-from-nowhere` now says to add the missing transform.
- A flow's `what`, `when` and `then` accept a bare number or true/false (`then: 404`), read as text, instead of costing a retry round.
- The UI words the critic reads by are in the spec template (`ui`), so an organisation with its own UI framework lists its own.
- A question another step already asked about the same repo (a cited line in common, or near-identical words) is reused, not asked again: the step is recorded on the question, reads its answer, and says so.

#### The change lifecycle as three stage loops

- `atticus change feature <change> [--from-figma f.json]` (ADR 0087): your assistant places the change against the estate from its brief, its existing stories or an exported Figma design: the features and flows it touches, picked by meaning from a compact index of the repo specs and the catalog, the new flows it needs, gaps and questions. Every id is checked; other changes in flight on the same flows or systems are found from their files. A design's screens, fields and actions are read from the export and mapped; a field with no backing is a gap.
- `atticus change architecture <change>`: the target flows, one flow delta per flow at `target-flows/<flow>.yaml` (steps added, changed or removed, with fields), checked against the specs and the catalog; the interface and data changes go into `design.md` and `data.md`.
- `atticus plan stories <change>` on a change with target flows: a story per flow and repo, a task per changed step with its fields, evidence and a prompt for Copilot or Claude Code, and `requests.md`: the change tasks and service requests the knowledge items call for, each citing its item and the step. A person raises them.
- Every stage loops: draft, the stage's checks and a critic round on every draft, findings back to the assistant, with no cap on model calls. A finding that comes back unchanged twice, or comes back after it was fixed, becomes a question and the loop stops. When nothing blocks, the command prints the stage's PR for a person to approve.
- The critic's round limit is a setting: `gates.yaml` version 2 makes a gate with no `maxAuthorRounds` unlimited. `atticus upgrade` migrates a version 1 file and keeps each gate's two rounds until a person removes the line.
- `/atticus-feature` and `/atticus-stories` drive the loops; `/atticus-architecture` is new. `--handoff` works on `change feature` and `change architecture`. `atticus next` and the app's Run next name them.
- `atticus bench design [--mode m]` scores a design reading against `bench/design/reference.yaml`: screens, fields, backing, actions and gaps.

#### Hosts asked, wrong families block joins, and lineage across a crossing

- `atticus scan` and `atticus estate join` ask which repo answers on each host the calls name that no repo lists under `hosts` (ADR 0088): one question per host, the repos that serve HTTP as options, and first the repo whose config sets the port (`server.port=9966`). Answering with `atticus questions answer` writes the host into that repo's `hosts` in `repos.manifest.yaml`.
- A manifest host can name a port (`localhost:9966`), so two services on one host are told apart. A host without a port still takes any port.
- `atticus spec check` finds a family that stands for other work (a read for a write, or a write for a read). `atticus estate join` won't join a call through such a family; the call-out is reported with the reason `family-mismatch`. A flow whose own trigger is the reached entry point always comes first.
- At a crossing, an object the caller sends (`owner`) is mapped to the fields the callee's entry takes. `atticus estate lineage` follows `firstName` from the UI's `owner` into the API, to its column.
- A write maps fields to columns with `data.from` and `data.to`. `atticus spec check` reports a written field no column takes (`write-unmapped`). The spec drafter is asked for every column a write writes, and how fields map to them.

#### Every step as a slash command in Copilot Chat, and `atticus next`

- `atticus assistant-files` writes eight more slash commands (ADR 0086), for Copilot (`.github/prompts/`) and Claude Code (`.claude/commands/`): `/atticus-survey`, `/atticus-verify`, `/atticus-spec`, `/atticus-answer`, `/atticus-knowledge`, `/atticus-feature`, `/atticus-stories` and `/atticus-next`. Copilot's own model does the AI work; the command has it run `atticus` for everything else. `/atticus-spec` loops until the spec check passes. Every command stops at a question for a person.
- `--handoff` on `scan survey`, `scan verify`, `spec draft`, `knowledge scan`, `change draft` and `plan stories` prints only the prompt file, the result file and the two commands that finish the step.
- `atticus handoff done` now finishes scan survey, scan verify, spec draft, knowledge scan and onboard runs. Before, it checked their answers as change files and failed them.
- `atticus next [--all] [--json]`: the next step, its command, its slash command and why, worked out from the metarepo's files.
- The app's Run next shows the new slash commands where they apply.

#### The estate pass: flows joined across repos

- `atticus estate join [--json]` (ADR 0085) matches every call-out in the metarepo's repo specs to the flow its target starts: through the catalog's Interface (and its gateway's base path), the Endpoint the step names, or method and path on the target component. A join needs a citation at both ends, checked in the clones. It writes `specs/estate.yaml`: each join and how it was matched, and each call-out not joined with why (no target, no flow, no citation).
- `atticus estate flow <flow-id> [--depth 5] [--json]` prints a flow followed across repos, the callee's steps inline at each call-out, with what is sent, taken and returned at each crossing. It stops at the depth limit and at a cycle.
- `atticus estate lineage <flow-id> <field> [--json]` follows a field from the step that sends it through transforms to the column a write stores it in, each step cited, or says where the chain breaks.
- `atticus spec check` finds a call-out's target through a base URL or context path (`/petclinic/api/owners` reaches `/api/owners`), the same rule the joins use.
- `atticus bench run --specs [--estate e]` also scans each estate's repos together in one metarepo, joins their specs, and scores the reference flows that cross repos and are reached end to end.

#### Repo specs made of flows

- A new C1 kind, `Flow` (ADR 0079), with its own schema version 1: a trigger, ordered steps (entry, lookup, read, write, call-out, publish, transform, validate, branch, log, respond, loop, retry) with the data at each step by field, the table and columns a step reads or writes, where a call-out goes, error paths, a family of near-identical triggers, and a citation and `confirmedBy` (check, AI pass or person) on every step. Flows live in the metarepo at `specs/<repo>/<id>.yaml` with a header in `specs/<repo>/spec.yaml`.
- A repo type can carry a spec template, `repo-types/<id>/spec-template.yaml` (C6): which triggers a repo of the type has and where the catalog lists them, what each step kind must record, and how flows group into families. A built-in default template is used otherwise.
- `atticus spec draft <repo>` has your assistant write one flow per trigger from the catalog, the template, the repo type's skills and the answered questions. Each flow is checked (schema, every cited line, every catalog id, call-out targets, writes) before it is written; what fails goes back. It asks a person what the code doesn't settle. Later runs draft only what changed or failed.
- `atticus spec check <repo> [--json]`: the deterministic critic. Every trigger has a flow, every cited line exists, a call-out's target and a write's table and columns are in the catalog, a field doesn't appear from nowhere, and a step's claim is on its cited line (which marks the step confirmed by the check). A finding that comes back unchanged after a redraft becomes a question.
- `atticus bench run --specs` also scores drafted specs against the bench's reference flows (`bench/flows/`): triggers covered, steps matched in order, tables and fields named, citations correct.

#### The app's six screens, and More

- The menu shows six screens that follow the work: Dashboard, Onboarding, Feature design, Architecture, Stories and Tasks. Every other page is under More, unchanged; nothing is removed. `#/` opens the Dashboard; the Command center is at `#/home`.
- Every one of the six shows "Run next": the command for its step with a copy button, and the slash command for Copilot Chat where `atticus assistant-files` writes one.
- Dashboard: repos listed, cloned, with scan settings and scanned; changes in flight and their stage; open questions; the slash commands that exist.
- Onboarding: the manifest file, each repo's clone, scan settings, last scan and the `atticus repo-type detect` command; the knowledge sources in `sources.yaml`; the steps in order (repos discover, workspace sync, scan survey, scan, answer, scan review).
- Feature design, Stories and Tasks: the change's files and the command for its stage; Tasks lists each task with `atticus task run` and `/atticus-task`.
- Local API (ADR 0084, 2.2.0): `GET /api/onboarding`, read from files only.

#### The scan's AI verify step

- `atticus scan verify <repo>` (ADR 0082) hands your assistant what the last scan recorded for the repo (entry points, calls, tables and deployments, each with its file and line), its folders and its scan settings. The assistant lists what the scan missed, what it has wrong and what it confirms, each with the line it read and a fix: a scan settings entry, a question for a person, or a change a reader must make.
- Atticus checks every item: the cited line exists and says what is quoted, a missed entry point, call or table is named on its line and isn't in the scan already, a wrong or confirmed record is in the catalog, a settings entry passes the scan settings' own checks, and a question's evidence exists. What fails is handed back; what still fails on the last attempt is left out and listed.
- Results go to `proposals/scan/<repo>.yaml` (settings entries to accept, merged across runs, and the confirmed records pinned to their lines), `questions/`, and `proposals/scan/<repo>.findings.md` (what a reader must read differently, in plain words). The catalog isn't changed. `atticus scan verify <repo> --accept` checks the settings entries again and merges them into `org-pack/scan/<repo>.yaml`.
- `atticus bench verify` runs it on the bench repos and keeps the proposals in the bench cache; `atticus bench run` then says how many of the flagged misses and wrong records the reference agrees with.

#### Knowledge sources tagged, snapshot, scanned and queryable

- Sources in `sources.yaml` carry tags (ADR 0083, C6): `tags: { kinds, frameworks }` beside the existing `owner`. `atticus sources tag <source> --kind k,k --framework f,f --owner o` writes them.
- `atticus sources sync [--source s]` also copies each source to a dated snapshot, `knowledge/snapshots/<source>/<date>/`. The knowledge scan reads only snapshots.
- `atticus knowledge scan [--source s] [--mode m]`: your assistant reads the snapshots, guided by the tags, into patterns, standards, processes, requests, decisions and constraints. Every quote is checked word for word on its page and under its heading; what fails is handed back. Conflicts between pages and superseded pages are flagged; text that tries to instruct AI tools is cut out, flagged and never followed. Items are written to `knowledge/items/`, flags to `knowledge/scan.yaml`.
- C1 (ADR 0083): a new `ProcessDefinition` kind; `Pattern` gains `patternKind` (pattern or standard), `rules` and the knowledge fields (applies-when, handled by, framework, tags, quote); `Decision` gains `decisionKind`, `stance` (mandated, banned, retiring), `dates` and the same fields. Existing files read unchanged.
- `atticus knowledge list [--tag t] [--kind k]` and `atticus knowledge ask "<question>"`: answers come from the items only and cite them; an answer with no valid cite is refused.
- `atticus bench knowledge [--mode m]` scans the bench's invented wiki, asks its eight questions and scores items, quotes, conflicts, the superseded page, the injection and the answers' citations against `bench/knowledge/reference.yaml`.

#### Repo types, matched by fingerprint

- A new org-pack folder, `repo-types/<id>/type.yaml` (ADR 0077, C6). It holds what a kind of repo looks like (build files, dependencies, framework markers and folders, each with a weight), the scan settings every repo of the kind gets (written as patterns), and the skills for reading it.
- `atticus repo-type detect <repo> [--json]` scores the repo against every type and cites the file or line behind each signal. It says whether the match is clear, partial, none or a tie.
- `atticus repo-type new <id> --from <repo>` drafts a type from a repo, with no AI, for a person to edit.
- `atticus scan survey` gives your assistant the matched type's settings (resolved on the repo and checked) and its skills.

#### The estate as one graph, opened a level at a time

- Local API (ADR 0081): `GET /api/graph/node/{id}` gives one node of the estate (estate, system, repo, component, endpoint, topic, client, store, table, deployment) with its children, its breadcrumbs and its edges, merged with a count and each with its evidence as `path:line` and its gaps; `?lens=` picks architecture, repo, data, integration or infrastructure; "uses" edges are the transitive reduction unless `?all=1`. `GET /api/graph/focus/{id}` gives a node and its neighbours. `GET` and `PUT /api/graph/layout/{view-key}` read and keep a view's arrangement in `diagrams/layouts/<view-key>.yaml` (C6, a new metarepo file).
- The app's new Architecture screen opens the estate through it: a lens switcher, breadcrumbs, the picture of the open node, an outline for the keyboard and screen readers (Tab, Enter to open, Escape to close), and a details panel with the evidence and the command for the next step. The picture is today's read-only canvas: dragging, zoom, the minimap and "keep this arrangement" come with the new canvas.
- `scoreLayout` and `LAYOUT_LIMITS` in `@maycombhq/diagrams` measure a laid-out view against the diagram spike's limits.

#### Client base URLs in scan settings

- Scan settings (`org-pack/scan/<repo>.yaml`) take `clients` (ADR 0076): a base URL in front of the HTTP calls in the files an entry covers, for calls built from a name the entry lists (`environment.REST_API_URL`) and for paths with no host (an interceptor puts the base in front). Each entry cites the line the base is written on; the scan refuses one whose line doesn't say it, whose base isn't that value, or whose names aren't in its files. A resolved call cites both its own line and the base's.
- The frontend reader now records calls built from a configured base, with the base's expression: `GET ${environment.REST_API_URL}owners/{id}`, following class fields such as `this.entityUrl`; Angular `HttpClient` calls with type arguments (`this.http.get<T>(...)`); requests through an axios instance the repo makes (`api.get("/comments")` with `api = axios.create({ baseURL })`), also when imported by an alias such as `@/lib/api-client`; and `"/profiles/" + name` as `/profiles/{name}` (before, only `/profiles/`). msw mock handlers are no longer read as calls.
- `atticus scan survey` asks your assistant for client bases too, shows it the calls whose base the readers couldn't know, and checks its answer.
- Without settings, such calls are recorded but don't join anything; on the bench that shows as wrong calls until the repo is surveyed.

#### Scanner plugins, pinned and sandboxed

- When a rule file can't say how to read an organisation's code, a scanner plugin can (ADR 0080): `org-pack/plugins/<id>/` holds `plugin.yaml` (what it emits, the repo types or dialects it applies to, its time and memory limits, the sha256 of its entry file), the plain JavaScript code, and golden tests in `test/<case>/`.
- The scan uses a plugin only when its code matches the pin and its tests pass, and runs it after the built-ins, in a worker thread with its own limits. It reads files only through the scan, and can't import anything, use Node, reach the network, start a process, compile code from strings, or read the clock. A plugin that tries, runs too long or uses too much memory is stopped and reported as a scan problem; the scan goes on.
- `atticus plugin test <id>` runs a plugin against its golden files; `atticus plugin pin <id>` writes its entry file's sha256 into `plugin.yaml`.
- Node's `vm` is not a hard security boundary; ADR 0080 lists what is enforced and what an OS-level boundary would add.

#### You are your Git user; approving is the pull request

- Atticus knows you by the metarepo's Git user (`git config user.name` and `user.email`, ADR 0073). The app shows it in the top bar and every command records it; `--by <handle>` is now an optional override everywhere it was required (`change new`, `change handoff`, `finding`, `baseline`, `todo done`, `task run`, `glossary`, `initiative`, `outcome record` and the rest), and `digest --as` likewise. With no Git user, the OS user name stands in with a warning that says how to set it.
- No roles in the app: one sidebar and one Home for everyone, one tour. The view picker, role homes, role navigation and tours, and Settings' group-to-role mapping are gone, and so is "Groups are mapped to roles" in the setup checklist. `.atticus/me.yaml` keeps only your digest settings.
- No in-app approvals: a gate is approved when its hand-off PR merges, and the Git host's rules decide who may approve. `atticus change status` names the PR to merge instead of "Approvals needed"; `change handoff`, `change sync` and `change return` are a dry run until you add `--approve`. Approve buttons, "approvals waiting on you" and the role checks on waivers and on accepting the baseline are gone; a waiver, the baseline and release go / no-go are files recorded with your name that reach main through a pull request, and each command says so.
- Every write to the Git host, work tracker, service desk or notifications still needs your explicit `--approve` (or a button that says what it sends).
- Local API 2.0.0: `PUT /api/me` and `GET /api/me/approvals` are removed; `GET /api/me` returns your Git user (`user`, `name`, `email`, `source`, `warning`).
- `roles.yaml` is deprecated (C6): it still loads and validates, nothing reads it, and `atticus init` no longer writes it; nor are gate `approvers`, change-type `approvals` or the change policy's `privacy.role`, `risk.approvals` and `selfApproval` read. Move those rules to branch protection and CODEOWNERS.

#### Scan review

- `atticus scan review <repo>` (ADR 0072): the gaps the last scan left (files no rule reads, unresolved calls and data access, modules where it found nothing) go to your assistant, which gives each a verdict (a rule can read it, an Atticus reader misreads it, a vendor, ignore, or a person must say) and writes a dialect for the readable ones. Every verdict and the dialect are checked against the repo before anything is written; a person accepts the dialect and the next scan reads with it. `--gaps` lists the gaps alone.
- The SQL reader no longer takes `IS DISTINCT FROM`, a CTE's name or `information_schema` tables as tables (found by the first scan review).

#### Domain profiles from the catalog

- `atticus domain profile <system> [--out file]` (ADR 0071): a system's domain profile filled from the catalog: components and repos, interfaces with their consumers, data with who reads and writes it, related domains, features, and an evidence register of every claim. What code can't tell (owners, controls, retention) is Unknown and asked as an open question. An organisation's own layout goes in `org-pack/templates/domain-profile.md`.
- ASP.NET Core actions named `GetUserAsync` route as `getuser`, as ASP.NET Core does by default.

#### Draft a change from its brief and the map

- `atticus change draft <change>` (ADR 0070): your assistant drafts the OpenSpec proposal, spec delta and interfaces from the brief and the part of the catalog the change is about, picked without AI. Atticus checks the draft (every system, call and interface is in the catalog or marked new, every requirement has a scenario) and sends problems back before anything is written.
- `atticus plan stories --draft` writes draft stories before the design is approved.
- In the app, calls inside one box are counted on it instead of drawn as a loop, and every graph draws on the layered canvas.

#### A repo's own HTTP helpers are followed

- The frontend reader follows the helpers a repo writes around fetch and axios (ADR 0069): `post("reports")` through `post(path)` → `http(\`/api/${path}\`, { method: "POST" })`→`fetch(BASE + path)`reads as`POST /api/reports`, verified from code, across files through relative imports. An app with its own thin client now gives its calls, so its API's endpoints are entry points and features are found.
- Each module's component takes its type from its own build file: a React module in a Maven repo is `frontend`.
- The command center's system map draws the estate's context view, or the one system's components and links, on the same canvas as Diagrams.

#### Diagrams draw the view; modules show what they build on

- The Diagrams screen draws the chosen view itself (ADR 0068): Data shows each component's reads and writes to the tables inside their store, Container a system's components and their links, with a layered layout where no label sits on another. Pointing at a box lights its edges. `GET /api/diagram/{view}/graph` and `atticus diagram render <view> --format json` give a view's groups, nodes and edges.
- `Component.uses` (C1, optional): the modules of the same repo a module's pom or package.json depends on. The container view draws them as `uses` edges.
- A JPQL `@Query` is read against the entity's table (`@Table`, `@Entity(name)`, else Spring's naming), not the entity's name; a PostgreSQL or MySQL upsert and `SELECT ... FOR UPDATE` no longer give a table called `set` or similar.

#### Discover: a clone's subfolders are its modules

- `atticus repos discover <folder>` on a folder that is itself a Git clone proposes one repo, with each subfolder that builds (a pom, a package.json, a pyproject and so on) as a module with its own component (ADR 0057). A clone inside it stays a repo of its own. A folder of clones is read as before. Discover now writes `modules` into the manifest.

#### Shared parse cache

- Each file is read and parsed once per repo scan and shared by every reader (ADR 0067): built-in extractors, dialects and their rules, the Helm and Kustomize builders, Terraform and the framework survey. Tree-sitter trees, JavaFiles, SourceFiles, YAML documents, flattened configuration, HCL, XML and Groovy calls are cached, keyed by path and content. Values are frozen, so a reader that changed one fails instead of changing another's; the cache is bounded (8M characters of plain values, 1M of syntax trees, 16M of file text, least recently used first out) and frees every tree when the repo's scan ends, on error too. The SDK's `RepoHandle` gains an optional `parseCache` (`createParseCache`, `withParseCache`); handles without one work as before. Records are byte-for-byte unchanged. On the M1 exit estate parses per file went from 2.9 to 1 and the first scan of 300 repos from 59 to 90 s to 32 to 41 s.
- Tree-sitter grammars run as baseline WebAssembly code: V8 compiling them to optimised code took up to 2.2 GB of transient memory per process and killed test workers under load ("Fatal process out of memory: Zone", exit 0x80000003). The `frameworks-cli` test worker now peaks at 184 MB instead of 2.6 GB.

#### Onboarding framework models

- `atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]` (ADR 0066): the learner reads the house framework first, then your organisation's assistant drafts only what it couldn't (base URLs of service ids, wrapper methods whose parameters don't name the method or path, what pipeline templates and Jenkins shared-library steps do), with the framework kit as instructions and the code as data. Checks decide: valid C6, every entry with a source, nothing read from code changed by the draft, drafted entries citing a document or a person, its tests pass, and the repos that use it give something with it they don't without it and no invalid record. Failures go back to the next attempt (`--attempts`, default 3). A passing model is a proposal in `proposals/frameworks/`, listing what it reads per repo, which records came from drafted entries, and entries that change nothing. With AI off or `--no-ai`, the learned model alone is checked.
- `atticus onboard check framework <name>` runs the same checks on a hand-written or handed-off model (with `--from`, the learner's entries are confirmed and merged in); `atticus onboard accept framework <name> [--replace]` (or `onboard accept <name>`) moves it into the org pack.
- `atticus scan` names house frameworks several repos import that no model covers, with the command to onboard each (`unmodelled` in `--json`), and models that read nothing any more in repos that import them (`coverage[].redraftFrameworks`), with the re-draft command.
- `atticus onboard eval` grades framework cases too (`kind: framework` in `case.yaml`): the first, `harbor-kit`, an invented Java starter and two repos using it; the eval runs 11 cases.
- `frameworks survey` and the scan share one import reader (moved to `@maycombhq/extractors`); the survey's output is unchanged.

#### Model providers

- Model mode can call a real model (ADR 0065). A new package, `@maycombhq/model-providers`, ships three providers the CLI registers when it starts: `anthropic` (Messages API, directly or through a gateway), `openai-compatible` (Chat Completions, for internal LLM gateways, vLLM and similar; `flavour: azure` for Azure OpenAI deployments with `api-key` and `api-version`, also as `type: azure-openai`) and `bedrock` (the Converse API, SigV4 signed with `node:crypto` from the standard AWS environment variables; no AWS SDK).
- Keys stay out of `runtime.yaml`: `keyEnv` names the environment variable that holds the key, a setting that looks like a key or token is refused, and messages, run records and inspected objects never show a key. `baseUrl` must be `https://` except on this machine.
- Corporate networks: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (with proxy credentials in the URL, never printed), `NODE_EXTRA_CA_CERTS` and a `caFile` setting. Timeouts (`timeoutMs`), cancellation, and bounded retries with backoff on 429 and 5xx that honour `Retry-After` up to 60 seconds. Each failure says what to check: the key variable on 401, the model or deployment on 404, the proxy on 407, the CA on an untrusted certificate.
- Usage comes from the response's token counts. An answer cut off at the output limit or declined by the provider fails the run rather than being used.
- Contracts, additive: C5 `registerModelProvider` (an organisation's own provider registers the same way), C6 `adapters.model.type: openai-compatible`. `models.allowed`, `modes.allowed`, `ai: off` and text-only work as before.
- New dependency: undici (MIT), for the proxy. Not built: streaming, Vertex AI, AWS profiles and SSO, Azure managed identity, images and tools. No provider has been called against a real endpoint from this repo; tests use an injected transport or servers on 127.0.0.1.

#### Helm and Kustomize

- Helm charts are read without running Helm (ADR 0064): each chart once per environment values file (`values-<env>.yaml`, `values.<env>.yaml`, `values/<env>.yaml`, `environments/<env>/values.yaml` and the like) layered over `values.yaml`, with local subcharts (`charts/<name>`, `file://`, `alias`, `condition`, `tags`, globals). Templates go through a small Go-template reader (a tokenizer and parser for `{{ }}` actions, not text patterns) that evaluates `.Values`, `.Chart`, `.Release.Name`, variables, `if`/`else`, `with`, `range`, `include` of the `helm create` helpers and the common functions (`default`, `quote`, `toYaml`, `nindent`, `printf`, `trunc`, `trimSuffix`, ...). Anything else (`tpl`, `lookup`, `.Files`, `.Capabilities`, `.Release.Namespace`, unknown functions) is left unknown: the field is dropped, never guessed, and a template whose condition depends on one is skipped with a warning naming its line. The release is taken to be named after the chart. Dependencies that aren't in the repo are reported, not fetched.
- Kustomize overlays are built without running kustomize: resources, bases and components, strategic-merge and JSON 6902 patches, namespace, namePrefix/nameSuffix (references to renamed objects follow), commonLabels and labels, commonAnnotations, images, replicas and `configMapGenerator` literals. Remote bases are never fetched and fields not read (`replacements`, `vars`, `helmCharts`, ...) are reported.
- The openshift (0.3.0) and ingress (0.2.0) extractors read the built objects: Deployments, Ingress hosts, HPAs and NetworkPolicies per environment, with evidence at the template or resource line and at the values file, kustomization entry or patch behind it. A workload from a chart or overlay also gives `image` and `env.<NAME>` settings per environment (ConfigMap values filled in, secrets as `secret:<name>/<key>` references).
- Behaviour change: in a repo with kustomizations, base objects come out once per overlay rather than once under no environment, and overlay patch files are no longer read as objects of their own. Other manifest readers and repos without charts or kustomizations read as before.

#### Cloud resources and Terraform modules

- Shipped dialects `terraform-aws`, `terraform-azure` and `terraform-gcp` (ADR 0063) read cloud resources from Terraform in every repo with a `.tf` file: SNS topics, EventBridge buses, Kafka topics, Service Bus topics and event hubs as event topics; Service Bus and Cloud Tasks queues, DynamoDB, Cosmos DB, MSK, Redis caches and Spanner as data stores; Lambda and Azure function apps as function components with a deployment; ECS services and App Service web apps as deployments; API Gateway v2 routes, first-level v1 resources and API Management APIs as gateway routes. An org-pack dialect of the same name replaces one.
- Terraform databases (Cloud SQL, RDS instances and clusters, Azure PostgreSQL and SQL servers) moved from the infra extractor's regular expression into those dialects: the same records, now with names and engines resolved from variables, and blocks read by the HCL parser. Azure PostgreSQL single servers and MySQL flexible servers are read too. The infra extractor no longer reads `.tf` files.
- Local Terraform modules are followed: a `module` block whose source is a folder of the repo makes an instance of that folder with the caller's values, so each instantiation's resources give their own records, nested modules included. A module folder that is called is no longer read on its own with its defaults, and a resource in it whose name the caller doesn't give is skipped rather than named after its label. Remote modules stay module blocks a dialect matches.
- Dialect templates: filters `before('x')` and `after('x')`; in `hclBlock` matches an object attribute's fields are dotted (`${attr.tags.env}`) and a reference to another resource is `${attr.<name>.ref}`, for lookups.
- `atticus onboard`'s survey counts what the shipped cloud dialects read as read.
- Not read yet: Lambda triggers, API Gateway integrations, EventBridge rules, module outputs, `count` and `for_each`; clusters (EKS, AKS, GKE) give no record.

#### Pipelines from any CI/CD tool, and what org templates do

- Shipped dialects for Harness pipelines, Tekton Pipelines and Argo CD Applications (ADR 0062): a Harness or Tekton pipeline is a pipeline QualityAsset with stages, environments, deploy targets, test steps and templates, like the built-in readers write; an Argo CD Application is a GitOps Deployment.
- Framework models can have `pipeline` entries: what a template (`uses: org.tide_release`, `deploy.yml@templates`, a GitHub action) or a Jenkins shared-library step (`step: deployToProd`, `environmentFrom: env`) adds. Every pipeline that uses one gains it after the scan, and `details.modelled` says which model said so and where that came from.
- Dialects: `appliesTo.repoTypes: ["*"]` (any repo, gated by the marker); a `map('a=b')` filter; `where` on collected list items; `jsonPath` reads every document of a multi-document YAML file; `contains` on any match skips files without the given text before parsing them.
- Three onboarding eval cases (Harness, Tekton, Argo CD); `atticus onboard eval` runs 10.

#### Dialect fields: nested objects, collected lists, the component

- A dialect field may be an object, nested up to three levels, and a list item may collect one value per node under the match: `{ each: "@.stages[*].stage", value: "${item.name}" }` (ADR 0061). `${repo.component}` is the component the matched file belongs to. A pipeline from any CI/CD tool can now be described as rules the way the built-in readers describe one.

#### Rules read syntax trees, not text patterns

- Java and Kotlin are read from their syntax trees (ADR 0060): one reader for the Spring extractor, dialects, the framework learner, batch, GraphQL and realtime. It gives what the hand-written lexer gave on every fixture file, and more: Kotlin `object` declarations, interface methods without a body, constants declared in companion objects. Calls are listed in source order, so a WebClient chain still reads its verb.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree.
- The ORM and vocabulary readers read code from syntax trees too, through one call layer (callee, receiver, positional and named arguments, string values) for Java, Kotlin, TypeScript/JavaScript, Python, Go, C# and Scala: JPA entities (every field, nested annotations such as `@Table(indexes = @Index(...))`; the Java tokeniser is gone), EF Core (attributes, DbSets, `Entity<T>()` and `ToTable` chains) and SQLAlchemy models, and the code side of the GraphQL, gRPC, realtime, webhooks, serverless, apps, data-pipeline and ML readers. Code in a string or a docstring is no longer read as code, and a declaration or attribute can span lines. Datadog resources in Terraform go through the HCL parser. Swift, Dart, .proto, GraphQL SDL, Prisma and SQL have no grammar here and keep their own readers.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree. The JPA reader still tokenises, until it moves too.
- The generic-tier call layer reads syntax trees too (ADR 0060): the .NET, Python, Go and Node extractors and house frameworks get their tokens, calls, arguments, assignments and imports from the C#, Python, Go and TypeScript/TSX/JavaScript trees, and the hand-written lexer is gone (`SourceFile.parse` replaces `new SourceFile` and `lexSource`). Every fixture gives the same records. What a file imports is read from its import statements, not searched for in its text; the frontend extractor reads calls from the tree (Vue `<script>` blocks too), so a `fetch("/x")` in a comment or a string is no longer a call; method declarations, `raise X(...)` and `for rows.Next()` are told apart correctly; typed declarations (`x: str = "a"`, `var x string = "a"`) assign `x`; generic arguments (`Message<string, string>`) no longer split an argument.
- A `syntax` match (ADR 0060): a tree-sitter query over the file's syntax tree, for Java, Kotlin, TypeScript, TSX, JavaScript, C#, Python, Go, Scala, Ruby, PHP and Rust. Captures are `${capture.<name>}` (string literals unquoted) in templates, `where` and `lookups`, so a lookup over the tree can be the repo's constants. A call in a comment or a string isn't a call. The grammars ship with Atticus (web-tree-sitter 0.22.6, tree-sitter-wasms 0.1.13); nothing is downloaded or compiled.
- The framework learners read trees too: `atticus frameworks learn` takes a Java starter's `@AliasFor` members, constants and public methods' parameters from the Java tree, and a JS or TS framework's (or a package's `.d.ts`) exports from the TypeScript, TSX or JavaScript tree, so commented-out code and code in strings teach nothing. House dependencies read poms through the XML reader (a commented-out dependency isn't one) and `build.gradle.kts` through the Kotlin tree, including `group =, name =, version =` arguments. Groovy `build.gradle` and Jenkinsfiles are still read as text until a Groovy grammar ships.
- `atticus dialect tree <file>` prints a file's syntax tree, with the node names a query uses.
- Groovy (`.groovy`, `.gradle`, `Jenkinsfile`) is a syntax language too: its prebuilt grammar is vendored with its licence. Jenkins pipelines (stages, triggers, steps, test and coverage reports) and Groovy `build.gradle` coordinates are read from the Groovy tree, so commented-out stages and dependencies are no longer read.
- `atticus onboard` gives the assistant the syntax trees of sample code files, and refuses a draft with a `regex` match. `regex` is deprecated in hand-written dialects.
- The dialect kit's reference documents `syntax`, and a worked example reads a house client in Java, Kotlin and TypeScript.

#### Onboarding: your assistant drafts the dialect

- `atticus onboard <repo>` (ADR 0059): a deterministic survey of the repo (what is read already, the structured files nothing reads), a draft dialect from the organisation's assistant through the AI runtime (the dialect kit as instructions, the repo as data), and checks: valid C2, its own tests pass and exercise every rule, it reads records from the repo and none is invalid. What failed goes back to the next attempt (`--attempts`, default 3). A passing draft is a proposal in `proposals/dialects/`; `atticus onboard accept <name>` (a person) moves it into the org pack. `atticus onboard check <name> --repo <repo>` checks a hand-written or handed-off draft the same way.
- `atticus scan` names the repos it read nothing from though they have structured files no reader knows, with the command to onboard them.
- It also names rules that need re-drafting: a dialect a repo's manifest entry names whose tests now fail (the scan leaves it out), or that reads nothing in that repo any more (a framework upgrade, a renamed file). `atticus onboard <repo> --name <dialect>` re-drafts it; `onboard accept <dialect> --replace` takes the new draft. Coverage (`--json`) lists them per repo. Coverage (`--json`) lists each repo's unread structured files.
- The dialect kit ships the three gateway dialects as worked examples.
- `atticus onboard eval <dir>` scores the assistant's drafts: for each case (a repo and a reference dialect a person wrote) it compares what the draft reads from the repo with what the reference reads, by content, and reports precision and recall. `fixtures/onboard-eval` has seven invented ecosystems: Apigee with target servers, Kong, Azure APIM, AWS API Gateway, a house edge gateway, a house HTTP client in three languages, and house Terraform topics. CI runs it with a stand-in that answers with the references; run it with `--mode model` where your model is.
- Dialect templates read nested fields of structured files with dots: `${attr.forward.service}`, `${node.up.match.prefix}`; a match's ancestors include the document's top-level fields.

#### Dialect rules v3: any gateway, read through rules

- Dialects take `lookups` (ADR 0058): tables built from other files of the repo, read with `${lookup:<table>(<key>).<value>}`, the key any template value with filters. A key with no row, or with rows that disagree, leaves the value unknown.
- `${node.key}`, `${node.up.<field>}` and `${node.up.up...}` read the structure around a `jsonPath`, `xpath` or `hclBlock` match: a route's service, an element's parent. New filters `parent` and `basename`. A rule's `emit` may be a list.
- `fixtures/gateways`: an invented estate whose calls go through three gateway products, each read only through an org-pack dialect: Apigee with target servers per environment, Kong's declarative config (nested services, several paths per route), Azure API Management's APIOps folders. Every call joins end to end, caller to gateway route to service, verified at both ends. The three dialects are the reference an assistant's draft is graded against.
- Fixed: the dialect kit's reference had a block of itself pasted into the `where` section since rules v2.

#### Harbor gaps closed

- Calls to a vendor join the vendor's system: a host label that is a vendor system's id, name or alias from the profile, without spaces or dashes (`api.tidewater.example` → Tidewater Payments, `api.lanternmail.example` → Lantern Mail), when exactly one vendor matches. It is checked before a host's first label, after declared hosts. Harbor's three vendor interfaces, and the h01 and h09 findings from a scanned catalog, now pass.
- golang-migrate files are read: `<version>_<name>.up.sql` gives the version, in numeric order, and the `.down.sql` files that undo them are skipped.
- A vendor's OpenAPI 3.1 `webhooks` are read: each is a `webhook-send` loose end, joined to the one webhook endpoint whose path names the vendor (`/webhooks/tidewater`), via webhook.
- Profile systems take `tags`, copied to the System record (`saas` marks a SaaS vendor, ADR 0040).
- Feature detection starts flows at GraphQL operations, webhooks, websockets and server-sent events too, not only REST, gRPC and SOAP.
- Reconcile matches a diagram edge drawn as `POST /pkg.Service/Method` to the gRPC interface.
- Intake reads Mermaid files as diagrams and links the systems their boxes name, and takes Jira REST search exports and Azure DevOps work-item batches as ticket exports, not payload samples.
- The unattended-workload check covers data pipelines and anything started by a schedule.
- Every Harbor test runs: none is skipped, and every expected record has a producer.

#### One component per deployable module

- A repo that builds several deployables has a component for each (ADR 0057). `repos.manifest.yaml` may list a repo's `modules` (folder, component, hosts); without them, a multi-module Maven or Gradle repo with two or more `@SpringBootApplication` modules gets one component per app, named by its `spring.application.name`, else its folder. Endpoints, calls and loose ends belong to the module their file is in (Spring, house frameworks, the .NET, Node, Python and Go backends, OpenAPI files); a module's hosts join calls to it; calls between a repo's own apps are interfaces. The repo's own component stays, for what is outside every module.
- Extractors see the modules as `ScanContext.modules` (C4, an addition).
- The messy estate gains a multi-module repo: an API, a nightly job that calls it, and a shared library.

#### Dialect rules v2: infra repos, conditions, honest rules

- Dialects read Terraform (ADR 0056): an `hclBlock` match (`module`, `resource.aws_sqs_queue`) supplies each block's attributes, resolved from the folder's variable defaults, `terraform.tfvars`, `*.auto.tfvars` and locals, and its labels. With YAML and JSON (`jsonPath`) and XML (`xpath`) matches, infra and pipeline repos built on house modules, charts and templates are read through dialects.
- Rules take `where` conditions: `{ value: "${attr.source}", matches: "tide-kafka-topic" }`. All must hold for a match to emit.
- A record a rule can't complete (a field C1 requires couldn't be filled) is skipped with a warning naming the rule and the field, instead of being emitted invalid.
- `receiverType` is applied: a `methodCall` rule with it matches only calls on a field, parameter or variable declared with that type, or a static call on the type. Before, it was accepted and ignored.
- A dialect's tests must exercise every one of its rules; a rule that produces nothing in any test fails `atticus dialect test`, and a scan doesn't use the dialect. Shipped dialects gain the tests they lacked (Micronaut `@Put` and `@Patch`, Quarkus outgoing channel topics).
- The messy estate gains an infra repo whose topics come from a house Terraform module, read through an org-pack dialect.
- The dialect kit's reference, README and checklist cover all of it.

#### House frameworks in any language

- `atticus frameworks learn <name> --from <dir|package.tgz>` learns a JavaScript or TypeScript framework: from its source, or from its published npm package alone (its typings, else its JavaScript; nothing is run or installed). Exported functions and the methods of exported clients and routers become calls and routes, by their parameter names, positional or object properties; exported string constants are kept. Learned entries replace hand-written ones and make verified facts; a model's tests and a person's services are kept. `frameworks discover --group @scope` finds house npm packages in package.json files and looks for them offline (`--jars` folders of .tgz files, installed node_modules). The messy estate's Lantern source and package are fixtures; learned, the BFF's routes are verified.
- A bounded reader for gzipped tar archives (npm packages) joins the ZIP reader in core.
- `atticus frameworks survey [--package <prefixes>]` shows how the estate's repos use house frameworks in any language: each house module they import, the model that covers it, and how each imported name is called or annotated (`useApi(...)`, `lantern.call(...)`, `@InternalApi`, `BankHttp.exchange(...)`), with counts and a sample line. `atticus frameworks kit [dir]` exports the framework-model kit for an organisation's assistant: a guide, two worked examples, the schema, a checklist and a task prompt. New guide page: [Teaching Atticus your house frameworks](docs/guide/frameworks.md).
- Framework models carry their own tests (ADR 0055): sample files and the records they must give (`http-call POST https://…`, `endpoint GET /x/{id}`). A scan uses a model only while its tests pass and every entry a person or document wrote is exercised; otherwise the model is left out with a problem saying why. `atticus frameworks check [name]` runs them. `frameworks learn` keeps a model's tests. The messy estate's two models ship tests (Java and TypeScript examples).
- Framework models describe calls and routes in any language (ADR 0055): `calls` (a function, its receiver, the module it comes from, which argument or object property holds the method, service and path; HTTP, events or queues) and `routes` (calls that register a served route). A new built-in extractor applies them to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, in files that import the framework, filling names from the repo's own exported constants and the model's service ids. Service ids may be plain (`payments`) and packages may be npm modules (`@tide/lantern`).
- The messy estate gains Lantern, an invented React SPA and Node BFF framework: the SPA's `useApi({ service, path, method })` and `lantern.call(...)` calls reach the BFF through its declared host, the BFF's `defineRoute` and `router.route` registrations are endpoints, and the chain continues from the TypeScript BFF to the Java service's house controller.

#### House frameworks, read through framework models

- `org-pack/frameworks/<name>.yaml` (ADR 0054): what a house framework means, in terms the scanner already reads. Its annotations stand for Spring's (`@InternalApi` → `@RestController` + `@RequestMapping`, `@Op(verb, path)` → `@RequestMapping`), its wrapper client is an HTTP call (`bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")`), and its service ids and constants have values. Every entry says where it was learned (code, bytecode, a document or a person); only code and bytecode make verified facts. `atticus orgpack validate` checks the files.
- `atticus frameworks learn <name> --from <repo>` learns a model from a house starter's source: its `@interface` declarations (what each is meta-annotated with, house-on-house too, and `@AliasFor` as the attribute mapping), the public methods of its HTTP wrapper (service, method and path by parameter name), and its `static final` constants. Learned entries replace hand-written ones of the same name; what a person added (service URLs) is kept. What code can't say is printed as a note.
- `atticus frameworks learn <name> --from <starter.jar>` learns the same model from a compiled starter, for teams that have only its JAR: a small, bounds-checked class-file reader takes the annotation types (meta-annotations, `@AliasFor`), the wrapper's public methods with their parameter names (kept by `-parameters` builds, or the debug variable table) and `static final` constants, and the coordinates from `META-INF/maven/.../pom.properties`. Every entry's source is `bytecode`, naming the class inside the JAR and the JAR's sha-256. Nothing in the JAR is run.
- `atticus frameworks discover --group <prefix>` finds the house artifacts the estate builds on: it reads every repo's Maven poms (all modules, `${property}` versions) and Gradle builds, says which repos use which version, and looks for each JAR on this machine (`--jars` folders, then the Maven and Gradle caches). A JAR that isn't here is named, never downloaded. `--learn` learns each JAR it found.
- The safe ZIP reader moved to core (one reader for documents and JARs); ingestors re-exports it.
- Liquibase changelogs are read: formatted SQL (`--changeset author:id`), XML and YAML change sets (`createTable`, `addColumn`, `dropColumn`, `renameColumn`, `renameTable`, `createIndex`, `dropIndex`, `dropTable`, `addPrimaryKey`, `sql`), in the master changelog's include order. Each change set is a `liquibase` Migration, and the tables, columns and indexes are the same as the same changes written for Flyway. Flyway files in folders under `db/migration` are read too.
- Merge grows linearly with the estate: 1,600 components (about 100,000 records) merge in about 2 seconds, where 400 took over 5 and 800 about 20. Endpoints, tables and stores are looked up through indexes instead of scanned once per loose end; results are unchanged.
- Configuration is read the way Spring reads it: every YAML document (one with `spring.config.activate.on-profile` belongs to that profile), base config first, then production's values (`prod`, `production`, `prd`, `live`) for keys only profiles set, then the other profiles'. Before, `application-dev.yml` won over `application-prod.yml` because its name sorted first. Placeholders resolve innermost first and through values (`${a:${b:x}}`, `url: ${base}/v2`), and each module of a multi-module repo resolves its calls from its own config first.
- Constants are read from the whole repo, not just the file using them: `@RequestMapping(ApiPaths.CARDS)` with `ApiPaths.java` elsewhere in the repo is a verified endpoint `/cards`, and Kotlin `const val` counts too. A name defined twice with different values stays a loose end.
- The Spring extractor reads files that use a modelled framework even when they don't import Spring, and turns a file using one into a warning when nothing was read from it.
- The messy estate's two known gaps are closed: its house controller is an endpoint (inferred: a person wrote the model) and its wrapper call reaches `https://audit.tide.internal/audit/events`.
- A Spring property placeholder in a served path (`"${api.base}/x"`) is a loose end, not a verified endpoint whose path holds `${api.base}`.

#### The messy estate: the catalog-truth gate

- `fixtures/messy`: an invented bank (Tidewater) written the way real teams write code (constants, `@Value` base URLs, a house starter, a wrapper client, Kotlin, JMS, a password in the datasource URL, a broken template, a gateway with a declared host). `packages/scanner/test/messy.test.ts` checks a scan finishes, makes no verified fact the code doesn't spell out, shows every client call, joins through the gateway only on its host, keeps no secret and reports coverage. The house annotation and the wrapper client are recorded as known gaps for phase 3.
- Fixed, found by it: merge dropped loose ends of every kind it doesn't join (`http-endpoint`, `mq-publish`, `mq-subscribe`, and any a dialect emits), so they never reached the catalog. They now pass through. A `kafkaTemplate.send` was also taken for a JMS send.

#### Every client call is seen, joined or not

- A Spring call whose URL or topic the code builds (`restTemplate.postForObject(base + PAY, ...)`, `kafkaTemplate.send(Topics.PAYMENTS, ...)`, WebClient `.uri(...)`) is a loose end showing what it was built from, instead of nothing. Same-file `static final` String constants and `@Value` fields are filled in, so `base + PAY` reads `${nw.endpoints.payments}/v2/payments` and config resolves it where it can.
- JMS sends (`JmsTemplate.send`, `convertAndSend`) and `@JmsListener` destinations are recorded (`mq-publish`, `mq-subscribe`).
- A file that imports an HTTP or messaging client (RestTemplate, WebClient, Feign, Kafka, JMS, IBM MQ) but gave nothing is a scan warning.
- `atticus scan` prints how much of what it found it joined (`Joined 21 of 30 calls, listeners and endpoints found (70%)`); `--json` has `coverage` per repo: interfaces, loose ends and unread files.
- The Java reader reads Kotlin's `package` and `import` lines, which have no semicolon; before, the first import swallowed the rest of the file.

#### No secrets in the catalog

- A Spring datasource URL loses its credentials before it is recorded, in every JDBC form (`user:pass@`, `?password=`, `;user=..;password=..`, Oracle's `scott/tiger@`); a URL that could still hold one is left out. Before, `spring.datasource.url` went into catalog files, the catalog site and context packs as written.
- Settings whose names hold credentials (`pwd`, `passphrase`, `credentials`, `api-key`, `access-key`, as well as `password`, `secret`, `token`) are recorded as `(secret)`.

#### No facts made from what the code doesn't spell out

- `repos.manifest.yaml` takes `hosts` per repo (ADR 0053). Calls go through a gateway only on hosts listed for the gateway repo, and a call to a host listed for a component joins it whatever the host's labels say. Before, any unknown host whose path started with a gateway basepath was joined through the gateway, which invented interfaces. A scan note names each undeclared host that looks like a gateway.
- Merge never matches an endpoint of another method, and never joins a relative call on a generic path (`/health`, `/actuator/...`).

- A Spring path made from a constant (`@RequestMapping(ApiPaths.CARDS)`, `"/v2" + ApiPaths.CARDS`) is no longer a verified endpoint named `/ApiPaths.CARDS/...`: it is an `http-endpoint` loose end showing the name, `GET ${ApiPaths.CARDS}/${ApiPaths.BY_ID}`, until its value is known. Feign paths and listener topics made from constants show the name the same way, and stay loose ends.
- Merge never joins publishers and subscribers on a topic the code names but doesn't spell out.

#### Scans that finish and say what they couldn't read

- The Java and Kotlin reader always moves on: a stray `}`, `)` or `]` inside an annotation (templates, archetypes, half-edited files) used to loop forever and stop the whole estate scan.
- A file over 5 MB (a committed `vendor.min.js`, a data dump) is left out of the scan with a warning. Before, it made the extractor that met it fail for the whole repo, losing everything else it had found there.
- `atticus scan` says how many warnings the scan had (files left out, rules that couldn't fill a template) and `--warnings` lists them; `--json` has them under `warnings`, and the scan's stats count them. Warnings don't fail the scan.

#### Windows build and install

- `pnpm lint`, `pnpm licences`, `pnpm bundle` and `pnpm bundle:test` run on Windows: script paths come from `fileURLToPath`, the bundle imports through a file URL, and pnpm is started the way Windows needs. A new check in `pnpm lint` (`scripts/check-portable-paths.mjs`) refuses `URL.pathname` used as a file path and `import()` of a plain path.
- `install.ps1`: the `atticus.cmd` shim finds its version beside itself instead of holding a full path, so a profile folder with accented letters no longer breaks it; `-NoPath` leaves your PATH as it is.
- `pnpm bundle:test` installs into a home folder with a space and an accented letter, runs the `atticus` shim, no longer adds its throwaway folder to your PATH, and removes its temporary files when it passes. The bundle and licence check remove their `pnpm deploy` folder.
- The practice sandbox works on a machine with no Git identity (each repo gets a local one, with signing off), and its Git host is manual, so the product owner's lesson reaches Design with the command line alone: the hand-off PR steps are recorded with `atticus todo done`. Before, a fresh mock host in every command lost the PR.
- `atticus trace` no longer reports a test or plan twice when one worktree holds it with CRLF line endings (Git for Windows' `core.autocrlf`) and another with LF.
- Every package's tests run with their own temporary folder, removed when the run ends (`vitest.shared.mjs`); tests used to leave hundreds of folders behind in the system temp folder.
- CI runs the check on Linux and Windows on every push and pull request.
- The bundle leaves out `node_modules/.bin`, so a zip built on Windows holds the same files as one built on Linux.

#### Fixed

- The synthetic-estate scale test and the changes package allow for a busy machine: their limits (180 s and 30 s) were hit when every package's tests ran at once, at about ten times their time alone.
- The index no longer reads `specs/estate.yaml` (the estate's joins) as a flow, which every search warned about on a real metarepo.
- An estimate with no days no longer says the waiting is longer than the work: there is nothing to compare it with.
- `pnpm check` passes again: the core-neutral check allowlists the English word "teams" and the C6 wiki types; the inbox's matching moved out of a .tsx file; journeys 19 and 20 read the page's token without DOM types; the context engine's timing test reports times instead of asserting them.
- AI steps hold up with a real Copilot model (ADR 0103). Through a hand-off, each step's attempts now carry across resumes, so a step that never gets a passing answer stops after `--attempts` instead of handing it back for ever (the knowledge scan, ask and find, a change's needs, and the scan survey, verify, review and spec draft). An answer word for word the one that just failed ends the step instead of being asked for again.
- The quote check forgives the punctuation a quote ends with and single quote marks for double: a sentence cut short or a table cell quoted as a sentence matches; every word is still on the page, in order. A conflict that quotes the same words twice is refused.
- A change's needs take a cited file named with the change's folder in front (`add-transfer-limit/brief.md`, `openspec/changes/<id>/brief.md`), as Copilot writes it, and a quote ended with the model's own full stop.
- The command catalogue (`atticus commands --json`) says what every command does: summaries no longer end in the options they list (those are read as options), a description on the line under its command is read, and the commands that had none have one. The editors show these words.
- `atticus ui --parent <pid>` stops when that process ends. The IntelliJ plugin passes the IDE's, so a killed IDE leaves no server behind (only when the command line has the option, so an older one starts as before).
- The IntelliJ plugin finds `atticus` on PATH as npm installs it: it skipped npm's extension-less shell script for Git Bash beside `atticus.cmd`, which Windows never runs, and said the command line wasn't installed. Run a Command picks knowledge items, needs, features, manual steps, triage items, glossary terms, findings, onboarding proposals, stories, flows, systems and records, as the VS Code extension does.
- The IntelliJ plugin runs a change's needs and a wiki search in Copilot Chat (`/atticus-needs`, `/atticus-find`) and `knowledge ask` as a hand-off, instead of as plain commands; a next step `atticus next` gives a slash command for is always an AI step.
- `atticus ui --embed vscode` stops when stdin closes, so the server the VS Code extension starts ends with its window, even when the window or VS Code is killed.

## 1.0.0-rc.1 (2026-10-19)

The first release candidate: the whole product, built in five milestones.

### M5: ready to install

- `atticus doctor`: what this machine needs, each with a fix; first on the setup checklist and on Settings (ADR 0049).
- The local log (`.atticus/logs/`), redacted; crash messages that say where the details are; whole-file writes; one scan at a time; `atticus support bundle` (ADR 0050).
- `atticus upgrade` and `.atticus/metarepo.yaml`: migrations with backups, and an older Atticus refuses a metarepo a newer one upgraded (ADR 0051).
- The threat model; hardening headers on every response.
- The offline install bundle (`pnpm bundle`) with install scripts for Windows, macOS and Linux, checksums, a CycloneDX SBOM and third-party licences; the licence, dependency and docs checks in `pnpm lint` (ADR 0052).
- Performance budgets on 120 synthetic repos.
- Guides: install, admin, every role, troubleshooting, and the command reference.
- Fixed: the command line didn't declare `yaml`; shipped dialects were dropped outside the repository; `trace` cited tests in another task's worktree; `--port 0`.

### M4: the app

- The local API and all 27 screens in the HUD design, each with empty, loading and error states (ADRs 0015, 0043).
- A home and sidebar for each of thirteen roles, approvals from ownership only, first-run tours, guided setup and the catalog baseline (ADRs 0044, 0047).
- The command palette and Ask; system guides and the read-only catalog site; incident mode.
- Release views: deployment plan, forecast, evidence pack, release notes, outcome records and the security review draft (ADR 0045).
- AI on, text only or off (ADR 0046).
- Views across all changes, approvals waiting, the personal digest and the field-mapping grid (ADR 0048).
- The thirteen role journeys and an accessibility check of every screen in a browser.

### M3: changes from idea to release

- The change lifecycle across repos with hand-off PRs, separation of duties, risk and conflicts (ADR 0029); OpenSpec and Spec Kit as one framework (ADR 0030).
- The critic: rule layers, deterministic checks, AI lenses with evidence, rounds and gates (ADR 0034).
- Run with AI, assistant files for Copilot and Claude Code, planning, the story bar, manual adapters and executors (ADRs 0032, 0033, 0036, 0037).
- `init`, `adopt`, `absorb` and federation (ADR 0038); test generation, traceability, the CI drift check and the glossary (ADR 0039); features from code (ADR 0031); initiatives, learning, evals and defences (ADR 0042).

### M2: knowledge from documents

- Diagram and document ingestors, backend and platform extractors, intake and triage with curated decisions, knowledge sources, coverage and owner questions, stubs and diagram export, the dialect build kit (ADRs 0021 to 0028).

### M1: the catalog from code

- Built-in extractors and the dialect engine, merge and identity, the local index and query language, diagrams and reconcile (ADRs 0016 to 0020).

### M0: foundations

- The contracts C1 to C6, canonical YAML, the plugin SDK basics, the OpenSpec adapter, the workspace manager, adapters with mocks, the AI runtime and the OpenAPI document (ADRs 0001 to 0015).
