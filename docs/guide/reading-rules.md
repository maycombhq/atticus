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
schemaVersion: 1
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

## Take another team's rules

`atticus rules import ../payments-metarepo --type fuse-service --team payments --at v1.4` copies their `types/fuse-service.yaml` as it is at that tag into `imported/payments/`, every rule a draft: none is given to a read until you review it and set it active (`atticus rules activate <key> --team payments --type fuse-service`). Reads use the copy, never their repo; `--at` is required, so a copy is always pinned. An update is a new import, reviewed in a PR: a rule you set active stays active when they haven't changed it, and one they changed comes back as a draft. If two teams' copies have an active rule with the same key, the later team's (by name) is given and `atticus rules list <repo>` says so; switch one of theirs off here with `atticus rules off <key> --type fuse-service --reason "..."`.
