# build.json as beta.28.1 wrote it (ADR 0197)

`build.v1.json` is the Forge golden `build.json` of version 1, as beta.27 to beta.28.1 wrote it for the slots in `fixtures/forge/slots/`. Since beta.28.2 the build writes version 2 (`fixtures/forge/slots/build.json`, the golden `packages/scanner/test/build.test.ts` checks). `packages/scanner/test/slots.test.ts` checks that this file reads as that one and that version 2 gives this file back byte for byte. Kept out of `fixtures/forge/slots/`, which tests copy in as a metarepo's `catalog/sources/`.
