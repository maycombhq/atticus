# 0066. Onboarding framework models: the learner first, the assistant for the rest, checks decide

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

A house framework (a starter over Spring, a house JS layer, a library of pipeline templates or Jenkins steps) is read through a framework model (C6, ADR 0054, 0055, 0062). `atticus frameworks learn` reads what code can say: annotations and their `@AliasFor` mappings, wrapper methods whose parameter names say which argument is the method and the path, constants. What code can't say stays empty: the base URL behind a service id (it is in a properties file, a registry or a wiki), a wrapper whose parameters are named `system` and `route`, what `harborDeploy(env: 'prod')` does. Until now a person filled those in by hand, or exported the framework kit to an assistant and brought the file back, and nothing told anyone which frameworks had no model or which models had stopped reading anything. Dialects have had this loop since ADR 0059.

## Decision

**`atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]`** runs the loop for framework models:

1. **Learn**, deterministically: the learners of ADR 0054 and 0055 on the framework's source folder (Java or JS/TS), its JAR or its npm package. A folder with no framework code (a pipeline template repo, a Jenkins shared library) learns nothing and says so. `--users` names the repos that use it; left out, the cloned manifest repos that import its packages.
2. **Draft**: the `framework-drafter` agent (the org pack's, or a built-in default; C5 unchanged) gets the framework kit (README, checklist, the two worked examples, the model's JSON Schema) as instructions, and as data (`<atticus-data>`, through the C5 defences): what was learned and the learner's notes, what the learned model reads in each user repo and the calls whose service has no base URL, how the repos use the framework (the framework survey), excerpts of the framework's files (its `vars/` and templates first) and of the user repos' files that import it or define pipelines, and the current model when this is a re-draft. It is asked for only what the learner couldn't read.
3. **Check**, deterministically:
   - the reply is valid C6 and every entry has a `source` (the schema requires one; a missing one is named);
   - the name is the one asked for;
   - **an entry the learner read from code or bytecode is never changed by a draft.** The draft may leave it out (it is kept) or copy it unchanged; a different value is refused and handed back. An entry the draft adds cites a `document` or a `person`, never `code` or `bytecode`, so it makes inferred facts (rule 6);
   - a draft that adds anything a test can show ships tests, and the merged model's own tests pass and exercise every drafted annotation, client, call and route (ADR 0055);
   - read through the extractors that use models (Spring, the house-framework layer, pipelines, with pipeline models applied), each user repo gives no invalid record and no failed run, and at least one gives something with the model that it doesn't without it (the org pack's other models are applied in both readings, so only this model counts).
     Entries that change nothing in the user repos are reported, not refused (a repo not given may use them). Constants read from code aren't checked one by one: they are facts.
4. **Hand back**: a failed draft and the list of what failed go to the next attempt, as data, up to `--attempts` (default 3).
5. **Propose**: a passing model, learned and drafted entries together, is written to `proposals/frameworks/<name>.yaml` with a header saying how many entries were drafted. The output lists what it reads per repo, which records came from drafted entries, and the drafted entries with their sources, to review first. Nothing scans with a proposal.
6. **Accept**: `atticus onboard accept framework <name>` (or `atticus onboard accept <name>` when no dialect proposal has that name) is a person's approval: the model must be valid and its tests pass; it moves to `org-pack/frameworks/`; `--replace` over a model already there. `atticus onboard check framework <name> --from <source> --users <repos>` runs the same checks on a model written by hand or through a hand-off; with `--from` the learner's entries are laid under it and the proposal is rewritten with both.

The model is whatever `runtime.yaml` allows (`model`, `headless-claude-code`, `replay`; `hand-off` leaves what was learned in the proposal for the person's assistant to add to). With AI off (ADR 0046) or `--no-ai`, the learned model alone is checked and proposed.

**The scan names house frameworks with no model.** Each repo's imports are read (the import lines of its source files; files only), and its own declarations (Java and Kotlin packages, C# namespaces, `package.json` names). A module in the organisation's own namespace (the roots of those declarations: `harbor` in `harbor.orders`, `com.tidewater` in `com.tidewater.cards`, the npm scope `@tide`) that at least two repos import without declaring it is a house framework, grouped as the namespace root and the next part (`harbor.kit`) or the npm package (`@tide/lantern`). One no model's `packages` covers is listed in `EstateScan.unmodelled`, and `atticus scan` prints it with the command to onboard it. Nothing here depends on what the framework is built on, so a heavily customised house framework is named the same way as any other.

**The scan says which models to re-draft.** For each repo that imports a usable model's packages, the repo is read through the extractors that use models with every usable model and without that one; when the two give the same records, `RepoCoverage.redraftFrameworks` lists the model (`reads-nothing`): the framework has moved on under it. `atticus scan` prints the re-draft command. The readings use the scan's own options and cache, so the one with every model is the scan's own when it was cached. A model with failing tests is already left out with a problem (ADR 0055).

**Scans stay deterministic.** The assistant writes models; models make records. No AI runs inside a scan (rule 4), a document or an AI never overrides a fact read from code (rule 6), and a model is used only after a person accepts it.

**The evaluation grades framework onboarding.** A case in `fixtures/onboard-eval` with `kind: framework` names the framework's source (`from`), the repos that use it (`users`) and a reference model; `atticus onboard eval` learns, drafts, and compares what the draft adds to the user repos (records they give with the model and not without) with what the reference adds, as precision and recall. The first case, `harbor-kit`, is an invented Java starter with a wrapper method the learner can't read, base URLs in a properties file and a Jenkins shared-library step, with two user repos and a recorded answer.

No contract changes: C6's framework model is unchanged (proposals live outside the org pack), C5 gains no field, and `EstateScan` and `RepoCoverage` are scanner output, not a contract.

## Consequences

- A house framework is one command and a review away from being read, with the parts code can say verified and the rest marked as drafted.
- The quality of a draft is measured, not trusted, and the learner's facts can't be argued away by an assistant.
- What no file holds (a base URL only a person knows) no draft can read: the assistant must cite where it read a value, and a person confirms the drafted entries.
- Not built: the learner doesn't read pipeline templates or Jenkins shared libraries (the assistant drafts their entries from their files); `services` and `pipeline` entries aren't covered by the model's own tests (ADR 0055 tests read endpoints and calls), only by the user-repo reading; the house-framework signal reads import lines, so a framework used only through configuration or a build plugin isn't named; Python and Go namespaces aren't used to find the organisation's roots; the re-draft signal costs one extra reading per repo for each model it imports (plus the reading with every model, where the cache doesn't hold it); the evaluation has one framework case.
