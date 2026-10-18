# M2 exit report

Run on 2026-10-18 on the cloud build machine.

| Criterion                                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden tests for every extractor and ingestor                                                                        | Every built-in extractor (component, OpenAPI, Apigee, Spring, frontend, topics, migrations, infra, dotnet, python, go, node, openshift, gcp, pipelines, access, batch, orm, observability, asyncapi, mainframe), every shipped dialect, and every ingestor (draw.io, Lucid, Visio, Mermaid, images, Markdown, HTML, text, docx, pptx, xlsx, PDF, Figma) has golden tests with hand-written expected output. |
| A fresh session given only the build kit writes a second Forge dialect that passes its tests in at least 4 of 5 runs | **5 of 5** (default model)                                                                                                                                                                                                                                                                                                                                                                                  |
| The same test with a current small, fast model                                                                       | **5 of 5** (Claude Haiku)                                                                                                                                                                                                                                                                                                                                                                                   |

## How the dialect eval was run

Each run got a fresh sandbox holding only: the kit exported with `atticus dialect kit`, a copy of `fixtures/forge-dialect-eval/repos/` (three Forge Messaging apps), `TASK.md` and an empty `org-pack/dialects/`, with `atticus` on the path. A fresh agent session, with no prior context, was told to read only inside its sandbox and given `TASK.md` as the task. Nothing else was provided: no expected records, no held-out repo, no reference solution.

Each resulting dialect was then graded from the checkout with `atticus dialect grade <file> fixtures/forge-dialect-eval`. Grading checks that the dialect is valid C2, that its own tests exist, expect records and pass, and that it produces exactly the 21 hand-written expected records across the three visible repos and the held-out repo `holdout/billing-relay`, which the sessions never saw.

| Run     | Model   | Grade                                   | Own tests |
| ------- | ------- | --------------------------------------- | --------- |
| opus-1  | default | PASS 21/21, precision 1.00, recall 1.00 | 5         |
| opus-2  | default | PASS 21/21, precision 1.00, recall 1.00 | 7         |
| opus-3  | default | PASS 21/21, precision 1.00, recall 1.00 | 7         |
| opus-4  | default | PASS 21/21, precision 1.00, recall 1.00 | 5         |
| opus-5  | default | PASS 21/21, precision 1.00, recall 1.00 | 8         |
| haiku-1 | small   | PASS 21/21, precision 1.00, recall 1.00 | 7         |
| haiku-2 | small   | PASS 21/21, precision 1.00, recall 1.00 | 7         |
| haiku-3 | small   | PASS 21/21, precision 1.00, recall 1.00 | 6         |
| haiku-4 | small   | PASS 21/21, precision 1.00, recall 1.00 | 9         |
| haiku-5 | small   | PASS 21/21, precision 1.00, recall 1.00 | 7         |

The ten dialects are kept in `docs/evidence/m2-dialect-eval/`.

Caveats: the sessions were Claude Code agents. They were instructed, not technically prevented, to stay inside their sandbox; the held-out repo is what guards against rules fitted to the visible repos. Copilot runs inside the client (decisions-pending item 9) remain to be done there.

Two kit gaps the sessions pointed out: `appliesTo.repoTypes` has no guidance on which manifest repo type to use, and evidence `side` for config-derived records is not spelled out. Both go to the kit in M3.
