# A library of the estate's own and the services that build on it (invented)

ADR 0192. Everything here is made up: Forge is an invented company, Northwind an invented vendor. `forge-payments-common` is a library the organisation builds and publishes; three services build on it as a dependency, and two of them build on Northwind's SDK too, which nobody in the estate publishes.

| Repo | What it holds |
| --- | --- |
| `repos/forge-payments-common` | A pom with a third-party `<parent>` and its own `<groupId>` `forge.payments`, `<artifactId>` `forge-payments-common`; one dependency on an open-source starter; its own call to Northwind's FX host |
| `repos/forge-ledger` | A single pom depending on the library and on Northwind's SDK, with a `<dependencyManagement>` entry for the library (no dependency) |
| `repos/forge-wallets` | A multi-module Maven repo: an aggregator pom, `wallets-api` (its group from its `<parent>`) depending on the library, and `wallets-batch` depending on it only for its tests (`<scope>test</scope>`) |
| `repos/forge-statements` | A Gradle build: its name in `settings.gradle`, its group in `build.gradle`, and two `implementation` dependencies, the library and Northwind's SDK |

`facts/` holds what a reader writes for each repo, as `/atticus-map` asks (verified against `repos/` in `packages/verify/test/library-deps.test.ts`, `expected/verified.json`). The join (`packages/core/test/facts-deps.test.ts`) draws three `depends-on` links, from `ledger-api`, `statements-api` and `wallets-api` to `payments-common`, none for Northwind's SDK or the open-source starter, none for `wallets-batch`'s test dependency; the library's own call stays the library's. `packages/diagrams/test/hierarchy-depends-on.test.ts` draws them, and `packages/cli/test/ui-api-graph-deps.test.ts` serves them from a metarepo made of this folder's `org-pack/` and `facts/`.

Files here are byte-exact: facts cite their line numbers.
