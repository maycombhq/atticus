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
