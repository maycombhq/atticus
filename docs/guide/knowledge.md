# Org knowledge: wikis, documents and API guides

Atticus reads your organisation's wikis and documents into knowledge items: patterns, standards, processes, service requests, decisions and constraints, each quoting the page it came from. A change's stages pick the items that apply to it, and you confirm or exclude them.

Every command below runs in the metarepo (or add `--root <dir>`). The examples use the invented Forge wiki in `bench/knowledge/forge-wiki`. Steps that need a model take `--handoff`: Atticus writes a prompt, your assistant answers it into the result file, and you run the two commands it prints. A scan never fetches anything; only the model call leaves the machine.

## 1. Add a source

A wiki kept as Markdown files, or a git wiki:

```sh
atticus sources add markdown-folder ../org-wiki --id org-wiki --owner team-platform --save
atticus sources add git https://git.example/forge/wiki.git --save
```

Without `--save` it prints the `sources.yaml` entry for you to add through a pull request. Paths are relative to the metarepo. Tag a source so the scan knows what to look for first: `atticus sources tag org-wiki --kind integration-patterns,security-standard --framework anvil`.

A single document, such as a vendor's API guide in Markdown, Word or PDF, goes into the metarepo's `inputs/` folder, which is always a source (`inputs`):

```sh
atticus intake add ../northwind-pay-api-guide.md
```

An OpenAPI spec or a diagram is read into the catalog by intake, not into knowledge. `atticus sources sync` lists it as skipped and says why.

## 2. Take a snapshot

```sh
atticus sources sync                 # every source, inputs/ included
atticus sources sync --source inputs # one source
```

Each source is copied to `knowledge/snapshots/<source>/<date>/`. The scan reads that copy. The sync also reports:

- a page that hides an instruction to AI tools (it is held back from every AI step until a person reviews it);
- a file in `inputs/` that is the same page as a wiki's (read once);
- a sentence that disagrees with the code (code wins);
- facts that only the wiki states, such as an SLO.

## 3. Scan

```sh
atticus knowledge scan --handoff
```

Your assistant reads every page and writes the items. Atticus checks each quote on its page, word for word, and each lead time, owner, status and date against the quote that states it. `atticus handoff done` runs the same checks on the answer and lists what fails, so your assistant can fix it before you resume; after three checks the answer goes in as it is. Anything that still fails goes back to the assistant in the next prompt, and the resume says which checks failed, up to three attempts. The scan keeps what passed and writes it to `knowledge/items/` and `knowledge/scan.yaml`. It also lists pages that disagree, superseded pages and hidden instructions.

A rescan reads only the pages that changed (`--full` reads them all; `--source <id>` reads one source).

## 4. Ask and search

```sh
atticus knowledge list                       # every item; --kind request, --tag anvil
atticus query "webhook signature" --search   # items, wiki sections and documents, best first
atticus context show vendor-onboarding       # one item in full, with its file
atticus knowledge ask "What do I need before Forge can call a new vendor host?" --handoff
```

`ask` answers from the items only, citing each one, and says when two pages disagree. `query --search` also finds wiki and document sections that no item covers. To turn one of those into an item, use `atticus knowledge find "<phrase>"`, then `atticus knowledge keep <item>`.

Check an item with `atticus knowledge verify <item>`, fix it with `atticus knowledge correct <item> --set leadTime="5 working days"` (the scan's own field names, such as `lead_time`, work too), or drop it with `atticus knowledge reject <item> --note "<why>"`.

A document in `inputs/` is searched once, from the file itself, cited by its file and section. A file the sync skipped, such as a copy of a wiki page, isn't searched.

## 5. See what applies to a change

Start a change, write its brief, then run its stages:

```sh
atticus change new "Show held Northwind Pay transfers in the portal" --type feature --id show-held-transfers
atticus change feature show-held-transfers --handoff
atticus change architecture show-held-transfers --handoff
atticus stories show-held-transfers --handoff
atticus change knowledge show-held-transfers
```

Each stage picks the knowledge its own input leads to, and sends it to your assistant with the rest of its prompt:

- **Feature:** from the brief and the flows and systems it leads to, the patterns, standards, decisions, processes and requests. The placer names an item where it bears on a gap or a question.
- **Architecture:** the patterns, standards and decisions, each one sent in full with its rules.
- **Stories:** the processes and requests, and the standards with their rules.
- **Every stage:** the wiki and document sections, vendors and glossary terms its input matches, found by the same search as `query --search`. The top three go in with the page's own words and where they are read from, the next as one line each, within a small share of the prompt. A page no item covers, such as an API guide's webhook section, reaches the change this way.

Each stage writes what it picked to `openspec/changes/<id>/knowledge.yaml`: each item's title, why it was picked and the stages that used it. A process or request that a story's step meets also goes into `requests.md`, quoting its catalogue page.

`atticus change knowledge` lists each item by its title, with its id in brackets, and says why in plain words: "The change names it", "Linked to northwind-pay, which the change leads to", or "Its words match the change's title and words".

In the app, the list is the **Knowledge that applies** panel on the change's Feature design tab (`GET /api/changes/<id>/knowledge`), filled from the feature stage on.

## 6. Confirm or exclude

```sh
atticus change knowledge show-held-transfers --exclude p3-file-transfer
atticus change knowledge show-held-transfers --confirm p4-vendor-partner-gateway
```

- **Excluded:** no later stage picks the item again. Use this for a false match, such as "file transfer" picked for a money transfer.
- **Confirmed:** every later stage that takes the item's kind picks it, even if its search didn't. Confirming a near-miss (an item left out for room) makes it an item.

The app's Confirm and Exclude buttons write the same file and show the `git add … && git commit …` command to run. Commit `knowledge.yaml` with the change's other files.

## What it doesn't do yet

- Matching by words still picks "file transfer" items (a file-transfer pattern, its request, a file hub's retirement) for a change about a money transfer, from the model's reading of the brief. Exclude them; no later stage picks them again.
- A story's Context doesn't yet link the items its criteria drew on.
- A real document, a diagram and a real repo are still to walk.

`docs/build-status.md` (B2) has the detail.
