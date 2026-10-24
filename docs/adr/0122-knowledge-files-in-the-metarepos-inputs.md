# 0122. Knowledge files in the metarepo's inputs/, in two scopes (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-24
- Builds on: ADR 0083 (knowledge sources and snapshots), 0101 (git wikis), 0113 (a change's own inputs), 0119 (one experience on every surface)

## Context

People keep knowledge in files as well as wikis: decisions, runbooks, partner specs, request forms, slide decks, exported pages. Today:

- The metarepo's `inputs/` is read by intake only. Intake classifies each file, finds duplicates and versions, and reads specs and diagrams into the catalog. A document's text never becomes a knowledge item that plans, `needs` and the stages can use.
- The knowledge scan reads wiki snapshots only.
- A change's own `inputs/` folder (ADR 0113) is read by that change's steps, cited by line or page. Nothing moves a file from there into general knowledge.

The files belong in the metarepo, never in folders inside the code repos.

## Decision

Knowledge files come in two scopes, each kept apart:

- **General knowledge** goes in the metarepo's `inputs/`. The knowledge scan reads it into items every change and step can use.
- **Specific to a change** goes in `openspec/changes/<id>/inputs/` (ADR 0113, unchanged). Only that change's steps read it.

### 1. inputs/ is a knowledge source of its own

- Its id is `inputs`. It is always on and is never listed in `sources.yaml`, which may no longer use that id for a wiki. That restriction is the only C6 change. A `sources.yaml` naming a wiki `inputs` gets a message saying why and what to do.
- `atticus sources sync` reads it with the wikis, or alone with `--source inputs`, and needs no wiki configured. It writes a dated snapshot in `knowledge/snapshots/inputs/<date>/`. The knowledge scan reads that snapshot like any other, so items quote the file and each quote is checked.
- Intake decides which copy counts. A file dropped twice is read once: the copy outside `inputs/inbox/`, else the first by path. An older version is kept but not read; the snapshot lists it as skipped, naming the newer one.
- Each document is read into text by the readers intake and change attachments already use: Markdown, text, HTML, Word, PowerPoint, Excel and PDF. Markdown is kept as it is, so a quote's line is the file's line. Other formats become Markdown with their headings, page numbers and tables.
- Not read here, and listed as skipped with the reason:
  - a picture, which goes to a person (AI steps take text only);
  - specs, diagrams and payload samples, which intake reads into the catalog.
- Every page goes through the same defences as a wiki page. A document never overrides a fact verified from code. A page above the classification limit is listed and not read.

### 2. A Documents tab (Knowledge)

It lists the files in `inputs/`:

- their kind and the systems they name;
- whether each is read, skipped (with the reason), or has items proposed or verified;
- their age, and duplicates or newer versions;
- filters by system and kind;
- for each file, the knowledge items that quote it.

### 3. Drop targets

- The Documents tab gets **Add files**, which writes to `inputs/inbox/` through the upload path change attachments use.
- VS Code and IntelliJ get **Add to Atticus knowledge…** beside **Attach to Atticus change**.
- `atticus intake add <files>` already does this from the command line.

### 4. From a change to general knowledge

`atticus change attach <change> --promote inputs/<file>`, or **Copy to general knowledge** in a change's Files attached panel, copies a change's file into `inputs/inbox/`. The change keeps its copy. The next sync reads it.

## Consequences

- Knowledge dropped as files is read, organised and cited like wiki pages, with no new configuration.
- Intake stays the one place that decides duplicates and versions.

What isn't built, stated up front:

- A scanned PDF with no text layer needs OCR, which isn't built.
- A picture is never read by AI.

## Built

- Item 1: `cli/src/inputs-knowledge.ts` (`inputsPages`, `INPUTS_SOURCE`) and `knowledge` `syncSources` `adaptersById`. `sources sync` reads `inputs/` with the wikis, or alone. The Sources schema refuses a wiki called `inputs`.
- Item 2: `GET /api/knowledge/documents` (`cli/src/documents.ts` `listDocuments`) and the Documents tab (`ui/src/screens/knowledge/Documents.tsx`), with Add files (`POST /api/knowledge/documents`, through `addToInbox`, the function `atticus intake add` uses) and Sync inputs/.
- Item 3: the app's Add files; VS Code's `atticus.addToKnowledge` and IntelliJ's `Atticus.AddToKnowledge`, on the right-click menu.
- Item 4: `promoteChangeInput` (`cli/src/attach-commands.ts`), `change attach --promote`, `POST /api/changes/{id}/inputs/{name}/promote`, and the button on Files attached.
- Not built: the changes whose steps cite a file's items; flagging a file stale when the code it names is gone (as `knowledge/src/freshness.ts` does for a wiki page).
