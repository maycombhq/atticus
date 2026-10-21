# 0089. Spec flows draw the steps a person draws, name their callers, and a question is asked once (C1, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0078 (questions as files), ADR 0079 (repo specs), ADR 0088 (lineage across crossings)

## Context

The live dogfood runs of `atticus spec draft` and `atticus spec check` showed three things.

1. **Coarse flows.** On petclinic only 24% of the reference's steps were matched in order. The UI flow for adding an owner started at the service that makes the call, not at the form, so the form's checks and the transform before the call were missed; it ended at "the result goes back", not at the navigation that follows. DTO-to-entity and entity-to-DTO mappings and the entity's own validation were dropped. On NadiEngine, 94 of the 207 findings were `field-from-nowhere`: a field used with no step naming where it came from, usually a missing transform.
2. **Error outcomes as numbers.** The assistant wrote `then: 404`; YAML reads a number, the Flow schema wanted text and refused it, and 32 flows cost a whole retry round.
3. **The same question twice.** `atticus scan survey` and `atticus scan verify` both asked whether the legacy module was still part of the product, as two questions with different ids.

The product owner added: flows don't always start in a UI. Often an external system (a vendor, another organisation's service, a scheduler) calls an API, usually through an external gateway, and that API calls further APIs downstream.

## Decision

**Where a flow starts and ends.** The default spec template, the drafter's prompt and the critic say:

- A flow whose trigger is `action` or `page` starts at the person's action in the component or template (the form, the button; for a page its route or load hook) and ends with what the screen does after the response (navigate, refresh, show the result or an error). Two new advisory critic findings, for those trigger kinds only: `ui-start-not-action` (the trigger's line names no action or page word, and it is the file a call-out is made from, or the flow opens with an `entry`) and `ui-end-missing` (no step after the last call-out cites another file than the call-outs or a line naming what the screen does). No other flow is ever asked for a UI.
- A flow whose trigger is `endpoint`, `listener` or `job` starts at the entry point. Its trigger records **who calls and how the call arrives**: `trigger.caller` (C1, below). It ends with the response or acknowledgement to that caller, after every downstream call-out, event and write in order. When neither code nor config says who calls, that is a question (ADR 0078), not a guess: a new advisory finding `caller-unknown` for endpoint and listener triggers with no caller and no question on file that cites the trigger's line. `atticus spec check` raises it as a question at once, one per component listing its entry points, not after a redraft.
- For every flow, UI or not: every validation layer is its own `validate` step (the form, the request schema, the entity's constraints); a `transform` step wherever data crosses types (form value to request, request to DTO, DTO to entity, entity to DTO, request to event, one API's request to the next one's); field names in `data` at each step. `field-from-nowhere` now says to add the missing transform. The prompt keeps the step budget at usually 4 to 15, with a family standing for near-identical triggers.

**C1, the Flow kind (schema version stays 1):**

- `trigger.caller`, optional: `{ who, ref?, via?, evidence[] }`. `who` in plain words; `ref` the calling Component or System when the catalog has one (spec check checks it exists); `via` the route in (the gateway and its route, or `direct`); `evidence` the config or code that says so (spec check checks each line exists). The drafter writes `caller: { who, ref, via, at }`.
- `what` (trigger and step) and `when` and `then` (errors) accept a YAML number or boolean and keep it as its text (`404` is `"404"`). Nothing else is loosened: an empty string, a list, an object or null is still refused, and the parsed record is the same shape.

Both changes only widen what is accepted, and every file valid before reads the same, so there is no version bump and no migration.

**C6, the spec template and the question file:**

- `SpecTemplate.ui`, optional with defaults: `actionWords`, `pageWords`, `endWords`, the words (matched where a word or a camelCase part starts, letter case aside) by which the UI rules tell a screen's lines. An organisation with its own UI framework lists its own in its repo type's template. The default template's version stays 1: its new words and wording add advisory findings only, and no flow drafted against it stops being valid.
- `Question.alsoAskedBy`, optional: other steps that wait on the question, each with its step, command, run, time and rerun. A question another step raises about the same repo with a cited line in common and a quarter of its words in common (a shared line alone isn't enough: on NadiEngine two questions cite the same line of a brief and ask different things), or near-identical words (what each asks, asides in brackets or between commas and the alternatives after "or" left out, shares three quarters of its words; or the whole questions share seven in ten), reuses the open or answered question on file: the step is added to `alsoAskedBy`, it reads the same answer (`listQuestions` by step includes it), and its command says so ("q-… was already asked by atticus scan survey …; this step waits on the same answer instead of asking again"). The same step asking a reworded question still raises a new one.

## Consequences

- Drafts get the new rules as advisory findings (reported, not handed back), so a coarse draft is still kept and the next draft is told what to add.
- On a metarepo drafted before this, every endpoint and listener flow without a caller gets `caller-unknown`, and `atticus spec check` raises one question per component; answering it (or the next draft naming callers) clears them.
- The UI word lists are a heuristic: a screen line that names none of the words and cites the file its call-out is in is flagged. They are configuration, not code.
- Word similarity can miss a reworded question or join two that differ only in a word outside the subject. On NadiEngine's 15 questions it joins the survey and verify questions about the legacy module and no two questions from different steps that ask different things.
- An entry point the catalog's interfaces show a caller for (NadiEngine's web app calls 101 of its 127 drafted entry points) gets a `caller-unknown` that names the caller for the next draft, and no question; the drafter's prompt lists the calls into the repo.
- Tests use the mock runtime; no test calls a model.
