# 0107. The context engine: one persisted graph, searched and walked, for what each AI step sees (C5)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0002 (the SQLite index), 0074 (the AI reads; every fact cites its code), 0101 (knowledge managed in the metarepo), 0103 (AI steps that hold up with Copilot), 0106 (model runs; batches that fit the model)

## Context

An AI step's prompt is a context pack: instructions, then data sources by priority, cut whole at the budget (`buildContextPack`). What goes in was decided step by step:

- Two steps select by relevance: change draft (`relevantMap`: IDF over the brief, ids it names, then a hand-written walk to entry points, components, interfaces, readers and writers) and knowledge ask (`rankItems`: IDF over items).
- The rest send whole lists: change needs sends every knowledge item; the feature and architecture stages send the whole estate index; the architecture stage every pattern and decision; the stories stage every process; spec draft the first 400 other endpoints, unranked.
- Over budget, sources drop whole in a fixed order (by id in places), so a needed item can fall out silently.
- The catalog has a persisted index (`.index/catalog.sqlite`: records, refs, evidence) with graph and impact walks, rebuilt whole when any catalog file changes. No AI step uses it. Knowledge items, flows, changes, needs, questions and wiki sections aren't in it, and it has no text search.

With a model of 12,078 tokens (Copilot's GPT-4o mini) the whole lists don't fit, and with any model they cost tokens on every call for records the step doesn't need.

## Decision

### 1. One persisted graph of what Atticus knows

The index (`.index/`) holds, beside the catalog's records, refs and evidence:

- **knowledge items** (each kind, with its quote, page and review state);
- **flows** and their steps (`specs/`);
- **changes**: brief, placement on flows and features, needs, tasks and stories;
- **answered questions** (a person's answer is asserted knowledge, with who and when);
- **wiki page sections** from the newest snapshot of each source;
- **typed links between them**, each saying how it was made:
  - a knowledge item names a system, component, vendor or product by its name or an alias the org pack or a knowledge item gives (exact, case-insensitive; never a guess);
  - a flow step calls an endpoint or interface the flow names;
  - a change touches the flows, features and systems its placement and files name;
  - a need is for a knowledge item and a change target.

It is updated **incrementally**: each file's fingerprint (size, time and, when those change, content hash) is kept, and only changed files are re-read; a removed file's rows and links go.

### 2. Full-text search

An FTS5 table (SQLite's, built into Node's driver) over each node's searchable text: names, ids, descriptions, quotes, rules, applies-when, flow step text, wiki sections and answered questions; BM25 ranking, with column weights (names and ids above prose).

### 3. Selecting a step's context, without a model

`selectContext(seeds, budget)` (packages/index, used by the steps):

1. **Seeds**: ids and names the step's input names (resolved exactly), and the top search hits for its words (title words weighted up).
2. **Walk**: a bounded walk of the graph from the seeds (at most 2 hops by default, a fan-out cap per node, kinds the step asks for).
3. **Score**: text match × a decay per hop × a weight per kind the step sets × verified over unverified.
4. **Fit**: full detail for the highest scores, one line for the next, until the budget (the model's real limit less the instructions, as for batches); what was left out is listed by id and score, so a person can see it and the model can ask for it.

The result is cached by the step's input hash and the index's version. It is deterministic: the same commit, input and budget select the same context.

The steps that send whole lists use it first: change needs, the feature stage, the architecture stage and the stories stage. Change draft and knowledge ask move onto it too.

### 4. The model asks for more (tools)

A step's model gets read-only tools beside its pack: query the graph, walk from a record, search the text, show a record in full, show the code a fact cites (a bounded excerpt at its file and line). The VS Code extension passes them through the language model API's tool calls; the model runtime through its provider's; Claude Code through the MCP server (ADR 0104). Every tool call and what it returned is kept in the run record, so a run shows what the model looked at. A step's pack can then start small.

### 5. What neither the wikis nor the repos say

`selectContext` names what the input mentions and the graph doesn't have (a vendor in a brief with no record, a system with no owner, a repo not scanned). The step lists these as gaps in its answer, and each gap that blocks a fact becomes a question to a person (the existing questions), never a guess. An answer becomes an asserted knowledge item with its provenance and joins the graph.

### 6. Measured

An eval (packages/evals) scores each step on the Forge fixtures with and without the engine: recall of the records a correct answer needs (from the golden answers), precision, and tokens sent. The engine replaces a step's whole list only when its recall is at least the old one's.

For providers with a prompt cache (Anthropic, through the model runtime), a pack puts its stable parts (instructions, org-pack skills, the estate digest) first so the prefix can be cached. Copilot gives extensions no cache control.

## Consequences

- A step sends what it needs, ranked and fitted to the model, and says what it left out; the model can ask for more.
- The index becomes the one place Atticus's knowledge is queried, by the steps, the app, the MCP tools and the commands.
- Context for a step is a millisecond local query, cached; no embedding model or new service is needed. Embeddings for wiki prose stay possible later, if the eval shows text search misses what they would find.
- C5 is unchanged in shape: packs are still context packs; the run record gains the tool calls.

## Addendum: the model asks for more, and what neither the wikis nor the repos say (2026-10-23)

Points 4 and 5 are built as follows. The earlier points stand as decided.

### 4. Tools beside the pack

- **The tools, defined once** in `@maycombhq/index` (`CONTEXT_TOOLS`, `runContextTool`): `search` (the index's text, names and ids first), `show` (one record, flow, flow step `flow#n`, knowledge item, change, answered question or wiki section in full, with its file and whether it was verified), `walk` (its links, how each was made, at most two hops and 40 lines) and `show_code` (a few lines, at most 20 each side, around each file and line a record or flow step cites, at most three cites). Each has a JSON Schema for its input. They only read. Code comes from the repo's base clone under `workspace/`; an absolute path, a `..` or a link that leads out of the clone is refused, and `show_code` by repo, path and line shows only a line some fact cites.
- **The runtime's shape (C5)**: a `ToolBox` (definitions and a call), `ToolSession` (runs calls, keeps the record, holds the caps) and `chatWithTools` in `@maycombhq/ai`. A `ModelProvider` may have `chat` (a conversation with tool calls); one without it gets the one-shot prompt and no tools. What a tool returns is data: it goes through the ingested-content defences (a high-risk result is withheld) and is wrapped as data, like a pack's sources.
- **Caps**: at most 6 rounds of tool calls in a run (then one request asks for the answer with no more calls: tool choice none where the provider has it), 12,000 tokens from tools in a run and 3,000 from one call (cut, with the cut said). In VS Code the room is also the model's own limit less the prompt and a reserve; below 800 tokens of room the model gets the one-shot prompt.
- **The run record, version 2** (`RUN_SCHEMA_VERSION`): `tools` holds the tools offered, every call (round, the provider's id, name, input, exactly what was returned, its tokens, whether it was refused) and, when a cap ended them, which cap. `migrateRunSummary` reads a version 1 record as version 2 with no tools. A model-runtime run is now kept under `.runs/` (run.json, prompt.md, the manifest), as a hand-off run is, so Model runs shows it. `atticus runs show`, `GET /api/runs/{runId}/transcript` (`tools`), `GET /api/runs` (`toolCalls`, API 2.10.0) and the app's Model runs screen show what the model looked up, as text.
- **Wired** in three places: the model runtime (the CLI registers the context tools; Anthropic's `tool_use`/`tool_result`, Chat Completions' `tool_calls`/`tool` messages for OpenAI-compatible and Azure OpenAI, Bedrock Converse's `toolUse`/`toolResult`); the VS Code extension's runner, through `vscode.lm` tools (`LanguageModelChatRequestOptions.tools`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, all in @types/vscode 1.95, the engine version), where `--handoff --json` offers the tools and each call runs as `atticus context call <tool> --input <json> --run <run>`, so the waiting run's record keeps it and the caps hold across calls; and Claude Code, whose MCP server gains `show`, `walk` and `show_code` beside `search` (read-only, ADR 0104). `atticus context show|walk|code|tools|call` are the same tools as commands.
- **A smaller pack**: the eval runs each step with the engine and a scripted model that calls the tools. At the tight budget the tools bring back what the pack left out (the needs step's recall goes from 0.50 to 1.00) and recall holds on every step, but the tokens in all are higher than the engine's full pack on every step (each round adds what the tools return). So no step's pack starts smaller yet; the eval says when that changes.

### 5. Gaps

- `selectContext`'s `unknown` is less of a guess: a heading, a Title Case line, a Given/When/Then or user-story phrase, days and months, a sentence's first verb, fields, files and commands in backticks are not names; a known name with only generic words beside it (Northwind Pay API, Forge Shop UI) is known; and a phrase a record, item, flow, answered question or wiki section already uses is known to the wikis or the repos (a change's own files don't count). The fixtures test each false positive.
- The steps that use the engine (needs, feature, architecture, stories) list the gaps in their result (with the line of the change that names each) and send them to the model as data with the rule not to guess. A gap the answer relies on (the answer names it) becomes a question to a person through the existing questions (ADR 0078): asked by the step `context-gap`, the change as its repo and that line as evidence, so every step of the change waits on one question per gap; a stage waits for it as for its other questions. A name a target flow itself adds (`new: true`) is the change's own, not a gap. The gaps and answers take their room from the selection, not from the step's input.
- An answered gap is an answered question, already indexed as asserted knowledge with who and when; the index also makes its name known by that answer, so it is no longer a gap, and the change's later steps get the answers in their pack.

## Amended by ADR 0116 (2026-10-23)

Points 2 and 3 are amended by ADR 0116 (retrieval by meaning): the full-text search also looks for the words an identifier is made of (index version 3); the searches are fused by reciprocal rank, not summed by score, and `kindWeights` is gone; a glossary term or alias the input uses brings its other names as one more search; wiki sections are named by their heading path and cut into parts; documents in `inputs/` are indexed; a local embedding model, a model's expansion of the input and its rerank of the candidates are further rankings or orders, each off until configured. The gaps of point 5 are the names a model's expansion finds (the word lists of the addendum are removed); the index only checks that it lacks each.
