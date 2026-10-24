# 0118. The model searches the code: grep, files and outline beside the context tools (C5)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0074 (the AI reads; every fact cites its code), 0104 (the Claude Code plugin and MCP), 0107 and its addendum (the context tools), 0111 (checks that tie each value to its source), 0112 (code excerpts that fit the model)

## Context

The context tools (ADR 0107 addendum) let a step's model search what Atticus already knows and show the code a fact cites. They can't find code no fact cites yet. The scan's survey step (ADR 0075) drafts a repo's scan settings from its folder tree, the entry points the built-in readers found and a fixed list of config files. At an organisation that has wrapped its framework (a base path set by an in-house annotation, routes registered by a house library), the line that holds the answer is in none of those, and the survey can only guess or ask.

Matching more file names or annotation names in Atticus would be a heuristic about what code means, and every organisation's framework is different. The model is the part that knows what to look for: it should choose the search.

## Decision

### 1. Three more read-only context tools

Defined beside the others in `@maycombhq/index` (`CONTEXT_TOOLS`, `runContextTool`), so every surface offers the same tools with the same caps:

- **`grep`**: the lines that match a pattern the model gives, literal by default or a regular expression (`regex: true`), optionally case-insensitive and limited to a glob of paths, in one repo or every repo cloned in the workspace. Each hit is one line, `repo:path:line: text`, the text cut at 200 characters. At most 100 hits a call (30 by default), a pattern of at most 200 characters, files of at most 2 MB, 20,000 files a call; a binary file is skipped; a cut is said.
- **`files`**: the paths a glob matches, `repo:path`, at most 500 a call (200 by default).
- **`outline`**: a file's declarations, one per line as `repo:path:line: kind name`, nested by indentation, with the annotations, decorators or attributes written on each exactly as written. It comes from the syntax trees the readers already parse (tree-sitter, ADR 0060): any node the grammar calls a declaration, definition or item that has a name, and a variable bound to a function. The tool doesn't say which are endpoints: the annotations are shown as written and the model reads them. A Markdown or AsciiDoc file gives its headings; YAML, properties and JSON their top-level keys; any other file says it has no outline.

All three read only the repo's base clone under `workspace/`, with the existing path guards (no absolute path, nothing that leaves the clone by `..` or a link). They skip `.git/` and every path the repo's `.gitignore` files (the root's and each folder's) ignore, with negation and folder-only patterns. They never write, and need no index.

The outline's reader is passed in (`ContextToolOptions.outline`) by the CLI from `@maycombhq/extractors` (`declarationOutline`); `@maycombhq/index` gains no dependency.

### 2. A hit is a pointer, never a fact

`show_code` by repo, path and line still shows a line some fact cites, and now also any line a `grep` or `outline` hit of the same run returned. In a run on the model runtime the tool box keeps the hits; for a call made elsewhere (`atticus context call --run`, the VS Code extension) the hits are read back from the run record's earlier `grep` and `outline` calls. The caps stay as they are: tokens per call and per run (ADR 0107 addendum), every result defended and wrapped as data.

Nothing a tool returns becomes a fact. A fact still cites its file and line, and the deterministic check confirms the value at that line (ADR 0111). The tool calls are kept in the run record as the others are and shown in Model runs.

### 3. Where they are offered

- **The model runtime**: the CLI's tool source offers all seven to a provider that calls tools; `TOOLS_RULE` names them.
- **The VS Code extension**: the hand-off's `tools.definitions` is `CONTEXT_TOOLS`, so Copilot's model gets them through `vscode.lm` and each call runs as `atticus context call`.
- **Claude Code**: the MCP server gains `grep`, `files` and `outline`, read-only.
- **Commands**: `atticus context grep <pattern> [--regex] [--ignore-case] [--repo r] [--paths glob] [--limit n]`, `atticus context files <glob> [--repo r] [--limit n]` and `atticus context outline <repo> <path>`.
- **The survey** (`atticus scan survey`) tells the model to search for the code that sets a prefix, a base or a folder the material doesn't show (an in-house annotation, a wrapper), and to cite the line it found; the survey's repo is offered by its id even when it was given as a folder. Spec draft and scan verify get the tools wherever tools are offered, as every step does.

