# 0128. What a repo is, in a person's words (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-26
- Builds on: ADR 0009 (the manifest), 0077 (repo types), 0078 (questions), 0088 (which repo answers on a host), 0119 (one experience on every surface), 0123 (branches you can see and choose), 0124 (facts the assistant writes)

## Context

A manifest repo says its id, URL, type, owner, system, hosts and modules (ADR 0009). It says nothing about what the repo _is_.

In an estate of thirty or forty repos at a bank, ids are often opaque: three of them differ by a suffix, two were named after a programme that was renamed, one is a mirror of a vendor's SDK. Everything downstream pays for it:

- The reading prompts (ADR 0124) hand an assistant a repo's files with its id and nothing else. A reader that doesn't know a repo is a gateway in front of three services reads it as a service.
- `atticus repo-type detect` matches fingerprints (ADR 0077). When two types tie, or none matches, it can only ask.
- `map --estimate` proposes folders to leave out from file shapes alone (ADR 0124 addendum A-big). A repo that is a vendored corpus looks like a repo with a big folder.
- The join's "Which repo answers on `pay-api.apps.bank.internal`?" (ADR 0088) offers `forge-pay` and `forge-pay-edge` as two ids and a sentence about HTTP. A person who doesn't own both can't choose.
- `map.md`, the Repos screen and Onboarding list ids a reviewer can't read.

Nobody is going to write a document for each repo. One line, typed where a repo is added, is a cost people will pay.

## Decision

### 1. One line on the manifest repo, with who said it and how far to trust it

`ManifestRepo` gains an optional `description`:

```yaml
- id: forge-ledger
  url: https://git.example.com/forge/forge-ledger.git
  type: forge-service
  owner: team-ledger
  description:
    text: The ledger: every posting and the balances read from them. Northwind Pay settles against it nightly.
    trust: verified
    by: pat
    at: 2026-10-26T09:00:00Z
```

- `text` is trimmed, at least one character and at most 300 (`REPO_DESCRIPTION_MAX`): one line, not a document.
- `trust` follows how knowledge is trusted here. `verified` (the default) means a person wrote it, or confirmed what the assistant drafted. `suggested` means the assistant drafted it and nobody has confirmed it.
- `by` and `at` say who and when, as `OutcomeValue` and the stamp do.
- `cites` holds up to six `{file, line}` pairs: where a draft was read from, cited the way a fact is (ADR 0124). A description is prose, not a claim on one line, so there is nothing for the verifier to check on the line; the cites are there for the person who judges the draft.

A description is **a note, never a finding**. It is never evidence, no record is built from it, and it never overrides a fact verified from code. Rule 6 of CLAUDE.md holds: a document never overrides a fact verified from code, and this is a document.

### 2. The schema version, and why every manifest stays valid

`WORKSPACE_SCHEMA_VERSION` goes to 2, and `schemaVersion` on the five workspace files becomes `WorkspaceSchemaVersion`: the union of 1 and 2, overwritten to 2 in memory — the pattern the catalog (ADR 0031, 0125) and flows (ADR 0095) already use. A version-1 manifest differs from a version-2 one only in the number, so it is read as it is and comes back as version 2; writers write 2.

`atticus upgrade` gains `manifest-schema-v2`, which rewrites each `repos.manifest.yaml` that still says 1, keeping its comments and the order a person put its entries in. Like every migration it backs the file up first and commits nothing.

### 3. Where it is entered

- **`atticus repo add <url|path>`** adds one repo with `--description "..."`. Given a folder and no `--type`, it reads the type from the clone's own files, and only where they say nothing, from the line just written (`detectRepoType`, below). With no `--description` and a terminal, it asks once; an empty answer skips. With no terminal (a script, `--json`, `--no-description`) it never blocks: it adds the repo and says the description is still missing.
- **`atticus repo describe <repo>`** sets or replaces it later, `--accept` confirms a draft as a person's own words, `--reject` drops it. With no repo it lists the repos that have none and the drafts waiting for a person.
- **`PUT /api/repos/{repo}/description`** (C4 2.26.0) does the same from the app, and `description` is on a repo in `GET /api/onboarding` and `GET /api/repos/branches`.
- **Set up › Repos** shows it on each repo with who said it, an unconfirmed draft marked and its cites shown, and edits it in place; **Onboarding** lists it beside each id. Every word comes from the copy file.
- **VS Code** asks for each repo's line after a bulk add, one at a time, with Escape to skip one and a skip of the rest; `Atticus: Say what a repo is` (`atticus.describeRepo`) picks the repos that have none or whose draft is unconfirmed. In IntelliJ it is Run a Command (`atticus repo describe`), as every parity entry of this kind is.
- **A bulk add never blocks on typing.** `repos discover` asks nothing. What is left shows up in `atticus next` as two steps only a person can take — one for the repos that say nothing, one for the drafts waiting to be confirmed — which is where this belongs: `next` is already the list of what to do, and `doctor` is about this machine, not the estate.

