# 0147. The house conventions in the org pack, and frameworks taught before the first map

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0012 (the org pack, C6), 0054 (framework models), 0124 (facts the assistant writes; addenda A-framework, A-taught, A-gateway, A-gateway2, A-big, A-read), R1 (verify lists the lines the reader skipped)

## Context

Several lists that are an organisation's conventions, not Atticus's, were written into code:

- the folders an API spec is kept in (`oas/`, `openapi/`, `swagger/`, ...: verify's `API_SPEC`), which keep a big spec counted as code and give its file the route rules;
- the folders of a gateway's proxy bundles (`apiproxy/`, `sharedflowbundle/`: core's `APIGEE_BUNDLE`), whose entries are gateway routes in the estate join, the vendor match and the callers;
- the words that say which side a gateway faces (`FACING_WORDS`), already a `joinFacts` input but never set from the pack;
- verify's framework table (what a build file's declaration means);
- the folders coverage doesn't count (tests, mocks, fixtures: `NOT_PRODUCT`) and the folders R1's skipped-lines note doesn't look in (generated, built, vendored: `notReadForSkipped`).

An organisation whose specs live in `contracts/`, whose tests live in `qa/` or whose proxies sit in another folder had to change code (CLAUDE.md rule 7). And R3: a repo built on a house framework nobody has taught is read as ordinary code the first time, and only verify, after the read, offers `atticus frameworks learn`. Before the first read Atticus had nothing to tell house packages from anyone else's.

## Decision

### 1. `org-pack/conventions.yaml` (C6, new and optional, schema version 1)

A new file, `Conventions` in `packages/core/src/schema/conventions.ts`. Every key is optional and defaults to the list Atticus had in its code, so a pack without the file, or with an empty one, reads exactly as before. A key given replaces its list whole, so a word can be taken out as well as added.

| Key                                                     | Default                                                                                                     | Read by                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apiSpecFolders`                                        | `oas`, `openapi`, `swagger`, `asyncapi`, `api-spec(s)`, `apispec(s)`                                        | verify: big-data check, file kinds (route rules), coverage                                                 |
| `gatewayBundleFolders`                                  | `apiproxy`, `sharedflowbundle`                                                                              | core: `joinFacts`, `joinCallers`, `joinVendorOperations` (`bundleFolders`); verify: `entriesNoFlowFollows` |
| `facing.internal` / `facing.external`                   | the A-gateway2 words                                                                                        | core: `joinFacts` `facing`                                                                                 |
| `frameworks[]` (`declares`, `name`, `topic?`, `shape?`) | none                                                                                                        | verify's framework table, looked at before the built-in one                                                |
| `notProductFolders`                                     | `src/test`, `test(s)`, `__tests__`, `__mocks__`, `spec(s)`, `e2e`, `testdata`, `test-data`, `fixtures`, ... | verify: `isSourceFile` (coverage, batches, re-read)                                                        |
| `notReadFolders`                                        | `generated`, `dist`, `build`, `target`, `node_modules`, `vendor`, ...                                       | verify: the R1 skipped-lines note                                                                          |
| `housePrefixes`                                         | none                                                                                                        | R3, below                                                                                                  |

Folders are names or short paths matched as whole segments anywhere in a path; globs, absolute paths and `..` are refused. Only the folder rules are configurable: the file-name rules (`FooTest.java`, `mvnw`, `package-info.java`, message bundles) stay built in. A framework entry's `topic` must be one of the reading protocol's framework parts to turn rules on; another is dropped, and the entry still names and shapes.

The loader puts it on `OrgPack.conventions` (optional on the type, so a pack built in code needs none; `conventionsOf(op)` gives the defaults). A file that doesn't read is a problem in the pack's load, and the defaults apply. `joinConventions(op)` is what every caller of the estate join spreads into it (scan, verify --write's catalog, measure, the onboarding queue, the prototype comparison). Nothing on disk changes, so `atticus upgrade` has no step. The JSON Schema is generated beside the other org-pack files, and C6's doc has a section.

### 2. R3: house packages warned of before the first read

With `housePrefixes` set (`com.forge.`, `@forge/`), `atticus map <repo> --estimate` reads the repo's code files' import lines (Java, Kotlin, C#, Python, JS/TS, Go; tests, not-read folders and accepted exclusions left out) and lists each house package imported that no taught framework's `packages` covers: the package (the prefix and one more part), how many files import it, the first import, and `atticus frameworks learn <name> --from <its source, JAR or npm package> --package <package>`. `--json` has it as `houseUntaught`. `atticus next`'s map step, for the first repo of the onboarding queue not read yet, says the same in a sentence. A warning, never a stop: nothing is a fact, nothing is written, and the reader may still read.

## Consequences

- An organisation changes these lists in a reviewed file; a test per setting shows each changes what Atticus does.
- The defaults are pinned by a test, so a change to them is deliberate.
- `housePrefixes` needs a person to name them; without, R3 says nothing (the verify-time prompt to learn stays).
- Gateway-bundle detection of a framework fact (`isApigeeBundle`, which also reads the file's root element) keeps its own folder list; it decides only whether a learn command is offered.