## Consequences

- The survey can find a custom framework's code before it customises the rule files, instead of relying on the folder tree and a fixed list of config files. The model supplies the meaning by choosing what to search; Atticus adds no heuristic about what code means.
- A run's record shows every search the model made and what it returned.
- C5 is unchanged in shape: three more tool definitions; the run record and its schema are as they were.
- Not built: `show_code` through the MCP server still takes an id only (each MCP call is its own command, so there is no run to hold the hits; Claude Code reads files itself). The outline of a language without a shipped grammar is its headings or keys only.

## Addendum (2026-10-24): a name is in the code by its declaration, or as a file (S1, T2)

A live run on a metarepo (a Java/Spring chat app with Flyway migrations) showed `namesInCode` (ADR 0116 addendum) reading the wrong things. It listed three Java classes as gaps, each declared in its own `.java` file under `api/src/main/java/`. It listed other classes as "in the code", but cited a markdown plan in the repo's `docs/` for every one. It also raised a Flyway migration (`V10__chat.sql`) and three `.java` files as gaps, by their file names.

**Root cause.** `namesInCode` walked every file of every clone and took the first line holding the name as a whole word. Prose is words, so a plan in `docs/` that names a class was found before (or instead of) the class. Nothing checked that a file was source, or that the line declared the name. A file name was searched for as a word inside files, never as a file. The walk shares its file and byte caps across clones, and it read every file to the cap, docs and data included. So a repo whose code comes late in the walk can go unread, and its classes come back as gaps. Without the real repo the second cause can't be confirmed. The first is enough to give the result seen.

**Decision.**

- **Source files only, by the readers' own grammars.** A file is source when the outline has a grammar for it. `ContextToolOptions.outlines(path)` is the extractors' own test (`syntaxLanguageOf`), so the list of languages is the readers' list. No list of extensions is kept here. The planner passes the extractors' outline and that test (`codeReaders()`). The dialect's `layout.sourceRoots` exists in C2, but nothing reads it today, and the scanner picks files by each rule's own globs, so there is no repo-level notion of source files to reuse. When a reader of `sourceRoots` lands, it can narrow the walk.
- **By declaration, never by a word.** A name is in the code when the file's outline (ADR 0118 point 1) declares it: a class, interface, record, enum, struct, trait, object, type alias, function or the like. A method, constructor, field or property doesn't count (`isTypeDeclaration`). It is cited `repo:path:line`, the line of the declaration's name. A comment, a string, a use (a parameter's type) and a markdown sentence are not declarations. A name only used but declared nowhere in the workspace is a gap, because nothing Atticus can read says what it is. Without an outline, nothing is found by its words. Only source files that hold the name are parsed, and nothing else is read.
- **A file of the repo's tree counts, by its path.** A name that is a file's name, or the end of its path (`V10__chat.sql`, `ChatController.java`), is found as `repo:path`, with no line. Files the repo's `.gitignore` ignores are skipped, as in `grep`. The context gaps also check the catalog's Migration records for the file name (ADR 0116 addendum T2).
- **The repo's own docs aren't code.** A repo's `docs/*.md` is never read as code. It is a document, and the metarepo's knowledge sources are `inputs/` (ADR 0122) and the wikis. A repo's docs should be offered as a knowledge source, read like a file in `inputs/`, cited to its line, and kept below what the code says (constitution: a document never overrides a fact verified from code). That isn't built: today a repo's docs reach the model only through `grep`.

Tests: `packages/planner/test/known-names.test.ts` on the invented `forge-boards` repo (`packages/planner/test/fixtures/names-in-code/forge-boards`). It has classes, a record and an enum declared in source, the same names and others only in `docs/REVIEW-PLAN.md`, a name used but not declared, and a migration file. The A4 fixture's `NewOrder`, used only as a parameter's type, is now a gap (`fixtures/names-in-code/expected.yaml`).
