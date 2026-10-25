# Forge Studio: one repo read the Atticus 2 way

Everything here is invented (CLAUDE.md rule 3). The journeys build a fresh metarepo from it
(`forgeStudioMetarepo` in `packages/journeys/support/app.ts`) the way a team gets one today:
`atticus init`, a manifest naming one repo with its `system:`, the repo cloned into the workspace,
the assistant's facts verified with `atticus verify forge-studio --write`, and one change whose
stages ran through stories and which now waits on its hand-off gate.

| Path | What it holds |
| --- | --- |
| `repo/` | The code: `web/` (an Angular screen and a service that POSTs `/api/notes`) and `api/` (a Spring controller, a JDBC repository and a client that calls a model provider at `llm.vendor.example`) |
| `facts/forge-studio.jsonl` | The facts the assistant wrote, each citing its line. `commit` is `0000000`: the journey writes the clone's commit in its place before verifying |
| `facts/forge-studio.questions.jsonl` | One question the code can't settle (is `llm.vendor.example` production?) |
| `facts/forge-studio.reviewed.jsonl` | Two files read and found to hold no fact |
| `change/add-note-tags/` | The change's stage files: the feature, architecture and stories loops done (`stage/`), and what each stage writes (feature.yaml and feature.md, design.md, stories, tasks.md, requests.md). Its state stays `define`: it waits on its hand-off gate |

The web component's call to `POST /api/notes` joins the api component's entry, so the join gives
the `Create a note` flow its caller. The api's call to `llm` names a system no component is: an
outside system.
