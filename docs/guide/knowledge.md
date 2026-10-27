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

To read only part of a folder, give the source `include` and `exclude` page patterns (`sources.yaml` version 2; `atticus upgrade` moves a version 1 file). `**` spans folders, `*` stays in one, and a pattern ending in `/` or with no wildcard takes the whole folder it names:

```yaml
schemaVersion: 2
wikis:
  - { id: orders-docs, type: markdown-folder, location: ../docs, exclude: [runbooks/, drafts/**] }
  - { id: orders-runbooks, type: markdown-folder, location: ../docs/runbooks }
```

A page two sources cover is read once, by the source nearest to it (here `orders-runbooks`); the other source's snapshot lists it as skipped, with where it is read.

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

- a page that hides an instruction to AI tools (it is held back from every AI step until a person reviews it). Only imperatives aimed at an AI count ("ignore previous instructions", "you are now", "disregard the rules above", text hidden from readers); a page that only names the system prompt or the developer message, or has a "System prompt" or "Instructions" heading, is ordinary prose;
- a file in `inputs/` that is the same page as a wiki's (read once);
- a sentence that disagrees with the code (code wins);
- facts that only the wiki states, such as an SLO.

## 3. Scan

```sh
atticus knowledge scan --handoff
```

Your assistant reads every page and writes the items. Atticus checks each quote on its page, word for word, and each lead time, owner, status and date against the quote that states it. `atticus handoff done` runs the same checks on the answer and lists what fails, so your assistant can fix it before you resume; after three checks the answer goes in as it is. Anything that still fails goes back to the assistant in the next prompt, and the resume says which checks failed, up to three attempts. The scan keeps what passed and writes it to `knowledge/items/` and `knowledge/scan.yaml`. It also lists pages that disagree, superseded pages and hidden instructions.

A quote is matched with the page's blockquote (`>`) and list markers left out, so a sentence that wraps inside a blockquote, or runs on into the next list item, can be quoted; every word must still be on the page, in order.

A rescan reads only the pages that changed (`--full` reads them all; `--source <id>` reads one source).

The scan reads every page, in batches that each fit the knowledge reader's prompt: its budget (`budgets.perAgent.knowledge-reader` in `runtime.yaml`, or the model's limit with `--max-tokens`) less the instructions, or `--batch-tokens n` for the pages' room. A model or headless runtime reads batch after batch in one run. A hand-off hands one batch a run: it says how many pages wait and which, and after you resume, `atticus knowledge scan` again hands the next. A page too big for the prompt on its own is named, with what to raise, and the other pages are still read. A page that wasn't read is never recorded as read, so the next scan reads it.

## 4. Ask and search

```sh
atticus knowledge list                       # every item; --kind request, --tag anvil
atticus query "webhook signature" --search   # items, wiki sections and documents, best first
atticus context show vendor-onboarding       # one item in full, with its file
atticus knowledge ask "What do I need before Forge can call a new vendor host?" --handoff
```

`ask` answers from the items only, citing each one, and says when two pages disagree. `query --search` also finds wiki and document sections that no item covers. To turn one of those into an item, use `atticus knowledge find "<phrase>"`, then `atticus knowledge keep <item>`.