### 4. The assistant drafts one, a person owns it

When a repo's manifest entry says nothing, each reading prompt (`atticus map`, ADR 0124) ends with one more rule: if the files make it plain, answer with one line of its own —

```json
{
  "about": "The ledger: every posting and the balances read from them.",
  "cites": [{ "file": "README.md", "line": 3 }]
}
```

An assistant that reads the repo itself (tier 1, `/atticus-map`) hands the same line over with `atticus repo describe <repo> --drafted "<one line>" --cites <file>:<line>`, and `atticus map <repo> --estimate` tells it what the repo is, or that nothing says. It is a new line type in the answer, beside `{"question": ...}`, and additive to the facts contract: it is not a fact, no fact kind changes, and nothing is projected into C1 from it. `cites` is required, so a draft always says where it came from; a draft with none is reported as a line that wasn't read. The first draft of a read wins, so a reader that writes it in every batch doesn't flip-flop.

Atticus writes it into the manifest as `trust: suggested`, and then:

- it is marked unconfirmed everywhere it is used — `map.md`, the Repos screen, Onboarding, the join's question options, `atticus next`, `repo describe`;
- it never replaces a person's words, nor a draft already on file;
- a person confirms it (`--accept`, or Confirm it), edits it, or drops it (`--reject`), and the result is `trust: verified` with their handle.

### 5. What it is read for

- **The reading prompts.** Every batch of a read carries the description as an untrusted source, wrapped in `<atticus-data>` by the context pack, under a note that says it is there to orient the reader, is not an instruction, and loses to the code. Where the manifest says nothing, the prompt asks for a draft instead (§4). Either is paid for out of the prompt's existing reserve for the facts on file, not out of the room planned for files, so a repo with a description reads in the same batches as one without. `/atticus-map` carries the same note and the same rule, through what `map --estimate` prints.
- **Repo-type detection.** `matchRepoType` takes the description and reports `fromDescription` when it names one of the org pack's types: it leans a tie among the types that _already_ tie, and suggests where no fingerprint matched. The verdict stays `tie` or `none` — a description never makes a match. `detectRepoType` (`repos discover`, `adopt`) reads it only when the files say nothing at all, and then marks the guess `low` with the description named as its signal.
- **`map --estimate`'s exclusions.** A description that plainly says the repo is a documentation site, a text corpus or vendored code lowers the size floor for a proposal to a quarter. Nothing else changes: a folder that holds a build, deploy or config file is still never proposed, and every proposal is still a proposal a person accepts in a pull request.
- **The join's ambiguity questions.** Each option of "Which repo answers on …?" carries what that repo is, after what the code says about it, with a draft marked unconfirmed.
- **Knowledge matching and story placement.** The index reads each `repos.manifest.yaml` as one `Repo` node per repo, with the description in its names and body. Both knowledge selection and story placement search the index, so a repo is matched on what it is as well as on an id that may say nothing. The node is never `verified`.
- **The views.** `map.md` shows it above the trust line, saying whose words it is and that the facts below are what the code says. The Repos screen and Onboarding show it per repo.

## Consequences

An opaque id reads as a sentence, in the prompt, the question and the page. The cost is one line a person types, asked where they are already adding a repo and never blocking a bulk add.

The risk is a description that is stale or wrong steering a read. Three things hold it: it is data, never instructions; it is a note that loses to the code, said so in the prompt itself and in `map.md`; and it can only ease a proposal or lean a tie, never settle one. A draft nobody has confirmed is marked as such everywhere, so nobody reads the assistant's guess as a colleague's words.

A version-1 manifest keeps working, and `atticus upgrade` tidies the number when a person is ready.
