# M1 exit report

Measured by `packages/scanner/test/m1-exit.test.ts` (runs in CI on every push) and the Forge tests. Numbers from one Linux run of the cloud build machine, 2026-10-18.

| Criterion                               | Target                | Result                                                                                   |
| --------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| Fixture edges found                     | ≥ 95%, no false edges | 7 of 7 interfaces, no others (`packages/scanner/test/scan.test.ts`)                      |
| Seeded reconcile discrepancies          | all reported          | d01–d06 reported, plus the d07 typo; nothing else (`packages/cli/test/scan-cli.test.ts`) |
| Incremental scan of 300 synthetic repos | < 10 minutes          | 1.3 s scan + 3.7 s index rebuild after a one-repo change; 15 files rewritten             |
| Index size                              | < 2 GB                | 5.1 MB for 3,525 records                                                                 |

First full pass over the 300-repo estate: 5.5 s scan (every built-in extractor and the Forge dialect, then merge), 2.3 s to write 3,525 catalog files, 3.7 s to build the index. 591 interfaces, all verified (both ends seen): 357 direct Forge client calls and 234 Feign calls through the gateway.

What isn't covered yet: facts that come from documents (the vendor's partner spec) wait for intake in M2, so the vendor endpoint is missing from a scan and the vendor call is `inferred` until then.

Found and fixed during the check:

- Two services in one system with no datasource URL both fell back to the store name `<system>-db` and were merged into one database. Merge now splits a store claimed by two owning components into `<owner>-db` per owner, renaming its tables, columns, keys and migrations (ADR 0020).
- The synthetic estate gave Spring Boot apps and batch jobs Forge client annotations, which the Forge dialect rightly ignores in non-Forge repos. They now call through the gateway with Feign, as real Spring apps do, so the estate exercises the Spring extractor, the gateway extractor and gateway resolution in merge.
