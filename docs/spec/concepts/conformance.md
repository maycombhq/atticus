# Conformance

Anyone can check an implementation, a plugin or a configuration against this specification
with the conformance suite (`@maycombhq/conformance`, or `atticus conformance <target> --kind
<kind>`). A run lists every check it made, passed, failed or warned; it passes when nothing
failed.

## What it checks

| Kind       | Target                            | Checks                                                                                                                                                                                                                                |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`  | a catalog folder, or a metarepo   | every file is a valid record at the current schema version, in canonical form, at `<generated or curated>/<kind>/<id>.yaml`; ids unique per kind; evidence on every generated record; references that resolve to nothing are reported |
| `org-pack` | an org-pack folder, or a metarepo | every file matches its schema; the cross-file rules hold; every dialect in the pack passes its tests                                                                                                                                  |
| `dialect`  | one dialect rule file             | it matches C2; the dialects it extends are next to it; its tests pass                                                                                                                                                                 |
| `plugin`   | a JavaScript module               | each exported extractor or ingestor has the contract's shape; it runs over a sample repository (or given inputs) with the network blocked; everything it emits is valid C1; two runs at two clock times give identical output         |
| `executor` | an executor file, or a metarepo   | the reference cases of the executor protocol, over the executor's own transport                                                                                                                                                       |

## Determinism

The plugin checks block every way out of the process a plugin could take (fetch, HTTP, sockets,
TLS, UDP, name lookups) and run the plugin twice with the same scan time but a different clock.
A plugin that reaches for the network, or whose output changes with the clock, fails. This
catches accidents, not determined escapes; it is a check, not a sandbox.

## Versions

A report names the specification version it checked against ([VERSION](../VERSION)).
