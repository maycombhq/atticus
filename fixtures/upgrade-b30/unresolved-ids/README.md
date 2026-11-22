# A metarepo as 2.0.0-beta.28.5 left it, with loose ends whose ids carry no repo

`metarepo/` was made by Atticus 2.0.0-beta.28.5's own code (`BUILD_VERSION` 2.0.0-beta.28.1, the
release/b30 line at 39943278, before ADR 0124 addendum E-ids): `atticus init`, three repos read
from facts (their snapshots in `catalog/sources/facts/`), `atticus catalog build`, a spec flow
written as `verify --write` writes it, a person's decisions as Atticus writes them (canonical, at
schema version 5), a cross-check dismissal, a survey question, a second build, then a change with
a knowledge gap asked of its owner (`act … ask`). Only the assistant files `init` writes
(`.claude/`, `.github/`) and this machine's folders under `.atticus/` were left out, so the only
step `atticus upgrade` lists for it is the one that names loose ends with their repo. Invented
Forge names only.

What it holds, for `packages/cli/test/upgrade-unresolved-ids.test.ts`:

- `c-1`, a call to a deploy token nothing sets, in forge-ledger and forge-payments: one record,
  `unresolved.c-1`, citing forge-ledger's line only (the merge cites the first repo by id).
  forge-payments' loose call has no record.
- `c-7`, the same in forge-notify and forge-payments, and `c-risk` in forge-ledger: each taken
  off the map by a curated suppress of its old id. forge-payments' listener to a topic nobody
  publishes (`unresolved.forge-payments.on-forge-ledger-refunded`) is taken off the map too.
- `c-solo` in forge-ledger, named by its id in the spec flow
  (`specs/forge-ledger/forge-ledger.read-the-rates.yaml`), the cross-check dismissal
  (`facts/forge-ledger.crosscheck.yaml`) and a survey question's option; and forge-notify's
  listener to a topic nobody publishes (`unresolved.forge-notify.on-forge-payments-settled`).
- `openspec/changes/rates-from-ledger/`: `change.yaml` touches loose ends by id, and the review
  finding `review/design/1/gap-rates-target.yaml`, a knowledge gap of `unresolved.c-1`, was asked
  of its owner: its question, `questions/q-b47c626d92cc.yaml`, has an id made from that record.
- `c-token` in forge-payments: a call to `${FORGE_LEDGER_URL}`, which nothing sets, drawn by its
  path to forge-ledger (an Interface flagged `joined-by-path`, inferred). From beta.30 it is asked
  about (ADR 0195, the beta.28.1 addendum's sub-addendum of 2026-11-19).

Every fact id is unique within its repo; `e-0` to `e-7` and `c-join-0` to `c-join-2` are in every
repo, joined by host, so they are no loose ends.
