# Head-to-head: OpenSpec, Spec Kit and Atticus (2026-10-25)

The same three feature briefs, on the same pinned bench repos, drafted with each tool's own documented workflow and scored by the stories bench (`atticus bench stories`, `bench/stories/rubric.md`). One Claude (Opus) session acted as the assistant for OpenSpec and Spec Kit; Atticus's drafts are the second stories-bench run (`docs/build-status.md`, B-stories-bench). Nobody opened a reference story before every draft was written and converted.

- **OpenSpec** 1.15.0 (npm `@fission-ai/openspec`): `init --tools claude`, then `/opsx:propose`; all three changes pass `openspec validate --strict`.
- **Spec Kit** (`specify-cli`) 1.2.4.dev0 (installed with `uv tool install` from GitHub): `init --integration claude`, then specify, plan and tasks; the constitution left as the template.
- Fresh clones of the bench repos (tracked files only); brief 3's two petclinic repos side by side in one folder, each tool initialised once there.

## How the other tools' drafts were converted

Their artifacts aren't in the bench's format, so they were converted by rules written before either tool ran (clarifications C1–C6 were added while converting brief 2, before any scoring, and applied to both):

- Only what the artifacts say. One step per (task, code file) where a task says that file changes; "confirm no change" tasks are left out; test files go to `tests`.
- `at` only when a line is given. Neither tool gives lines, so a **sensitivity run** adds `at: <file>:1` to every file a tool named, so the scorer can match by file; its figures are in [brackets].
- One criterion per acceptance scenario, on the step whose code the When exercises. Failure scenarios and explicit failure statements become error cases by a fixed keyword table; a failure statement about a step with no criterion is dropped.
- Interfaces, data, non-functional, tests, dependencies and definition of done copied from the matching sections; `not stated` where the format requires a value.

## Results

| Brief | Tool | Steps | Fields | Errors (strict) | Errors by entry | Invented | Sections |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fastapi due date | OpenSpec | 0/8 [4/8] | 2/5 | 0/5 [0/5] | 0/5 | none | 12/17 |
| | Spec Kit | 0/8 [5/8] | 2/5 | 0/5 [1/5] | 0/5 [1/5] | none | 14/17 |
| | Atticus | 6/8 | 5/5 | 1/5 | 1/5 | none | 17/17 |
| cart limit | OpenSpec | 2/2 | 1/3 | 2/4 | 2/4 | none | 13/17 |
| | Spec Kit | 2/2 | 0/3 | 2/4 [0/4] | 2/4 | none | 13/17 |
| | Atticus | 2/2 | 3/3 | 1/4 | 1/4 | none | 17/17 |
| petclinic microchip | OpenSpec | 0/8 [8/8] | 4/4 | 0/5 [4/5] | 0/5 [4/5] | none | 11/17 |
| | Spec Kit | 0/8 [8/8] | 4/4 | 0/5 [0/5] | 0/5 | none | 14/17 |
| | Atticus | 7/8 | 4/4 | 4/5 | 4/5 | none | 17/17 |
| **Total** | OpenSpec | 2/18 [14/18] | 7/12 | 2/14 [6/14] | 2/14 [6/14] | none | 36/51 |
| | Spec Kit | 2/18 [15/18] | 6/12 | 2/14 [1/14] | 2/14 [3/14] | none | 41/51 |
| | Atticus | 15/18 | 12/12 | 6/14 | 6/14 | none | 51/51 |

Time per brief (wall clock): OpenSpec 1.3–2.3 minutes, Spec Kit 1.0–2.1, Atticus about 5–10 (from file times; the facts pass, done once per repo, excluded). Interventions: OpenSpec and Spec Kit none (OpenSpec recorded four assumptions where its workflow says to ask); Atticus asked three questions, answered the way the other tools assumed.

Five claims per draft checked against the code: OpenSpec 4.5, 4.5, 5 of 5; Spec Kit 4, 4.5, 3 (wrong stack versions from general knowledge: its specify step reads no code); Atticus 5, 4, 3 (three "fields change here" pointer steps at files that don't change).

## What it says

1. **Most of Atticus's lead on steps is citing lines, not reading the code better.** With file-level matching OpenSpec and Spec Kit reach 14–15 of 18 steps against Atticus's 15; on petclinic OpenSpec reaches 8 of 8 against Atticus's 7. Lines matter to a developer and to every later stage (tasks open at the line, a re-read invalidates only what cites a changed file), but the step score alone overstates the gap.
2. **The section score mostly measures fit to a rubric written alongside Atticus.** Atticus's sections are real (it alone covers timeouts, audit and auth throughout), but neither other tool's templates ask for them.
3. **The other tools did better in places.** On the cart limit both kept 2 of 4 error cases against Atticus's 1; Spec Kit's outcomes table for `POST /cart` is the clearest single artifact; OpenSpec gave the tightest developer hand-off and caught a non-obvious exception mapping on petclinic.
4. **Atticus's faults:** it is 3–5 times longer (82 criteria for a one-field feature, criteria repeated per place), and it named places that don't change (`demo.proto:30`, `PetAgeValidator.java:11`, `NamedEntity.java:34`) — over-collected places, fixed after this run (B-run2-fixes).
5. **All three missed a product decision the reference makes** (a past due date refused on create): a brief doesn't settle it, and only a person can.

## Threats to validity

One assistant ran all three tools in a fixed order, so Spec Kit reused what the OpenSpec run had read (its times are understated and its design not independent). The scorer and rubric were written alongside Atticus; the scorer matches steps by file and line, which only Atticus gives. The other tools' drafts were converted by hand under rules that cost them points (one step per task and file, failure statements dropped where no scenario exists, the keyword table). The references encode product choices the briefs don't settle. Three briefs, one run each.

The tools' artifacts, the conversion rules, the drafts and the scores are in the session's scratch folder (`h2h/`), not in the repo.
