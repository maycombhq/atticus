# Forge golden slots (ADR 0195)

The source slots of the invented Forge estate, as the writers write them under a metarepo's `catalog/sources/`. Golden files of the writers' output, reviewed as such; `fixtures/forge/expected/scan.yaml` stays hand-written and stays the oracle.

| File | What it is | Made by |
| --- | --- | --- |
| `readers/<repo>.json` | The readers slot of each repo of `fixtures/forge/repos/`: the readers' records before the merge, at commit `aaaa…` | `pnpm fixtures:slots` (a scan of `fixtures/forge/`) |
| `facts/forge-ledger.jsonl`, `facts/forge-ledger.meta.json` | The facts snapshot and its meta after a successful `atticus verify forge-ledger --write` of `packages/verify/test/fixtures/` at commit `0123abc` | `pnpm fixtures:slots` |
| `legacy/joins.json` | A legacy joins slot: two joined Interfaces and an evidence-less System from `expected/scan.yaml` | By hand, serialized canonically |
| `build.json` | A build manifest naming those three record files and their sources | By hand, serialized canonically |
| `crosscheck/forge-ledger.crosscheck.yaml` | The cross-check's dismissals (`facts/<repo>.crosscheck.yaml`) | By hand, serialized canonically |

`packages/cli/test/forge-slots.test.ts` makes the generated ones again and checks every byte, so regenerating changes nothing; `pnpm fixtures:slots` rewrites them after a review (a reader's output changed). `packages/scanner/test/slots.test.ts` reads every file here and writes it again byte for byte.
