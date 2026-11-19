# A metarepo as 2.0.0-beta.28.5 left it, with loose ends whose ids carry no repo

`metarepo/` was made by Atticus 2.0.0-beta.28.5's build (`BUILD_VERSION` 2.0.0-beta.28.1, the
release/b30 line at 39943278, before ADR 0124 addendum E-ids): `atticus init`, three repos read
from facts (their facts snapshots in `catalog/sources/facts/`), `atticus catalog build`, then a
person's decisions and a change, and a second build. Only the assistant files `init` writes
(`.claude/`, `.github/`) and the local `.atticus/` folders were left out. Invented Forge names only.

What it holds, for `packages/cli/test/upgrade-unresolved-ids.test.ts`:

- `c-1`, a call to a deploy token nothing sets, in forge-ledger and forge-payments: one record,
  `unresolved.c-1`, citing forge-ledger's line only. forge-payments' loose call has no record.
- `c-7`, the same in forge-payments and forge-notify, and `c-risk` in forge-ledger: each taken off
  the map by a curated suppress of its old id (`catalog/curated/curateddecision/`).
- `c-solo` in forge-ledger, and forge-notify's listener to a topic nobody publishes
  (`unresolved.forge-notify.on-forge-payments-settled`): one repo each.
- `openspec/changes/rates-from-ledger/change.yaml` touches `unresolved.c-1`, `unresolved.c-solo` and the
  listener's loose end by id.
- `c-token` in forge-payments: a call to `${FORGE_LEDGER_URL}`, which nothing sets, drawn by its
  path to forge-ledger (an Interface flagged `joined-by-path`, inferred). From beta.30 it is asked
  about (ADR 0195, the beta.28.1 addendum's sub-addendum of 2026-11-19).

Every fact id is unique within its repo; `e-0` to `e-7` and `c-join-0` to `c-join-2` are in every
repo, joined by host, so they are no loose ends.