Check an item with `atticus knowledge verify <item>`, fix it with `atticus knowledge correct <item> --set leadTime="5 working days"` (the scan's own field names, such as `lead_time`, work too), or drop it with `atticus knowledge reject <item> --note "<why>"`.

A document in `inputs/` is searched once, from the file itself, cited by its file and section. A file the sync skipped, such as a copy of a wiki page, isn't searched. A wiki's sections are searched from the pages its snapshot lists, and once the scan has read the source, from the pages it read. A `#` line in a fenced code block (a shell comment) is code, not a heading.

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

**Where to see a change's knowledge:** in the app, open the change and its **Knowledge** tab, beside Feature design (`#/change-knowledge?change=<id>`, or Ctrl+K and "knowledge that applies"; `GET /api/changes/<id>/knowledge`), filled from the feature stage on. Feature design links to it.

## 6. Confirm or exclude

```sh
atticus change knowledge show-held-transfers --exclude p3-file-transfer
atticus change knowledge show-held-transfers --confirm p4-vendor-partner-gateway
```

- **Excluded:** no later stage picks the item again. Use this for a false match, such as "file transfer" picked for a money transfer.
- **Confirmed:** every later stage that takes the item's kind picks it, even if its search didn't. You can confirm any knowledge item, wiki or document section by its id (`atticus knowledge list`, `atticus query "<words>" --search`), whether or not the list has it; a near-miss (an item left out for room), or one no stage picked, becomes an item.

Each `--confirm` or `--exclude` says only what changed, such as `Confirmed firewall-rule-request (ProcessDefinition, Network firewall rule): every later stage that takes it selects it.`; run the command without them to see the whole list.

The app's Confirm and Exclude buttons write the same file and show the `git add … && git commit …` command to run. Commit `knowledge.yaml` with the change's other files.

## 7. Knowledge per story and per task

The change's list is the knowledge for the change as a whole. Each task gets its own, narrower list: the how-tos and runbooks (wiki and document sections, and processes with their steps), standards, requests, patterns and decisions that bear on implementing its own step. A change that adds SSO to placing an order gets the "Set up SSO for a Forge service" how-to and the token claims standard on the task that changes the entry step, not only somewhere on the change.

```sh
atticus stories add-sso --handoff        # or atticus change small add-sso for a small change
atticus task context add-sso 1.1
```

How a task's list is chosen:

- The search starts from the task's own words and walks from its flow, its components and the table it stores in.
- The search finds candidates by words, glossary synonyms and aliases, and similarity in meaning (the local model, when it is installed). Each candidate is then kept or dropped by comparing what it is about (its title, when it applies, its rules or steps, a section's text) with **what the task changes**: the step's new words, its fields, the component it calls (and "vendor" when that is a vendor) and its table. The words of the flow the task sits in, its component and today's step don't count on their own. A pattern about publishing order events doesn't reach a task that adds SSO to placing an order, though both are about orders.
- With the meaning model (ADR 0132 addendum), an item is kept when it shares **two or more** of those words, or **one of the task's names** (a field or id written like `createdAt` or `paymentId`, an acronym like `POST` or `UTC`). One common word alone ("payment", "request", "status") keeps it only when it is also close in meaning to the task's step (a cosine of 0.65 or more); an item that shares no word is kept only when it is that close. The closeness is read from the vectors the index already has; only the task's step is embedded. Its why says which: "It is about "idempotency" and "key", which this task changes", or "It is close in meaning to the task's step ("…", similarity 0.71)". Relevance, the list's order, is words and meaning together.
- Without the model (installed with `--omit=optional`, or turned off), one shared word keeps an item, as before, and the task context says "Knowledge matched by words only: the meaning model isn't installed".
- An item whose one word wasn't enough still appears when its pages disagree with an item the task keeps, so the task sees both sides.
- An item that names the component the task calls or the table it stores in is kept on that alone. Naming the task's flow, component or files whole raises it, and its why says so ("It names forge-orders, where this task works").
- An item the change confirmed ranks higher and needs only a word in common with the task. An item it excluded never appears, nor do the sections of the page it was read from.
- A wiki section an item was read from is shown through that item, not again on its own.
- At most 8 entries per task.

What each entry shows: the title and kind; the page, section and line (`forge-wiki/sso-setup.md#steps, line 6`) with the page's last update, author and owner when the page or snapshot says (`updated 2026-09-14 by kim, owner Identity team`); the page's title and its copy in the snapshot (`knowledge/snapshots/forge-wiki/2026-10-20/sso-setup.md`); why it applies, naming the task's words it matched and the task's places it names; its steps, rules or decision; the other pages ("Also described on …"); and the pages that disagree.

### Several pages on one topic

Several people may have written pages on the same thing. They are one entry, never several:

- the pages an item was read from and is also described on, and
- items that are near-duplicates of each other (the same kind, and nearly the same title or the same rules and steps),
- a section headed with every word of an item's title, or whose words are mostly the item's (a draft of a standard, or a copy of it in a team's wiki that has drifted since), and
- two sections of the same page.

The best page leads and the others are listed as "Also described on", in this order:

1. **Current:** a page that is deprecated, superseded or archived ranks below every current page, whatever its source (section 9).
2. **Verified by a person** (the item was reviewed and verified or corrected).
3. **More authoritative:** a standard before a platform's guidance, a framework's documentation, a team's page and reference material (section 9).
4. **Newer** (the page's last update).
5. **Owned:** a page or source with an owner, or in a team's space.
6. **The more specific match:** the page whose section says more of the task's words.

Authority decides only between pages on the same topic. The list itself is ordered by how well each entry matches the task: a loosely related standard never moves above the precise runbook for the task.

A grouped entry says which items it grouped ("Grouped with sso-setup-2: they say the same").

Where you see it:

- **The story file**, under each task: "Knowledge that applies", one line per entry and its "also" pages and disagreements under it.
- **`atticus task context`** (Markdown and `--json`, the MCP tool and `atticus task run`): a "Knowledge that applies" section with each entry's steps, rules or decision quoted in full, so the developer or Copilot has them inline.
- **The hand-down to the repo** (`atticus spec hand-down`): the task's plan.md (Spec Kit) or `.atticus/tasks/<id>.md` (Atticus engine) gets a "Knowledge that applies" section, as the task's story lists it.
- **`knowledge.yaml`** names the tasks whose own selection picked an item (`tasks: [1.1]`); `atticus change knowledge` and the change's Knowledge panel in the app show them. The app's Stories tab shows the story files.
- **The stories stage's prompt** lists each task's standards, how-tos and decisions, so a standard's rule (an SSO token's required claims) becomes that task's criterion.

## 8. Pages that disagree

The scan keeps one item for a topic, with the other pages that state it the same way under "also on", and records each disagreement in `knowledge/scan.yaml`, quoting both pages. The pages' words are data: nothing a page says is followed as an instruction.

**Atticus never picks a page silently.** Once a change or one of its tasks relies on the item, it asks a person once, on the change (`questions/<id>.yaml`, step `knowledge-conflict`). The question quotes both pages, with their owners and last-edited dates when the snapshot has them, and offers each page, or "Both, in different cases" (say which in your own words), with what each choice changes.

The page the question names as **suggested** comes first from what the pages are worth (section 9), read when the question is asked, so a change to `sources.yaml` applies at once:

1. **Status:** one page is current and the others are deprecated, superseded or archived.
2. **Exception:** a less authoritative page records an approved exception to the other (it says "exception" or "waiver", gives an approval such as `WVR-2291`, an ADR or "approved by", and names the other page). It is suggested within its source's scope, and the standard outside it, and the suggestion says it is an exception to which page.
3. **Authority:** one page's source is more authoritative (a standard over a team's page). A standard not updated within its source's `reviewMonths` is said to be possibly out of date.

Otherwise the scan reads, without a model, which page likely owns the topic, by the first of these signals that tells the pages apart. Either way it is only a suggestion:

1. **Replaces:** one page says it replaces the other.
2. **Owner:** one page's owner (its front matter or an "Owner:" line, else its source's owner in `sources.yaml`) is the team that handles the item.
3. **Source kind:** the pages are in different sources, and one source is tagged with the item's kind (`atticus sources tag <source> --kind standards`).
4. **Space:** one page is in that team's space (front matter `space`, else its folder).
5. **Last edited:** both pages say when they were last edited, and one is later.

```sh
atticus questions answer q-0123456789ab --option 1
atticus questions answer q-0123456789ab --text "sso-setup.md for web services, sso-notes.md for batch jobs"
```

**A document never overrides a fact verified from code.** When the pages disagree on a value the code holds (a path such as a redirect URI, a URL, a dotted key such as a config property) and a catalog record verified from code holds one page's value and not the other's, the code settles it. Nobody is asked, and everywhere the conflict shows it says so and cites the fact: "Disagrees, not used (settled by the code: Endpoint forge-orders.get-login-oauth2-code-forge-identity has /login/oauth2/code/forge-identity, verified from code at forge-orders:src/main/resources/application.yml:12)". A bare word (a claim's name such as "email") or a name the catalog uses as an id is never enough; the code holding both values, or neither, settles nothing.

The answer is used from then on. Tasks show the chosen page's words, and the other page as "Disagrees, not used (answered by sam)", or "Applies instead" when the person chose the page the item wasn't read from. The same topic and pages are never asked again, on this change or another, whatever the snapshot's date.

`atticus knowledge conflicts` lists every disagreement, what each page says and who decided: a person (with their question) or the code (the fact), and the suggested page while it waits. `atticus change knowledge <id>` lists those the change relies on and asks the undecided ones; so do the stories stage and `atticus task context`. In the app, a knowledge item and the change's Knowledge panel show the same.

## 9. Many wikis: authority, scope and exports

An organisation has many wikis: enterprise architecture, security, a cloud platform's, framework wikis and a dozen team wikis. `sources.yaml` version 3 (ADR 0132; `atticus upgrade` moves a version 1 or 2 file and changes nothing else) says, for each, how much its word counts and where it applies.

**Authority**, one of five, most first:

| Authority   | For                               | Example                                     |
| ----------- | --------------------------------- | ------------------------------------------- |
| `standard`  | The organisation's own rules      | Enterprise architecture, security standards |
| `platform`  | A shared platform team's guidance | The cloud platform's wiki                   |
| `framework` | A framework's own documentation   | An internal framework's wiki                |
| `team`      | A team's pages (the default)      | The orders team's wiki                      |
| `reference` | Glossaries, notes, drafts         | A data glossary                             |

A source's authority is its default. `byPage` overrides it, or a page's status, by page pattern (as `include` and `exclude` match); the first match wins. An enterprise architecture space holds approved standards next to drafts and meeting notes, and a team wiki may host a runbook the organisation adopted:

```yaml
byPage:
  - { match: ["Drafts/**", "Meeting-notes/**"], authority: reference }
  - { match: ["adopted/**"], authority: standard }
  - { match: ["old/**"], status: archived }
```

Then the page itself: a `status` or label (deprecated, obsolete, superseded, archived), an archived space, or a banner at its top ("Deprecated: superseded by …", "This page is superseded by …"). A page no longer current ranks below every current page. `reviewMonths` says how old a standard may get: one not updated in longer is shown as "may be out of date".

**Scope** (`appliesTo`): a scoped source's pages reach only the tasks whose places fall in it. Any dimension it names may match:

- `systems` and `components`: the catalog's, for where the task's code is and what it calls; a component a target flow creates counts too;
- `platforms`: where the task's components run (a component's `runtime` and its deployments' `platform`); a cloud (`gcp`, `aws`, `azure`) takes in its platforms (`cloud-run`, `gke`, ...);
- `repoTypes`: the repos manifest's `type`;
- `frameworks`: what a repo's facts declare it is built on (ADR 0124 addendum A-framework);
- `newComponents: true`: every task that creates a component the catalog doesn't have yet. The architecture stage's target flow says where a new component runs (`runsOn`: its system, platform, cloud and framework), so "new components are built on GCP" reaches the task that creates one before it exists.

Each attached page says why it applied, with the scope it matched: "Its source openshift-platform applies to platforms openshift: forge-orders runs on openshift". A source without `appliesTo` applies everywhere.

**Restricted pages.** Snapshots are committed to the metarepo, so a page under view restrictions (front matter `restricted: true` or `restrictions`, a Confluence export's restriction marker, a SharePoint page with permissions of its own) is skipped as above the limit, path and reason only, unless the source has `readRestricted: true` because everyone who reads the metarepo may read it.

**Exports, when there is no API.** `confluence-export` reads a Confluence space exported as HTML: each page's place in the space from its breadcrumbs (so `Drafts/**` matches), its last edit and author from the metadata line, its labels, and a restriction marker where the export has one. `sharepoint-export` reads a site's pages saved as HTML (or `.aspx`, or Markdown), with the pages library's metadata exported to a `.csv` beside them: Title, Modified, Modified By, labels or tags, status and `HasUniqueRoleAssignments` (a page with permissions of its own is restricted). Both become Markdown with that metadata as front matter, so everything above applies to them as to any page.

**The same page in two wikis** (the same words, front matter aside) is read once, by the more authoritative source (then the first listed); the copy's snapshot lists it as skipped: "the same page as ea-standards/Standards/Logging-Standard.md, which reads it". A copy someone has edited since is a page of its own, grouped under the original's topic, which leads it.

**Snapshots copy only what changed.** A sync copies the pages new or changed since the source's snapshot before it; an unchanged page is listed in `snapshot.yaml` with `in: <date>`, the snapshot whose folder holds its copy. Keep the snapshot folders a newer one points into. A knowledge scan reads only the pages changed since the last scan, and keeps the items of the others.

**What a scan costs, before it runs:**

```sh
atticus sources estimate             # pages, tokens and model calls per source
atticus sources estimate --source ea-standards --batch-tokens 50000
```

Each call is one prompt to your model (with Copilot, one premium request). `maxPages` caps the pages a scan reads of a source in one run; the rest wait for the next.

**Standards become checks a person accepts.** The scan reads a standard's rules. Each rule of a standard a person confirmed (verified or corrected), on a page whose authority is `standard`, can be proposed as a critic check, citing the page and the item. Nothing is enforced until a person accepts it and the pull request merges:

```sh
atticus standards propose            # proposals/checklists/standards.yaml and .md
atticus standards accept --only std-structured-logging-1
```

A rule that says should or recommended is a risk; any other is a blocking, waivable rule (C3, unchanged).

An example with 12 sources, invented:

```yaml
schemaVersion: 3
wikis:
  - id: ea-standards
    type: confluence-export
    location: ../wikis/ea-standards
    owner: Enterprise Architecture
    authority: standard
    byPage:
      - { match: ["Drafts/**", "Meeting-notes/**"], authority: reference }
    reviewMonths: 18
  - {
      id: security-standards,
      type: markdown-folder,
      location: ../wikis/security,
      authority: standard,
      reviewMonths: 18,
    }
  - id: gcp-platform
    type: markdown-folder
    location: ../wikis/gcp-platform
    authority: platform
    appliesTo: { platforms: [gcp], newComponents: true }
    maxPages: 500
  - {
      id: openshift-platform,
      type: markdown-folder,
      location: ../wikis/openshift,
      authority: platform,
      appliesTo: { platforms: [openshift] },
    }
  - {
      id: anvil-framework,
      type: markdown-folder,
      location: ../wikis/anvil,
      authority: framework,
      appliesTo: { frameworks: [anvil] },
    }
  - {
      id: web-framework,
      type: markdown-folder,
      location: ../wikis/web-framework,
      authority: framework,
      appliesTo: { frameworks: [angular] },
    }
  - {
      id: orders-team,
      type: markdown-folder,
      location: ../wikis/orders,
      authority: team,
      appliesTo: { components: [forge-orders, forge-refund-worker] },
    }
  - {
      id: payments-team,
      type: sharepoint-export,
      location: ../wikis/payments,
      authority: team,
      appliesTo: { systems: [forge-pay] },
    }
  - {
      id: stock-team,
      type: markdown-folder,
      location: ../wikis/stock,
      authority: team,
      appliesTo: { components: [forge-stock] },
    }
  - {
      id: web-team,
      type: markdown-folder,
      location: ../wikis/web,
      authority: team,
      appliesTo: { repoTypes: [angular] },
    }
  - { id: identity-team, type: markdown-folder, location: ../wikis/identity, authority: team }
  - { id: glossary, type: markdown-folder, location: ../wikis/glossary, authority: reference }
```

The app's Sources page shows each source's authority, its page overrides and where it applies; a change's Knowledge panel shows the source of each item's page and its authority; VS Code's Sources list shows the same.

## What it doesn't do yet

- Matching by words still picks "file transfer" items (a file-transfer pattern, its request, a file hub's retirement) for a change about a money transfer, from the model's reading of the brief. Exclude them; no later stage picks them again.
- A how-to that says only "SSO" where the task says "single sign-on" (or the other way round) is still left out: the bundled model rates the two far apart, and the keep test doesn't read glossary aliases yet. Confirm it for the change: it then reaches every task that shares any word with it.
- An answer to a conflict question doesn't rewrite the story files; the next stories run, or `atticus task context`, shows it. A hand-down already in a repo isn't redone either.
- The code settles only a value it holds exactly (a path, URL or dotted key); a disagreement on step order or a claim's name is always a person's question.
- A real document, a diagram and a real repo are still to walk.
- Many wikis (ADR 0132): precision on 12 sources is about 0.58 on the planted pages and 0.51 with 4,800 filler pages with the meaning model (0.50 and 0.34 by words alone, `docs/evidence/many-wikis.md`): pages sharing two common words with a task still attach; a needed standard can still be missed when the search engine doesn't offer it. A Confluence or SharePoint export's restrictions are read only where the export has them. The change's own knowledge list (`knowledge.yaml`, the stages') isn't scoped; each task's is.

`docs/build-status.md` (B2 and B-task-knowledge) has the detail.
