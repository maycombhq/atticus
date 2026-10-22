# 0093. The VS Code extension's sidebar, code links and CodeLens

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0090 (the VS Code extension), ADR 0091 (the app in a VS Code tab), ADR 0092 (the Flows screen and the specs API)

## Context

The extension of ADR 0090 had one small view: the next step, the open questions, and a link to the app. Everything else Atticus knows was only in the app, in its own tab:

- the repos and their scans;
- the flows and their steps;
- the changes, their files and findings;
- the catalog.

The product owner asked for a fuller extension that shows more of that data in VS Code itself. An extension can also do something the app in a browser can't: take a person from a flow step straight to the code it cites, and show in the code which flows cite a line.

## Decision

1. **The sidebar has four sections:**
   - **Next**: as before.
   - **Repos**: each repo with its last scan; under it the repo's flows, each flow's steps, its scan settings and its place on the canvas.
   - **Changes**: each change with its state and blocking findings; under it its files with their state, and its findings.
   - **Catalog**: each kind with its count; under it its records, and each record's citations.

   What a click does:
   - a step or citation opens the code at its line;
   - a change file, a finding, a record or the scan settings opens that file;
   - a flow, or a step's diagram button, opens the flow in the Atticus tab with the step marked (`&step=N`, a new parameter of the Flows screen).

   A file not written yet, or a repo not cloned here, says so instead of failing. The sidebar never runs a step or changes a file.

2. **Data comes from the app's local API (C4).** The extension already starts the app for the tab, so it reads the session token the app prints and calls the API on 127.0.0.1. The service starts one app per window for the tab, the sidebar and the lenses, starts it again if it stops, and stops it when the window closes. The extension keeps its own copy of only the fields it reads (`src/api-types.ts`), since it ships with no dependencies, so an addition to the API never breaks it.
3. **A repo's code** is found in an open folder named for the repo, else in its base clone `workspace/<repo>` (ADR 0008).
4. **CodeLens.** Above each line a spec flow cites (its trigger and every step), a lens names the flow and the step and says who confirmed it, for example `Atticus: Save a chart · step 4, lookup · confirmed by the check`. Clicking it opens the flow beside the code with the step marked.
   - Every spec's cited lines are read once, when the first file is opened, and read again when a file under `specs/`, `catalog/`, `openspec/` or `questions/` changes, or on Refresh.
   - The setting `atticus.codeLens` turns the lenses off.
5. **A status bar item** shows the open questions and the next step, and opens the sidebar.
6. **No contract changes.** The extension reads routes that already exist. The Flows screen's `step` parameter is a link parameter, not part of the API.

## Consequences

- From a line of code, a person sees which flows go through it and opens the flow. From a flow, they open each step's code. A change's files, its findings and the catalog's records are one click from the editor.
- Checked against nadi-meta's live API with the extension's own code:
  - all 604 steps of the 127 flows open a real file;
  - all 696 cited lines fall inside their files;
  - all 55 Table records open their YAML.

  It has not yet run inside a real VS Code.

- A metarepo with many specs reads every flow once to build the lenses: 127 requests on NadiEngine, eight at a time, on 127.0.0.1. A much larger estate may want one API call for a repo's cited lines; that would be a C4 addition with its own ADR.
- Not built: answering a finding from the sidebar (it opens the file; the app and the command line act on it), and lenses for catalog records (a record's citations are listed under it in the sidebar).
