# The rubric for a professional user story

A story is ready for a developer when another developer, who has never seen the conversation that
produced it, can build it, test it and know it is done without asking anything. Each section below
is checked by `atticus bench stories --draft <file>`; the story format is the zod schema
`BenchStory` in `packages/evals/src/story-bench.ts`, and the three reference stories in this folder
are worked examples.

| Section                         | What it holds                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Statement**                   | As a (a real role), I want (one capability), so that (the outcome for that role). One story, one capability.                                                                                                                                                                                             |
| **Context**                     | How the thing works today, with the files and lines it rests on, and the facts a reader needs that the code doesn't say (a standard, a constraint).                                                                                                                                                      |
| **Scope: in**                   | What this story changes, as a list a reviewer can tick.                                                                                                                                                                                                                                                  |
| **Scope: out**                  | What a reader might expect that this story does not do. Everything near the change that stays as it is.                                                                                                                                                                                                  |
| **Changed steps**               | Each place the code changes, in order: repo, what changes, the entry or screen it is on, and the file and line of today's code.                                                                                                                                                                          |
| **Acceptance criteria**         | Given / When / Then, at least one per changed step. Each names the entry it exercises, the fields its Then checks, the validation it relies on, and the outcome.                                                                                                                                         |
| **Error cases**                 | Every way the step can fail, as its own case: the field (if any), the rule (`required`, `format`, `length`, `range`, `limit`, `unique`, `not-found`, `forbidden`, `conflict`, `unavailable`, `other`), the status a caller sees, and what happens. Unchanged errors the change passes through count too. |
| **Interface changes**           | Each entry whose contract changes: added, changed or removed; breaking or additive (and why); each field with side, type, required and default.                                                                                                                                                          |
| **Data changes**                | Each column: table, column, type, nullable, default, the migration (and what existing data needs), classification and retention. When nothing is stored differently, say so and why (`none:`).                                                                                                           |
| **Non-functional: auth**        | Who may do it, and whether that changes.                                                                                                                                                                                                                                                                 |
| **Non-functional: audit**       | What is recorded, or that nothing is and why that is acceptable.                                                                                                                                                                                                                                         |
| **Non-functional: timeouts**    | Timeouts and retries on every call the change adds or relies on.                                                                                                                                                                                                                                         |
| **Non-functional: performance** | The extra work per request (a lookup, an index), and any limit.                                                                                                                                                                                                                                          |
| **Test notes**                  | Which test files gain which cases, next to which existing test.                                                                                                                                                                                                                                          |
| **Dependencies**                | What must happen elsewhere first or together (generated code, a migration run, another service's release). `none` is an answer.                                                                                                                                                                          |
| **Definition of done**          | The checks that close the story.                                                                                                                                                                                                                                                                         |

## Hard rules

- **No invented fields.** Every field a story names in a criterion, an interface change or a data
  change is either new in this story (and then it is in the interface or data changes) or exists in
  the code (the repos' facts or bench references know it). A field that is neither is invented, and
  the scorer fails the draft (exit 1).
- **Cite today's code.** Changed steps, criteria and error cases in a reference story cite the
  file and line of the code they change or rest on. A draft should too; the scorer matches a draft's
  step to a reference step by repo and file (the nearest line wins), or by entry when the draft
  gives no file.

## How a draft is scored

| Measure         | How                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed steps   | Reference steps matched one to one by a draft step in the same repo and file (nearest line first), else the same entry. Draft steps that match none are listed.                                                     |
| Fields          | Reference fields (criteria, interface fields, columns) the draft names anywhere a field is meant, or writes in a Then clause. Case, `_` and `-` aside; the reference's `accepts` lists other names for a new field. |
| Error cases     | Reference error cases, each `(step, field, rule)` counted once, that the draft has on the step it matched. One with no field (`not-found`, `forbidden`, `unavailable`) matches the rule and a word of its when.     |
| Invented fields | Draft field names known to neither the reference story, the bench references of its repos, nor the repos' facts. Must be none.                                                                                      |
| Rubric sections | The 17 sections above present and not empty (`interfaces` and `data` may be `none: <why>`); every changed step has a criterion and at least one criterion has an error case.                                        |

No bar is set yet (ADR 0124 §6: the measure comes before the bar).
