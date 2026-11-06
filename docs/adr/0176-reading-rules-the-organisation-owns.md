# 0176. Reading rules the organisation owns, in layers, written by people or Copilot

- Status: accepted (pending review by the product owner)
- Date: 2026-11-06
- Builds on: ADR 0124 (facts and the verifier), 0163 (org notes), 0167 (rule sets recorded with each read, top-ups), 0171 (Copilot unattended), 0174 (corrections on the canvas)
- Contracts: C6 gains `org-pack/reading-rules/` (`ReadingRulesFile`, schema version 1; no migration, the folder is new); C4 gains `POST /api/reading-rules/from-pairing` (local API 2.55.0); the read plan's `rules.sets` also lists the organisation's rule ids

## Context

How Copilot reads a bank's repos was changed only by an Atticus release: each fix for a house pattern (a path held in a field, a client helper, a gateway's forwarding call) waited for a beta. The developers there know their repos and want to say "read these this way" themselves, by hand or with Copilot, for one repo, for every repo of a kind, or for the whole product, and to take another product team's rules for repos like theirs.

## Decision

1. **Rules are files in the org pack, in layers**: imported (another team's, pinned), the organisation's, the repo type's, the repo's. A later layer adds to the earlier ones and may switch one off for its scope, saying why (`off`, with `builtin:<set>` for one of Atticus's own sets). Each rule has a key, its words, the files it is about (globs), an example line, and who wrote it; a draft isn't given to reads until a person sets it active. Every change is a file reviewed in a pull request.
2. **Reads are given them** after Atticus's own rules: the `/atticus-map` reader (in `atticus map <repo> --estimate`'s text and JSON), the model-mode batches and the top-up sessions. They never change the facts file's shape or the verifier: every fact still cites its line.
3. **A changed rule re-reads only what it names.** A read records each rule's id (`org:<key>@<hash of its words and files>`) beside the built-in sets; `atticus map --all --stale` sees a rule a read lacks and plans a top-up of the files its globs match (ADR 0167's mechanism). A rule with no files goes to the next whole read.
4. **Commands**: `atticus rules list [<repo>]`, `add`, `activate`, `off`, `draft` (Copilot drafts rules for a type from several repos, or for one repo `--about` what was missed, from the rejections, corrections and open questions on file; each a draft), `try` (one small Copilot session on a few files a rule names; shows the facts it would add or change, writes nothing), `import` (another team's type file, pinned at a tag of their metarepo, read from its history; every rule comes in as a draft, given to no read until a person sets it active), and `notes` (a repo type's notes that read as instructions, offered as drafts).
5. **From the canvas**: after a pairing (ADR 0174), "Make this a rule for every repo of this type?" drafts a rule from it in `types/<type>.yaml`.

## Consequences

- A developer improves reading without a release; a reviewer sees each rule, its example and its author in the PR.
- Rules are instructions the organisation reviewed; another team's text enters only as a reviewed, pinned copy, never fetched at read time (scans stay offline).
- A rule can make a reader write more or different facts, never unchecked ones: the verifier is unchanged.
