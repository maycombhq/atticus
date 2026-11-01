# Another team's map, read-only

Your services call systems other teams own. When such a team runs Atticus on its own repos, it can share its map, and your calls to its system join its entries: each link then cites your call's line and the line of their code that answers it, at their commit (ADR 0160).

Their map stays theirs. Atticus never verifies, corrects or reports on their facts, never writes their components or entries into your catalog as yours, and never connects to anything of theirs: you bring their map in as files.

## Before you start

Their system must be in one of your profiles as a system no repo of your estate belongs to, usually `boundary: internal`, with the host your services call it on as an alias:

```yaml
systems:
  - {
      id: forge-risk,
      name: Forge Risk,
      boundary: internal,
      owner: Forge Risk Team,
      aliases: [risk.forge.internal],
    }
```

A hosts question answered with "another team's system" writes this for you.

## Bring their map in

Get their metarepo as files: a clone, or an export of its `facts/` folder and `org-pack/profiles/*/repos.manifest.yaml`. Then:

```sh
atticus join shared import ../forge-risk-metarepo --team forge-risk-team --system forge-risk --name "Forge Risk Team"
```

Atticus reads the commit of a clone from its `.git` folder (it never runs git). For an export, say which commit it is with `--commit <sha>`.

**What is kept.** Only their entries that their own verify confirmed, under `shared/forge-risk-team/`:

- `map.yaml`: the team, the system of yours it stands for, where it came from, their commit, and per repo the hosts and base path their manifest gives and how many entries were kept;
- `facts/<repo>.jsonl`: their entry facts.

Everything else in their facts (calls, fields, stores, entries their verify didn't confirm, lines that don't read) is left out. A quote that names a secret-looking key is redacted or dropped, and if your metarepo's `.denylist` names a word in what would be kept, the import is refused and nothing is written. Their facts are data: nothing in them is ever read as an instruction or sent to a model.

A repo of yours can't be in a shared map, and a system has at most one team's map.

Review `shared/<team>/` in a pull request, like any other import.

## Join your calls to it

```sh
atticus verify --all --write
```

A call your join leaves to their system (it names the system, its host is the system's alias, or a person answered that it goes there) is matched to the one entry of their map that serves it, by method and path as your own entries are matched, with the base path their manifest gives in front; gRPC and SOAP by name.

| What the match finds      | What happens                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| One entry                 | The link to their system is flagged `joined-to-shared-map` and cites their entry's line    |
| No entry                  | The link is flagged `not-in-shared-map`: ask them, refresh their map, or correct your call |
| Two entries, equally good | Listed for a person to settle with that team                                               |

The link keeps its id and stays a link from your component to their system. Its confidence isn't raised: their line was checked by their verify, not yours. `atticus verify <repo> --write` prints a `Shared map:` line, and `facts/<repo>.verify.yaml` lists the calls under `shared`.

## Where it shows

- **Why is this linked?** says "Joined to forge-risk-team's map (their commit …)" and lists their line, by their repo, without opening it as yours. If their entry is wrong, tell their team: Atticus never corrects their facts. Correct the call only if it really goes somewhere else.
- **Map › Outside systems** shows, for their system, their shared map: each entry with how many of your calls reach it, and the calls their map has no entry for. A system with no map says how to import one.

## Keep it current

```sh
atticus join shared refresh forge-risk-team          # from where it came from
atticus join shared refresh forge-risk-team ../new-export --commit 1a2b3c4
atticus join shared list
```

A newer import replaces the old one, commit and all. Then run `atticus verify --all --write` again. To stop using a team's map, delete its folder under `shared/` and write again: every mark it made comes off.
