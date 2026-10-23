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
