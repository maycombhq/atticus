# 0051. Upgrading a metarepo: atticus upgrade and the metarepo stamp (C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

Atticus will be installed once and then upgraded in place, with no developer on hand. Its readers accept older files, but nothing brought a metarepo's files up to what a new version writes, nothing recorded which version had last done so, and nothing stopped an older install on one laptop from rewriting files a newer install on another had written. Only the catalog had a migration (`atticus catalog migrate`, ADR 0031).

## Decision

- **`.atticus/metarepo.yaml`** (new C4 workspace file, `MetarepoStamp`, committed): the Atticus version that last upgraded the metarepo, when, by whom, and the migrations it has had. `atticus init` writes it.
- **`atticus upgrade [--check | --dry-run] [--by you] [--json]`** runs every migration this Atticus knows whose files are out of date, oldest first. `--check` lists them and exits 1 while any are pending (for CI); `--dry-run` lists them and changes nothing. Before changing anything it copies each file it will change to `.atticus/backups/<time>/` (kept on this machine, git-ignored). Then it writes the stamp and asks the person to commit the changes in a pull request: it never commits.
- **Migrations are code, in order** (`MIGRATIONS` in `packages/cli/src/upgrade.ts`), each with a check for which files it would change and an apply step. Today: catalog records to schema version 2, `.atticus/.gitignore` for this machine's files (ADR 0050), and the metarepo's `.gitignore` for base clones, the index and run folders (never in a repo adopted in place, whose `.gitignore` is the team's). A future schema change ships with its migration here, as CLAUDE.md rule 1 already requires.
- **An older Atticus refuses a metarepo a newer one upgraded**: `atticus upgrade` exits 1 and says which version to install, and `atticus doctor` marks it FAIL. Pending migrations are a doctor warning.

## Consequences

Upgrading at an install is: install the new version (the offline bundle), run `atticus doctor`, run `atticus upgrade`, open a pull request. Mixed versions across a team are caught before they lose work.
