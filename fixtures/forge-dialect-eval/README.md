# Forge Messaging: the dialect build kit evaluation

Everything here is invented. Forge Messaging is a second in-house Forge framework (`messaging.yaml` descriptors, `@QueueConsumer`, `@OnMessage`, `@Emits`, `@RelayClient` and `@RelayCall`, relay client timeouts in config) used to check the M2 exit criterion: a fresh assistant session given only the dialect build kit writes a working dialect for it.

| Path                     | What it is                                                                                 | In the sandbox? |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------- |
| `TASK.md`                | The task statement the assistant gets                                                      | yes             |
| `repos/`                 | Three Forge Messaging apps                                                                 | yes             |
| `expected.yaml`          | Hand-written records a correct dialect produces, per repo, including the held-out repo    | no              |
| `holdout/billing-relay/` | A fourth app the assistant never sees, to catch rules that name the eval repos' values     | no              |

**Running one eval run.** Make an empty folder with `kit/` (from `atticus dialect kit kit`), a copy of `repos/`, `TASK.md` and an empty `org-pack/dialects/`, with `atticus` on the path. Start a fresh session there with only `TASK.md` as the prompt. When it finishes, grade its file from the Atticus checkout: `atticus dialect grade <sandbox>/org-pack/dialects/forge-messaging.yaml fixtures/forge-dialect-eval`. A run passes when the grade says PASS: the dialect is valid, its own tests pass and expect records, and every repo (held-out one included) gives exactly the expected records.

Rules: `expected.yaml` is written by hand; never regenerate it from a dialect's output. The reference solution used by the grader's own tests lives in `packages/assistant-kit/test/reference/` and must never be copied into a sandbox.
