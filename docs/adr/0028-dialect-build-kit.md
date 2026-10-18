# 0028. The dialect build kit

- Status: accepted
- Date: 2026-10-18

## Decision

An organisation's own assistant writes dialects from a self-contained build kit (`@maycombhq/assistant-kit`, exported with `atticus dialect kit`): hand-written guides (workflow, C2 reference checked against the engine, a worked example, a checklist, a ready prompt) plus files generated from contracts C1 and C2 and the command list, so the generated parts can't drift from the code and tests guard the hand-written ones. Three deterministic commands back it: `dialect new` surveys sample repos into a scaffold (deliberately not valid C2 until rules are written), `dialect test` reports per test, and `dialect run` shows the records each rule produces.

The M2 exit check grades a candidate dialect against an invented second framework (`fixtures/forge-dialect-eval`, "Forge Messaging"): it must be valid C2, its own tests must pass and expect records, and it must produce exactly the hand-written expected records from three visible repos and one held-out repo. Fresh sessions get only the exported kit, the visible repos and `TASK.md`.

## Consequences

Kit quality is measured, not assumed; the held-out repo turns "passes on what it saw" into "describes the framework". Engine gaps found and documented as they are: JSONPath `$..key`, `layout.configFiles` precedence, `methodCall.receiverType` and `target: parameter` (to fix in a later ticket).
