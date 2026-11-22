# A metarepo as beta.28.5 left it (the upgrade to beta.30)

| File                        | What it holds                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org-flow-v2/`              | The org-flow schema folder beta.28.5 generated (version 2)                                                                                                                                                                                                            |
| `conform-28.5.yaml`         | A stored conformance check as beta.28.5 wrote it (`conform/<repo>.yaml`, no claims)                                                                                                                                                                                   |
| `conform-28.5.latest.txt`   | What `atticus change conform add-fraud-check --latest` printed for it with the CLI built from the tag `v2.0.0-beta.28.5`, on the metarepo `upgrade-b30-operations.test.ts` makes (its standard output; it wrote nothing to standard error). Never regenerate it with a later build |

Everything here is invented: the Forge platform and its services.
