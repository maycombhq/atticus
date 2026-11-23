# Reading rules your organisation owns

Atticus tells a reader (Copilot, or another assistant) how to read a repo. Your organisation can add to that without waiting for a release: rules in `org-pack/reading-rules/`, reviewed in pull requests like code (ADR 0176).

## Layers

| File                          | For                                                          |
| ----------------------------- | ------------------------------------------------------------ |
| `imported/<team>/<type>.yaml` | every repo of the type: another product team's rules, pinned |
| `org.yaml`                    | every repo                                                   |
| `types/<type>.yaml`           | every repo of the type (the manifest's `type`)               |
| `repos/<repo>.yaml`           | one repo                                                     |

A later layer adds to the earlier ones, and may switch one off for its scope, saying why.

```yaml
schemaVersion: 2
rules:
  - key: path-from-field
    rule: >-
      A call's path is never the field that holds it: follow the field to its
      @Value("${...}") key, write that key as the path, and record the setting.
    files: ["src/main/java/**/*Client.java"]
    example: "src/main/java/forge/refunds/RefundClient.java:42"
    by: "copilot, from 6 repos of type fuse-service; kept by pat on 2026-11-06"
off:
  - key: no-mocks
    reason: "this repo calls the bank's sandbox through a mock"
```

`atticus rules list <repo>` shows what a repo's reads are given, from which layer, and what is switched off.

## Write one

- **By hand**: edit the file, or `atticus rules add --type fuse-service --key path-from-field --rule "..." --files "src/main/java/**/*Client.java" --example src/.../RefundClient.java:42`.
- **With Copilot, for a kind of repo**: `atticus rules draft --type fuse-service` gives Copilot samples of those repos and what their reads keep missing (rejected facts, people's corrections, open questions), and it writes draft rules, each with an example line.
- **With Copilot, for one repo**: `atticus rules draft --repo forge-refunds --about "the refund calls' paths are read as field names"`.
- **From the canvas**: after pairing calls (Connect to…), **Make this a rule for every repo of this type?** drafts one from the pairing.
- **From a note**: `atticus rules notes --type fuse-service` offers the type's notes that read as instructions as drafts.

Drafts aren't given to reads until a person runs `atticus rules activate <key> --type <type>` (or sets `status: active`). A rule with `files` is given to the reads it names by the next `atticus map --all --stale` (a top-up of those files); a rule with no `files` can't be topped up, so it is given by the next whole read (`atticus map <repo> --force`). The repo is not marked stale for such a rule, since only a whole read can give it.

## Try it, then apply it

`atticus rules try forge-refunds --rule path-from-field` runs one small Copilot session on a few files the rule names and shows the facts it would add or change; it writes nothing. Once a rule is active, `atticus map --all --stale` tops up only the files it names in each repo read before it.

## Learn from my corrections

`atticus rules learn`, or **Learn from my corrections** on Map › Decided by AI (ADR 0208), turns the pairings you made on the map into rules, without you confirming each one:

1. It takes every pairing a person made (a corrected AI pairing or a canvas pairing; never the AI's lines or a spread's) that no proven rule names yet, and hands each to your assistant with its cited lines. The assistant adds draft rules to `types/<type>.yaml`.
2. Each draft is re-read on every file its `files` name in each corrected repo (at most 500 a repo), into `facts/.try/`, which is always removed after. The re-read is checked on its lines by the verifier, put with every other repo's facts, and the estate join run without your pairings of those calls.
3. A rule is written `status: active` when the join itself draws each correction it names (the same API, by code: no pairing, answer or guess), no call a person paired, declined or answered changes, and no arrow a person deleted on the canvas could be drawn again. Any other stays a draft with `learned.why`. While a deleted arrow names an end that isn't a repo (a system, a label), no rule is proven.

```yaml
schemaVersion: 2
rules:
  - key: path-from-constant
    status: active
    rule: >-
      A call's path is never the field that holds it: write the path its constant holds.
    files: ["src/main/java/**/*Client.java"]
    learned:
      corrections: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
      by: pat
      at: 2026-11-08T10:15:00.000Z
      proof:
        repos: [forge-billing]
        reread: ["forge-billing src/main/java/forge/billing/PartnerClient.java"]
        reproduced: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
```

A learned rule is given only to the reads of the repos in `proof.repos`; for every other repo of the type it is a draft until Learn proves it there, or a person runs `atticus rules activate <key> --type <type>`, which replaces `learned` with a note that they set it active. A failed draft uses none of its corrections up: the next run asks again. A run with nothing new asks nothing and writes nothing.

**Versions:** `learned` needs `schemaVersion: 2`; Learn moves a file it writes to from 1 to 2 by the number only. Atticus beta.30 refuses a version 2 file whole, so a team upgrades together before anyone runs Learn.

## Take another team's rules

`atticus rules import ../payments-metarepo --type fuse-service --team payments --at v1.4` copies their `types/fuse-service.yaml` as it is at that tag into `imported/payments/`, every rule a draft: none is given to a read until you review it and set it active (`atticus rules activate <key> --team payments --type fuse-service`). Reads use the copy, never their repo; `--at` is required, so a copy is always pinned. An update is a new import, reviewed in a PR: a rule you set active stays active when they haven't changed it, and one they changed comes back as a draft. If two teams' copies have an active rule with the same key, the later team's (by name) is given and `atticus rules list <repo>` says so; switch one of theirs off here with `atticus rules off <key> --type fuse-service --reason "..."`.
