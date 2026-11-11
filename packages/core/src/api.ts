import { z } from "zod";
import { RunPart, RunRetrieval, RunState, RunSummary, RunTools, RuntimeKind } from "./schema/ai.js";
import { Evidence, RecordId } from "./schema/common.js";
import {
  Commitment,
  Flow,
  FlowCaller,
  FlowData,
  Initiative,
  KNOWLEDGE_KINDS,
  RECORD_KINDS,
  RECORD_SCHEMAS,
  type RecordKind,
} from "./schema/kinds.js";
import { ChangeArtifact, Phase, SOURCE_AUTHORITIES, SourceScope } from "./schema/orgpack.js";
import { Finding, FindingAction, Lens, Severity } from "./schema/review.js";
import {
  AnswerMatch,
  AI_RUNTIMES,
  DECIDE_BARS,
  Question,
  QuestionAsks,
  QuestionRole,
  QuestionScopeLevel,
} from "./schema/question.js";
import { FactCorrection } from "./schema/fact-corrections.js";
import { JOIN_GUESS_FLAGS } from "./facts-join.js";
import { AUDIT_ANSWERS, AuditItem } from "./audit.js";
import { ChangeRepos, GitRef, ManifestRepo } from "./schema/workspace.js";

/**
 * Contract C4, local API. The UI only calls this API and the API only reads and writes
 * files, so anything the UI does can also be done from the CLI or by an assistant.
 *
 * The server listens on 127.0.0.1 only (default port 4321) and every request carries the
 * per-session token Atticus prints at start-up, so other local programs and web pages
 * can't drive it. See ADR 0015.
 */
/**
 * 2.0.0 (ADR 0073): PUT /api/me and GET /api/me/approvals are gone; /api/me is the Git user.
 * 2.1.0 (ADR 0078): the questions API, /api/questions.
 * 2.2.0 (ADR 0084): GET /api/onboarding, for the Onboarding and Dashboard screens.
 * 2.3.0 (ADR 0092): the specs API, /api/specs, for the Flows screen.
 * 2.4.0 (ADR 0094): GET /api/cites, the flow steps and records that cite each line of one file.
 * 2.5.0 (ADR 0095): a change's target flows beside today's, /api/changes/{id}/target-flows.
 * 2.6.0 (ADR 0101): the Product kind in the catalog.
 * 2.7.0 (ADR 0102): knowledge in the app: /api/knowledge (sources, items and their reviews,
 *   the last scan, searching the wikis, saved searches), a change's needs and the org pack
 *   drafted from the wikis.
 * 2.8.0 (ADR 0106): model runs, GET /api/runs and /api/runs/{id}/transcript, and POST /api/runs.
 * 2.9.0 (ADR 0108): a change's picture, GET /api/changes/{id}/map.
 * 2.10.0 (ADR 0109): a change's estimate, GET /api/changes/{id}/estimate.
 * 2.11.0 (ADR 0110): the prompt and response history, GET /api/history and /api/history/{id}.
 * 2.12.0 (ADR 0107 addendum): what a model run's tools were asked and gave back: toolCalls in
 *   GET /api/runs and tools in the transcript; run records are at version 2.
 * 2.13.0 (ADR 0113): files attached to a change, GET and POST /api/changes/{id}/inputs, and
 *   whether a change takes the fast path (fastPath on a change).
 * 2.14.0 (ADR 0114): does the code do what the design says, GET /api/changes/{id}/conformance.
 * 2.15.0 (ADR 0116): how a run's context was retrieved, retrieval in the transcript (the model's
 *   expansion and rerank); run records are at version 3.
 * 2.22.0 (ADR 0124 addendum, the app's six entries): GET /api/trust (the Trust tab), a change's
 *   knowledge.yaml (GET /api/changes/{id}/knowledge, POST .../knowledge/{item}), and `full` in
 *   health (`atticus ui --full`). Additive only.
 * 2.23.0 (ADR 0124 addendum D-app, F3 and B10): the Map with its evidence, a repo's facts as the
 *   Map cites them and a person's correction of one (GET /api/facts/{repo}, POST
 *   .../corrections); a stage tab's critic findings with their options, a comment on one and
 *   the stage's questions (GET /api/changes/{id}/stages/{stage}, POST .../comments). Additive only.
 * 2.24.0 (ADR 0124 addendum B2): a change's knowledge with a title for each item and near-miss
 *   and why each was picked in plain words (title, reason). Additive only.
 * 2.25.0 (ADR 0124 addendum B-change): a change read from its stages' files. In GET
 *   /api/changes/{id}/status, `progress` (the stages done, the phases ahead of the gate and a
 *   sentence), each risk factor's `cites` and the new factors, and in `tests` `matrix` and
 *   `added`; `work` in the cockpit; `flows` in a release's conflict overlap. Additive only.
 * 2.26.0 (ADR 0124 addendum B-task-knowledge): the tasks whose own selection picked a change's
 *   item (tasks), and the pages that disagree with who decided which applies (conflicts, on a
 *   change's knowledge and on a knowledge item). Additive only.
 * 2.27.0 (ADR 0115 addendum, 2026-10-25): a stage tab's finding carries what an assistant
 *   proposed about it (`proposal`: not relevant or fixed, by whom, why), waiting on a person.
 *   Additive only.
 * 2.28.0 (ADR 0128): what a repo is, in a person's words. `description` on a repo in GET
 *   /api/onboarding and GET /api/repos/branches, and PUT /api/repos/{repo}/description, which
 *   sets, confirms or drops it. Additive only.
 * 2.29.0 (ADR 0124 addendum A-framework): what each repo is built on. `frameworks` on a repo in
 *   GET /api/trust — the framework its facts declare, the version as declared, where it is
 *   cited, and the frameworks whose patterns the facts show none of. Additive only.
 * 2.30.0 (ADR 0132): many wikis. A knowledge source's `authority`, `appliesTo` (and in words,
 *   `scope`), `readRestricted` and `maxPages` (and `authority` and `scope` on onboarding's
 *   wikis), and the two export types; a conflict's suggested
 *   page by `status`, `exception` or `authority`; and on a change's knowledge item, its page's
 *   `source` and that source's `authority`. Additive only.
 * 2.31.0 (ADR 0133): a prototype compared with the estate. GET
 *   /api/changes/{id}/prototypes: each prototype attached to the change, its calls placed as
 *   exists, changes, new or vendor, each cited. Additive only.
 * 2.32.0 (ADR 0135): why a link is there and what each count on a repo holds. `joins` on a
 *   graph edge (each call merged into it, how it was joined, verified or not, and its lines at
 *   both ends), and in GET /api/trust the lists behind a repo's counts (`lists`: the facts
 *   rejected, the files not read and excluded, the questions open). Additive only.
 * 2.33.0 (ADR 0140): questions asked in order and routed to their owner. GET /api/questions
 *   lists them in the order to ask (what a change in flight rests on first, then the answers
 *   that join the most calls), with `about` (the changes each rests on, the calls it joins, its
 *   owner team or why it has none) and, with `mine=true`, only the person's teams' (`me`).
 *   Additive only.
 * 2.34.0 (ADR 0141): the estate's freshness, GET /api/trust/fresh — per repo, the facts' commit
 *   against the clone's, the files changed that the facts cite, the facts to read again and carried,
 *   and the command to run, most stale first. It runs read-only local git in the clones (never
 *   the network, never a write). Additive only.
 * 2.35.0 (ADR 0142): the prototype comparison's further differences (`field-enum`,
 *   `header-missing`, `header-required`, `error-missing`, `error-unhandled`, with the difference's
 *   `value` or `status`), and a vendor-group call's `boundary` (`internal`: another team's
 *   system). Additive only.
 * 2.36.0 (ADR 0144): a change's impact, as designed, GET /api/changes/{changeId}/impact (V1);
 *   and a question's checked proposal (`about[id].proposal`) with POST
 *   /api/questions/{id}/answer's `acceptProposal` (Q5). Additive only.
 * 2.37.0 (ADR 0148, plan item P3): the sample audit's precision on Map › Trust,
 *   `TrustRepo.audit` — from `facts/<repo>.audit.yaml`, the facts' and the links' precision with
 *   what was drawn, answered right, wrong and unsure, still open or gone, and a 95% interval —
 *   and GET /api/facts/{repo} gives `verified: sample` for a fact answered right there that still
 *   cites the line the person saw. Additive only.
 * 2.38.0 (ADR 0124 addendum J0/J1 guesses): a link joined by a platform-wide setting, a
 *   setting's folder name or despite an open exposure conflict is a guess: `LINK_HOWS` gains
 *   `platform-setting`, `folder-name` and `conflict`, and a change's impact caller's `guessed`
 *   takes any of `JOIN_GUESS_FLAGS`. Additive only.
 * 2.41.0 (ADR 0153): a question's answer carries `match` (the rule it covers, Q2) and
 *   `proposal` (the assistant's proposal it accepted, Q5); POST /api/questions/{id}/answer takes
 *   `match`; and GET /api/questions' `about[id].owner` can be a change's people (`{ change,
 *   people }`, Q4). Additive only.
 * 2.42.0 (ADR 0149, plan items C4, O4 and P3's follow-up): after a correction, the commands to
 *   run and a preview of the next verify --write (GET /api/facts/{repo}/preview, `line` on a
 *   correction's result); the outside systems (GET /api/outside); and a sample audit drawn and
 *   answered in the app (GET and POST /api/facts/{repo}/audit). Additive only.
 * 2.43.0 (ADR 0156): a change's impact walks up the chain: each item's `chain` (who calls the
 *   callers, each hop with its depth, the callers it calls through, its verdict and owner, and the
 *   guess it rests on), `capped`, and the `upstream` counts. Additive only.
 * 2.44.0 (ADR 0160, plan item O3): another team's map, read-only. A link's join can be `shared`
 *   (`LINK_HOWS`), with `HierJoin.shared` naming the team, their repo, the line and their commit;
 *   an outside system's view gains `shared` (the team's entries, each with the calls that reach
 *   it, and the calls their map has no entry for), and a caller its `entry` and `seen: shared`.
 *   And (J1) a link joined by a Kubernetes Service's bare name with no
 *   cited namespace of the caller's the same is a guess: `LINK_HOWS` gains `service-name`, and
 *   `JOIN_GUESS_FLAGS` `joined-by-service-name`. Additive only.
 * 2.45.0 (ADR 0162, plan item F8): GET /api/questions/{id}/targets, the "Another repo…" picker of a
 *   targets question (every repo of the manifest, read or not, every system of the profiles, every
 *   team in roles.yaml, a team with no system saying the one naming it adds); POST
 *   /api/questions/{id}/answer takes `target` (any of them) with `addSystem` and `name` (a vendor
 *   or a team's system written into the profile, for review) and returns `system`; a question's
 *   `reopened` (question schema 4). Additive only.
 * 2.47.0 (ADR 0164, plan item F7): the contract check on every link. GET /api/contracts (the
 *   Mismatches page: every link checked, each mismatch and unconfirmed difference with both
 *   ends' lines and the mappings it went through); `TrustView.contracts` (the counts, for the
 *   Trust tab); and an outside system's view gains `contracts` (the calls to it against its
 *   newest intaken spec, and which findings that spec brings that the one before didn't).
 *   Additive only.
 * 2.48.0 (ADR 0163): the organisation's terms a repo writes. `terms` on a repo in GET
 *   /api/trust: each term fact's term, value, role and line, with the line giving it its role
 *   and the note it rests on. Additive only.
 * 2.49.0 (ADR 0168): GET /api/questions' `about[id].rule`, for an open targets question whose
 *   calls share a path prefix or host with other open targets questions of its repo: the rule
 *   (`/accounts/**`) one answer could take to cover them all, the questions it covers and their
 *   calls. Additive only.
 * 2.50.0 (ADR 0172): the contract check's counts give `unlinked`, the calls no link starts at.
 *   Additive only.
 * 2.51.0: the questions list gives `counts` by state. Additive only.
 * 2.52.0 (ADR 0173): an unattended Copilot run started from the app: POST /api/copilot-runs,
 *   GET /api/copilot-runs/current, POST /api/copilot-runs/{runId}/stop, and the live events
 *   `copilot-run.state` and `copilot-run.lines`. Additive only.
 * 2.53.0 (ADR 0174): correcting the map on the canvas. GET /api/links/candidates and POST
 *   /api/links/connect (G1, a call paired with an API, a `link` line in the caller's
 *   corrections, and `person` among a link's hows); POST /api/facts/{repo}/corrections/undo;
 *   GET and PUT /api/repos/{repo}/owner (G2); POST /api/declared-links and its undo, GET
 *   /api/boxes/addable, POST /api/boxes, GET /api/boxes/corrections (G3). Additive only.
 * 2.54.0 (ADR 0175): GET /api/graph/views and PUT /api/graph/views/{name}, a canvas's named
 *   filters and layers kept in the metarepo; GET /api/code-link, a cited line's file to open in
 *   an editor. Additive only.
 * 2.55.0 (ADR 0176): POST /api/reading-rules/from-pairing, a draft reading rule for the repo's
 *   type from a call a person paired. Additive only.
 * 2.56.0 (ADR 0173, review): GET /api/copilot-runs/current takes `tail` (each tab's last lines,
 *   200 by default; 0 for all) and GET /api/copilot-runs/{runId}/tabs/{tab}?from=N gives a tab's
 *   lines from a line on; GET /api/links/candidates says `why: unverified` on noCalls and noApis
 *   for a repo whose facts aren't all verified; PUT /api/graph/views/{name} replaces a view kept
 *   already only with `replace=1` (409 otherwise). A changed file is 409 on every write.
 * 2.57.0 (ADR 0178): GET /api/links/candidates gives each call its likeliest APIs (`suggestions`,
 *   at most three) and `confident` on a sure one; an API carries `words` (an operationId) and a
 *   gateway route `forwards`; more ways a call is matched (its settings filled in, a version
 *   prefix, the operation's name, what a route forwards to). Additive only.
 * 2.58.0 (ADR 0179): GET and POST /api/changes/{changeId}/sketch, a change drawn on the canvas
 *   stroke by stroke into its target flows. Additive only.
 * 2.59.0 (ADR 0178, part 2): GET and POST /api/links/match, Copilot's proposed pairings of box
 *   A's calls with box B's APIs, checked and never written by the session. Additive only.
 * 2.60.0 (ADR 0180): GET /api/component-types, the organisation's component types (Atticus's
 *   built-ins with the org pack's own, reworded and switched-off ones applied), each with how
 *   the canvas draws it, its signals, what it must and must not do, and its notes. Additive only.
 * 2.61.0 (ADR 0036 addendum, review): a run's view carries `taskRun`, the task run it is part
 *   of (its state, notes, worktree, last build log and commit); POST /api/runs/{runId}/done on a
 *   task run's hand-off builds, fixes and commits as `atticus handoff done` does. Additive only.
 * 2.62.0 (review): PUT /api/repos/{repoId}/branches and /description take `was`, what the form
 *   showed; a manifest changed since (a teammate's pull) is 409, never written over. Additive.
 * 2.63.0 (review): GET /api/catalog/{kind} takes `confidence`, so a page counts the verified
 *   records of a large estate by `total` instead of reading them all. Additive only.
 * 2.64.0 (UX review): GET /api/change-types, the org pack's change types for the app's New change
 *   form (POST /api/changes was there; nothing listed what `type` could be). Additive only.
 * 2.65.0 (ADR 0183): POST /api/facts/{repo}/apply runs verify --write; GET and POST
 *   /api/propose list what a kind of work changed and, on the person's yes, push it to a branch
 *   and open the PR. Additive only.
 * 2.66.0 (UX review, round 35): POST /api/runs/handoff prepares a step for the person's own
 *   assistant (201 with its run) where no model is configured; POST /api/propose/bring-in
 *   brings in what merged; a proposal takes the branch it was shown; a hand-off's ChangeDetail
 *   carries its `notes`. Apply, Propose and Bring in answer 202 with a job (an editor panel
 *   waits 30 s for one answer). Additive only.
 * 2.67.0 (UX review, 2026-11-08): the knowledge gaps' owner questions answered in the app:
 *   GET /api/owner-questions and POST /api/owner-questions/{id}/answer (writing
 *   catalog/curated/ownerquestion/<id>.yaml, as atticus questions owner); ProposeScope adds
 *   owner-answers and baseline. POST /api/initiatives, POST /api/initiatives/{initiativeId}/plan
 *   and POST /api/commitments/{commitmentId}/status start, plan and record initiatives as the
 *   signed-in person (as atticus initiative new|plan|commit); a commitment's status carries its
 *   latest note; ProposeScope adds initiatives and outcomes, and (UX re-walk) work, everything
 *   the app's work writes. POST /api/changes/{changeId}/prototypes compares a prototype and
 *   attaches it, as change attach --prototype (GET adds `candidates`); PUT
 *   /api/service-desk/{changeId}/fields fills a draft's fields in snow.md, 409 if it changed
 *   since read (GET requests carry `file` and `sha256`); ProposeScope adds service-desk; POST
 *   /api/runs and /api/runs/handoff accept `--source <wiki>` on knowledge scan and find.
 *   Additive only. Round 37: a job's kind may be `local` (Apply, Propose, Bring in), and a
 *   proposal plan's file says when it is already `proposed`.
 * 2.68.0 (review round 41): one AI step and one local step at a time. POST /api/runs answers 409
 *   while another AI step runs on the server, and POST /api/facts/{repo}/apply, POST
 *   /api/propose and POST /api/propose/bring-in answer 409 while another local step (Apply,
 *   Propose, Bring in) runs; each problem names the job that runs. Additive only.
 * 2.69.0 (sixth UX walk, screens): a task in GET /api/changes/{changeId}/tasks carries
 *   `taskRun`, where its Run with AI stands (drafted, unverified, PR open, waiting), and `run`,
 *   its latest run; POST /api/changes/{changeId}/tasks/{taskId}/pr raises a drafted task's PR on
 *   the person's click (the push and PR the pr level makes, the AI step not run again); GET
 *   /api/propose lists `applyFirst`, the repos whose corrections are newer than their last
 *   Apply. Additive only.
 * 2.70.0 (seventh UX walk, answers and access): a change's artifact in GET
 *   /api/changes/{changeId} carries `written`, whether its file is there (a status of ready or
 *   blocked says what the phase allows, not that the file was written); GET /api/propose lists in
 *   `applyFirst` the repos whose answered map questions are newer than their last Apply too, not
 *   only their corrections. Additive only.
 * 2.71.0 (review round 43): a task's raised PR in GET /api/changes/{changeId}/tasks carries
 *   `taskRun.pr.state`, open, merged or closed as the Git host says it now (asked read-only, with
 *   a short timeout; absent when the host can't say). Additive only.
 * 2.72.0 (seventh UX walk, what's next): GET /api/changes/{changeId}/cockpit's `next` follows
 *   the change's state and gate, never a later stage: a raised hand-off's step is `merge` and
 *   carries `pr`, the PR it waits on (a manual Git host's manual:// placeholder too, which a page
 *   never shows as a link); every task ticked is the state's `handoff`. A manual Git host's
 *   hand-off PR not opened yet is said as a step waiting on a person in `nextStep` and the
 *   `pr-not-merged` reason, never its manual:// URL. Additive only.
 * 2.73.0 (seventh UX walk, release; ADR 0184): POST /api/changes/{changeId}/release-prs raises
 *   one release PR per code repo from change/<id> into its default branch on the person's click,
 *   recorded in repos.yaml (`pr`); POST /api/changes/{changeId}/sync also reads the release PRs
 *   back; the archive gate's blockers add `pr-missing`, `not-synced`, `needs-reading` and
 *   `catalog-stale`, and the readers' drift becomes a note (ADR 0074). Additive only.
 * 2.74.0 (seventh UX walk, setup and stories): a repo in GET /api/repos/branches carries `build`,
 *   its build command from the manifest; PUT /api/repos/{repoId}/build sets or clears it, and PUT
 *   /api/orgpack/owner sets who looks after the org pack (pack.yaml's owner), each on a person's
 *   click and written to the file the person then proposes; GET and PUT
 *   /api/changes/{changeId}/artifacts/{artifact} take `?file=`, one file of a many-file artifact
 *   (a story under stories/, a spec), so each story can be read and edited. Additive only.
 * 2.75.0 (seventh UX walk, tasks and manual steps): POST
 *   /api/changes/{changeId}/tasks/{taskId}/done ticks or unticks a task in tasks.md on the
 *   person's click; GET /api/changes/{changeId}/tasks ticks a task whose PR merged on the Git host
 *   (once) and says so in `taskRun.ticked`, and a raised PR's number and link are the host's (a
 *   manual host's as the person recorded them); POST /api/todo/{stepId}/done syncs the change's
 *   open hand-off after a Git host step and returns what it said in `synced` (read-only: never a
 *   merge). Additive only.
 * 2.76.0 (eighth UX walk, code against design): POST /api/changes/{changeId}/conformance checks
 *   the code against the design again on the person's click (as atticus change conform), a local
 *   step that answers 202 with its job (409 while another local step runs). The check rests on
 *   facts (rule 4): what a repo's facts don't cover at the branch's commit (files changed since
 *   the read, or a repo read only by the built-in readers) is never `missing`; it is under
 *   `unchecked`, saying it couldn't be confirmed from the code. Additive only.
 * 2.77.0 (eighth UX walk, stage pages and access): GET and PUT
 *   /api/changes/{changeId}/placement, the feature stage's placement (feature.md as the page
 *   shows it, feature.yaml as a person edits it) with who drafted it last (`drafted`: the AI at
 *   the feature stage, or a person's save); a task's `taskRun.marked`, who last ticked or
 *   unticked it by hand on the Task board, so a task Atticus ticked and a person ticked again says
 *   who. Additive only.
 * 2.78.0 (eighth UX walk, hand-off clicks; ADR 0185): a run in GET /api/runs, GET /api/runs/{runId}
 *   and its transcript carries `parts` when it is a batched hand-off (a stage's critic lenses in one
 *   prompt: each lens's name, its own run and that run's state) and `batch` when it is one of those
 *   lenses' own runs (run record version 6). POST /api/runs/{runId}/done on a batch checks each
 *   lens's section on its own and reads in those that pass; a stage's draft Done offers the batch as
 *   its `next`. Additive only.
 * 2.79.0 (ADR 0181 part 4, a change ends at the tech lead or architect): role-owned questions.
 *   GET /api/questions takes `role` (product, architecture, analysis, delivery) and `change` (a
 *   change's questions, wherever they are filed), and says each question's `about.role`,
 *   `counts.byRole` and, with change=, `yourRoles` (the person's roles from change.yaml's owners);
 *   a question file at version 5 may carry `role`. The cockpit says `openQuestionsByRole` and
 *   `yourRoles`. Run all ready tasks: GET /api/changes/{changeId}/tasks/ready and POST
 *   /api/changes/{changeId}/tasks/run-ready, one task run per ready task in cross-repo order as
 *   one job, stopping on the first that needs a person; the click is the approval for draft,
 *   never the pr level; nothing is merged. Additive only.
 * 2.80.0 (ADR 0181, stage drafts: AI-drafted, corrections carried): GET
 *   /api/changes/{changeId}/drafts/{page}, a page's stage drafts with who wrote each last (the AI
 *   with its stage and run, from stage/drafted.yaml, until a person saves it) and the items a
 *   person can correct; GET and POST /api/changes/{changeId}/corrections and POST
 *   .../corrections/{correctionId}/remove, a person's corrections (stage/corrections.yaml), which
 *   the stage's next run reads as the person's word, for the item or every similar one, and marks
 *   applied. A save through PUT .../artifacts/{artifact} or .../placement records who saved it.
 *   Additive only.
 * 2.81.0 (ADR 0181, AI decides first): GET /api/decisions lists the AI's decisions that stand
 *   (pairings flagged `joined-by-ai`, answers `by: { kind: ai, runtime, run }`), with counts split
 *   from code, by a person and by AI, the batches, and whether deciding is on or paused by the
 *   sample audit (with why); POST /api/decisions/correct records a person's correction and spreads
 *   it by a rule (preview first); POST /api/decisions/batches/{batchId}/undo undoes one batch.
 *   `MatchLinksView.decided` says what Atticus applied from a Copilot match; a Question's answer's
 *   `by` may be the AI's, with `batch` and `rule`; a corrections line may carry `ai`, `batch`,
 *   `rule`, `match` and the action `unlink`; TrustRepo.audit gains `ai`; an Interface's evidence
 *   may be `source: ai` with `run`. Additive only.
 * 2.82.0 (ADR 0181, the canvas's Detected by AI layer): a graph join's `how` may be `ai` (a call
 *   the AI paired, its Interface flagged `joined-by-ai`), with the deciding `run`, so the canvas
 *   draws, filters and counts the AI's links apart from the code's and a person's. Additive only.
 * 2.83.0 (ninth UX walk): PUT /api/changes/{changeId}/owners names a change's owners per role
 *   (product owner, architect, business analyst, tech lead) in change.yaml; ChangeDetail gains
 *   `owners`; a Task gains `waits` (the tasks it waits for, `sameRepo` its own repo's) and a
 *   ReadyTasks task `sameRepo`; an OwnerQuestionView may carry `finding` (a critic knowledge gap a
 *   person asked of its owner), and /api/questions leaves those out (they are owner questions).
 *   Additive only.
 * 2.84.0 (ADR 0181, ninth UX walk): AI decides in hand-off mode too. `MatchLinksView.run` is the
 *   hand-off run a Match's brief waits on, and POST /api/links/match/done reads its answer in and
 *   decides from it as the AI's (runtime `hand-off`, with the run); GET and POST
 *   /api/propose-answers hand the open questions to the person's assistant as a hand-off run,
 *   whose Done (POST /api/runs/{runId}/done) decides from its proposals the same way. An AI
 *   decision's runtime may be `hand-off`. `DecideStateView.decideIn` says which runs decide here,
 *   as runtime.yaml allows them; `DecisionCounts.retired` counts retired questions apart;
 *   `DecisionsView.links.lines` counts the standing pairings in the corrections, beside the map's
 *   as last applied. GET /api/settings/ai gives `decide` and `schemaVersion`, and PUT takes
 *   `decide` (lifting a version 3 file to 4). GET /api/upgrade lists the pending upgrade steps and
 *   POST /api/upgrade runs `atticus upgrade` as a local job on the person's click. Additive only.
 * 3.0.0 (ADR 0186, review round 48: writes to shared systems need a person's confirmation). Not
 *   additive: the session token, which `--show-token` prints for assistants and scripts, is no
 *   longer a person's yes. POST /api/confirmations gives the app's page a confirmation for one
 *   write and target (single use, two minutes), and only with the page key the server puts in the
 *   page (<meta name="atticus-page-key">, or ATTICUS_UI_PAGE_KEY from the editor that starts it)
 *   and never prints. These take it as `confirmation` and answer 403 without a valid one: POST
 *   /api/changes/{changeId}/handoff (`handoff`), .../release-prs (`release-prs`),
 *   .../tasks/{taskId}/pr (`task-pr`, `<change>/<task>`), POST /api/propose (`propose`, the
 *   scope), POST /api/todo/{stepId}/run (`step-run`), POST /api/me/digest with send (`digest-send`,
 *   `me`), PUT /api/settings/ai when it changes the provider, keyEnv or an address (`ai-model`,
 *   `model`) and POST /api/settings/ai/test when the model settings differ from HEAD's (`ai-test`,
 *   `model`). POST .../sync merges a ready PR only with one (`merge`); without one it only reads.
 *   keyEnv must be a variable starting ATTICUS_, a model provider's own key variable or a name in
 *   the credential store (422). POST /api/workspace/sync and /api/reconcile answer 409 while one of
 *   their kind runs; GET /api/past-changes?change= and /api/changes/{changeId}/cockpit answer 400
 *   for a change id that isn't one, and /api/view/{name} 404 for a name that isn't a view.
 * 3.1.0 (review round 50, ADR 0186 addendum: nothing the assistant writes stands for the person).
 *   POST /api/runs, and in model mode POST /api/changes/{changeId}/runs and .../tasks/run-ready,
 *   answer 403 unless runtime.yaml sends the model's key where the person last confirmed it (a
 *   confirmed save or Test in the AI settings, or a step they ran in their own terminal; kept
 *   outside the metarepo), or, with none confirmed yet, to a built-in provider's own address.
 *   POST /api/settings/ai/test needs `ai-test` whenever the address isn't the confirmed one, even
 *   when committed. POST /api/me/digest's `digest-send` target is the channel it posts to, read
 *   at the send (GET /api/me gives it as notify.to); `me` is refused. POST /api/runs/{runId}/done
 *   runs only the resume Atticus kept for a step the app prepared (never a file in .runs/), and
 *   only that step's own. POST /api/changes/{changeId}/workspace and .../runs answer 409 while a
 *   sync of a repo's base clone runs elsewhere. Not additive for the digest's target only: the
 *   app's page is updated with it.
 * 3.2.0 (ADR 0187, the Console): everything Atticus is doing or did lately on this metarepo, live,
 * wherever it was started. GET /api/activity lists the app's jobs, a Copilot run, the commands run
 * in a terminal, an editor or a Copilot session (from .atticus/logs/running/), and the hand-off
 * runs that wait for an assistant, newest first; GET /api/activity/{id}/lines?from=n gives one's
 * printed lines from a line on. The live events `activity.changed` and `activity.lines` carry the
 * same. Stop goes through the existing routes (POST /api/jobs/{jobId}/cancel, POST
 * /api/copilot-runs/{runId}/stop); a terminal's run stops in its terminal. A Job gains `title`
 *   and the kind `work` (a request the page waits on, run as a job so the Console shows it: the
 *   critic, a wiki's sync, a step run, a run's Done; their answers are unchanged). Additive only.
 * 3.3.0 (beta.23, Home loads fast): GET /api/setup no longer waits for the machine's checks:
 *   until they finish, its `machine` step has `checking: true` (and `done: false`), and GET
 *   /api/doctor answers when they do; `?machine=wait` waits for them as before. Additive only.
 * 3.4.0 (app-only audit: tasks, release, archive). A Task gains `unmerged` (its branch's commits
 *   the change branch here hasn't), `decision` (a person let its work go, with why) and
 *   `repoBuilds`; POST .../tasks/{taskId}/done answers 409 for a task whose branch has commits the
 *   change branch hasn't, here or on the Git host, unless the body gives a `reason`; POST
 *   .../tasks/{taskId}/build is Build and raise PR (`raise` needs `task-pr`). Build ready, go/no-go
 *   and POST .../release-prs hold while a task branch's work isn't in the change branch.
 *   ChangeDetail's handoff gains `unpushed` and `branch` (its push failed; the branch is kept
 *   here), and POST /api/changes/{changeId}/handoff/push is Push again (`handoff`).
 *   POST /api/propose/upstream sets the upstream Bring in what merged offers, as a local job.
 *   POST /api/scan asks host questions only for repos with facts on file unless `askAll`, and
 *   its job's result says what the readers added, changed and removed (`added`, `changed`,
 *   `removed`) and how many questions it asked (`questions`).
 * 3.5.0 (ADR 0188, a button for every step in the daily path): the local steps the app's pages
 *   named as commands, as the person's click. POST /api/facts/apply-all (`atticus verify --all
 *   --write`), POST /api/estate/join, POST /api/knowledge/sources/sync (every wiki) and POST
 *   /api/workspace/prune (`{ change? }`; uncommitted worktrees kept) run as local jobs (409 while
 *   another local step runs); GET /api/changes/{changeId}/tasks/{taskId}/context gives the task's
 *   context as markdown; PUT /api/history/recording (`{ on }`) is `atticus history on|off`. POST
 *   /api/runs and /api/runs/handoff take `map <repo>` and `change small <change>`, and `--force`
 *   on `plan stories` only (Draft the stories again); a read's Done (POST /api/runs/{runId}/done)
 *   runs `verify <repo> --write` after its last batch and says so in `applied`. Propose's `work`
 *   scope also takes a change's target-flows/ and knowledge.yaml; an answered question a read
 *   raised (rerun `atticus map <repo>`) counts in `applyFirst`. Additive only.
 * 3.6.0 (ADR 0189, a stage is one conversation). GET /api/changes/{changeId}/stages/{stage}/thread
 *   is a stage's thread (proposal, feature, architecture, stories or small): the prompts handed to
 *   the person's assistant, its answers and what their checks said, the critic's findings, the
 *   stage's questions, the person's replies and corrections, and the questions that couldn't be
 *   kept, in order (StageThreadView). POST .../thread is a person's reply (`reply`, which the
 *   stage's next round reads as their answer), a comment on a finding (`finding`), or keeping a
 *   dropped question anyway (`keep`). The server checks a waiting hand-off's answer once its file
 *   is complete, as Done does (Done stays), and says so in the thread. A sketch stroke may be
 *   `retire` (a component taken away). Additive only.
 * 3.7.0 (ADR 0190, set up from the app: "Edit, then Propose"). GET /api/health gains `metarepo`.
 *   GET/POST /api/setup/metarepo create the metarepo in the app's folder with init's code (the
 *   Git host manual, with the metarepo's id when known), POST /api/setup/open starts the app for
 *   another folder. POST /api/setup/repos/plan reads pasted clone URLs or a folder of clones
 *   (repos discover's code) into the repos to add, and POST /api/setup/repos writes them to the
 *   manifest. POST /api/repos/{repoId}/type/detect and PUT /api/repos/{repoId}/type detect and set
 *   a repo's type. GET /api/setup/adapters and PUT /api/setup/adapters/{kind} set runtime.yaml's
 *   outside systems; GET/PUT /api/setup/file is the raw editor of an org-pack file; POST
 *   /api/setup/patterns and /api/setup/sources add an integration pattern and a wiki. Every write
 *   takes `preview` (the lines it would change, nothing written) and answers a FileEditView; the
 *   files are then proposed for review as before. PUT /api/settings/ai's `decide` lifts a
 *   runtime.yaml of any older version to 4 (upgrade's runtime-v4 step), not only a version 3
 *   one. Additive only.
 * 3.8.0 (ADR 0191, roles and the BA): a change goes product owner → architect → business analyst →
 *   tech lead. A question carries what it asks (`asks`, question version 6) and POST
 *   /api/questions/{id}/route moves it to another role (`routed`); GET /api/questions' `about`
 *   gains `asks`. GET /api/findings gives each finding's `asks` and takes `asks=` to filter. GET
 *   /api/changes/{changeId}/owners/suggested suggests owners from roles.yaml (version 3: a team's
 *   `roles`, the file's `defaults`). The cockpit's `waitsOn` names who the change waits on; a
 *   hand-off names the next role's owners as reviewers and tells them through the notify adapter.
 *   GET and POST /api/changes/{changeId}/work-items put the plan's feature, stories and tasks in
 *   the work tracker (manual: a step each; live: `work-items`). POST
 *   /api/owner-questions/{id}/send sends an owner question (`owner-ask`; a critic gap asked with
 *   Ask is one of them). GET /api/ask answers from the organisation's knowledge too
 *   (`knowledge`); GET /api/knowledge/search reads inputs/ when its source has no snapshot; GET
 *   /api/knowledge/passage opens a suggested section inline; a change's knowledge item carries
 *   `passage`. GET, POST /api/changes/{changeId}/stories/shape and POST
 *   .../stories/shape/{entryId}/remove are the business analyst's shaping of the stories.
 *   Additive only.
 * 3.9.0 (ADR 0190, set up from the app, a review's fixes): GET /api/setup/adapters gains
 *   `sha256` (runtime.yaml's, as read) and PUT /api/setup/adapters/{kind} takes it back as
 *   `baseSha256`, so a form read before another edit is refused (409) rather than overwriting it.
 *   The raw editor (GET/PUT /api/setup/file) refuses a name Atticus reads written in another case
 *   (`Runtime.yaml`, 422) and a manifest listing a repo id another profile lists (422); a
 *   runtime.yaml that doesn't parse can be saved over, and new content that doesn't read is 422,
 *   never 500. POST /api/setup/sources refuses a location with a user name or password in it
 *   (422) and a sources.yaml changed meanwhile (409). POST /api/setup/repos/plan for a folder,
 *   with several platforms and none given, answers the platforms to choose from and reads
 *   nothing. Additive only.
 *   Home (beta.23 review): GET /api/changes gives each change the viewer's `yourRoles`
 *   (read from its owners as the questions' `yourRoles` are), so Home knows them for every change
 *   in flight. A `file.changed` live event says whether it can change the catalog (`catalog`),
 *   by the folders the org pack's layout names. Additive only.
 *   An editor panel (beta.23 review): POST /api/runs/{runId}/done takes
 *   `{ job: true }` and POST /api/changes/{changeId}/work-items takes `job: true`: the work runs
 *   as a job (ADR 0187, so the Console shows it), the answer is 202 JobAccepted at once, and the
 *   job's result carries the answer the call gives without it (`answer`) or its problem
 *   (`problem`). The refusals a request can know at once (409, 400, a missing confirmation) still
 *   come as the answer. Without `job` nothing changes. GET /api/activity's entries gain `rev`,
 *   the version of an entry's lines when they are rewritten rather than added to (a hand-off
 *   run's, once Done ran): the page reads them again when it changes. Additive only.
 *   Every daily step (ADR 0188, beta.23 review): nobody is left at a command to type. A step that needs a
 *   repo's base clone this machine doesn't have (Apply, Apply to every repo, the read of a repo)
 *   says what the app offers next: its job's result, or its 422 problem, carries `next: { step:
 *   "sync", repos }`, which the app shows as Sync the repos. POST /api/workspace/sync's result
 *   gives `code` and every line, its errors too. A local job's lines are in the app's words. POST
 *   /api/runs for `map <repo>` runs `verify <repo> --write` after a read that kept every fact
 *   (`applied`), as a read's Done does. A Done's resume runs as a local job (one local step at a
 *   time). Propose for review fails when its branch wasn't pushed. Additive only.
 * 3.10.0 (beta.24, a proxy to a system outside the estate): POST /api/links/corrections, This
 *   whole arrow is wrong: one correction of every call on a link, each in its caller repo's
 *   corrections file (several lines in one write per repo, every item checked before any is
 *   written), with every file, one git command and a verify command per repo. A graph join's
 *   `how` may be `base-path` (a call whose host nothing resolves, joined by the one proxy
 *   BasePath its whole path starts with, `joined-by-base-path`). A link whose first flag is a
 *   guess is never `verified` in its join; a verified link's `how` is its verified call's, and
 *   the guesses other calls it merged rest on are its join's `also`. Repo trust (GET /api/trust) gains `secrets`: a config
 *   file's line that holds what looks like a live secret, its file and line, never its value.
 *   Review of beta.24: POST /api/links/corrections writes all or none (every file held for the
 *   batch, each written whole and renamed; a failure puts back what was written, or answers 500
 *   naming the repos written, `written`), and skips an item whose newest correction on file says
 *   the same (`skipped`), so asked again it writes nothing twice. GET /api/graph/edge-calls gives
 *   every call merged into one edge of a view, not only the 20 the view lists. Additive only.
 *   Review of beta.24 (an answer's words made into boxes): POST /api/questions/{id}/answer takes
 *   `ignore: true` (with an optional `reason`) for a question about where calls go (hosts,
 *   targets, topics, the estate's call-outs): the calls aren't real (CI/CD, a test, a template),
 *   so the join leaves them; words that name no repo, component or system are refused (400) as
 *   such an answer, and a new outside system's name is a short name, never a sentence. GET
 *   /api/trust gains `answerBoxes`, the boxes made from an answer's words, and POST
 *   /api/trust/answer-boxes/ignore and /rename put one right (preview first). Additive only.
 *   A library of the estate's own (ADR 0192): a graph edge may be `depends-on`, a component that
 *   builds on coordinates another repo's build publishes (facts v5's `dependency` and `artifact`),
 *   drawn in the architecture and repo lenses, never merged into calls or their counts; its join's
 *   `how` is `coordinates` and it carries `dependency` (group, name, version, scope), with the
 *   dependency's lines as `caller` and the publishing lines as `callee`. Additive only.
 *
 * 3.11.0 (beta.25, a library's "depends on" arrows, ADR 0192 addendum): a `depends-on` join's
 *   `dependency` carries `facts`, every dependency fact the link rests on (its repo, id, cited
 *   line and every line it rests on), `caller` listing all their lines: This link is wrong marks
 *   each one chosen, so the arrow can't come back from another line. GET /api/graph/edge-calls
 *   gives every join merged into a `depends-on` edge too, not only the 20 a view lists. Facts
 *   version 6: a dependency's `scope` may be `system`. Additive only.
 */
export const API_VERSION = "3.11.0";
export const DEFAULT_PORT = 4321;

// ------------------------------------------------------------------ shared response shapes

/** RFC 9457 problem details, used for every error. */
/**
 * 3.9.0 (ADR 0188): the step the app offers after a refusal or a failed job: Sync the repos
 * whose base clone this machine doesn't have.
 */
export const NextStep = z.object({ step: z.literal("sync"), repos: z.array(z.string()) });
export type NextStepT = z.infer<typeof NextStep>;

export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  /** Field-level problems for 400s. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** For 403s on gated actions: who can act, e.g. "Needs an architect: R. Patel". */
  needs: z.object({ role: z.string(), names: z.array(z.string()) }).optional(),
  /** 3.9.0: what the app offers next, e.g. Sync the repos with no base clone here. */
  next: NextStep.optional(),
});

const Kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);

export const CatalogRecord = z.union(
  RECORD_KINDS.map((k) => RECORD_SCHEMAS[k]) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);

export const RecordPage = z.object({
  items: z.array(CatalogRecord),
  total: z.number().int(),
  /** Pass back to get the next page; absent on the last page. */
  next: z.string().optional(),
});

export const KindCount = z.object({ kind: Kind, count: z.number().int(), stale: z.number().int() });

export const GraphNode = z.object({
  id: RecordId,
  kind: Kind,
  label: z.string(),
  status: z.string(),
  system: z.string().optional(),
});
export const GraphEdge = z.object({
  id: RecordId,
  from: RecordId,
  to: RecordId,
  via: z.string(),
  pattern: z.string().optional(),
  confidence: z.enum(["verified", "inferred", "asserted"]),
  status: z.string(),
});
export const Graph = z.object({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) });

// ------------------------------------------------------------------ hierarchical graph (ADR 0081)

/** The lenses on the one model (plan 4.6). The flow lens arrives with the behaviour hierarchy. */
export const GRAPH_LENSES = [
  "architecture",
  "repo",
  "data",
  "integration",
  "infrastructure",
] as const;
export const GraphLens = z.enum(GRAPH_LENSES);

/** Structure levels: estate → system → repo → component → element. */
export const HIER_KINDS = [
  "estate",
  "system",
  "repo",
  "component",
  "endpoint",
  "topic",
  "client",
  "store",
  "table",
  "deployment",
  "environment",
  "unknown",
] as const;
export const HierKind = z.enum(HIER_KINDS);

/** current only for now; new, changed and retired come with feature views. */
export const HierState = z.enum(["current", "new", "changed", "retired"]);

/** A hierarchy node id: `estate`, or `<kind>:<record id>` (e.g. system:ledger). */
export const HierId = z.string().regex(/^(estate|[a-z]+:[a-z0-9][a-z0-9._-]*)$/);

/** Evidence as the inspector shows it: the file and line (`at`, path:line). */
export const HierEvidence = z.object({
  source: z.string(),
  repo: z.string().optional(),
  at: z.string(),
});

export const HierNode = z.object({
  id: HierId,
  kind: HierKind,
  label: z.string(),
  parent: HierId.optional(),
  /** Children this node has in the lens; 0 means it can't be opened. */
  childCount: z.number().int().nonnegative(),
  state: HierState,
  /** What the catalog is missing here, e.g. inferred, no-repo, no-component, not-in-catalog. */
  gaps: z.array(z.string()),
  evidence: z.array(HierEvidence),
  properties: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  ),
  /** The catalog record behind the node, when there is one. */
  record: z.object({ kind: z.string(), id: RecordId }).optional(),
  /** The command for this node's next step; the app shows it, never runs it. */
  next: z.object({ command: z.string(), why: z.string() }).optional(),
});

export const HIER_EDGE_TYPES = [
  "calls",
  "publishes",
  "subscribes",
  "uses",
  "reads",
  "writes",
  "references",
  "deployed-to",
  // 3.10.0 (ADR 0192): a component builds on a library another repo of the estate publishes.
  "depends-on",
] as const;

/**
 * 2.32.0 (ADR 0135, C1): how a link's call found its callee, from its Interface's flags and via:
 * a person's `answer`, the component (`named`) or `repo` the call names, a `host` the manifest
 * lists, a person who `declared` the caller of a gateway route, a publish heard on its `topic`;
 * or a guess, by its `path` or a host's first `label`. `unknown` when the record doesn't say
 * (written before 2.32.0, or by the built-in readers). 2.38.0 (J0, J1): the guesses a join by
 * host can rest on, a `platform-setting` nobody aimed at the caller, a setting's `folder-name`,
 * or a host or base path an open `conflict` disputes. 2.44.0 (J1): or a Kubernetes Service's
 * short name (`service-name`) the caller's own cited namespace doesn't resolve. 2.82.0 (ADR
 * 0181): or `ai`, a pairing the AI decided (never a person's word; inferred until one corrects or
 * confirms it).
 */
export const LINK_HOWS = [
  // 2.53.0 (ADR 0174, G1): a person paired the call with the entry on the canvas.
  "person",
  "answer",
  "named",
  "repo",
  "host",
  // 3.10.0 (beta.24): a call whose host nothing resolves, by the one proxy BasePath its path
  // starts with (`joined-by-base-path`): code at both ends, not a guess.
  "base-path",
  "declared",
  "topic",
  "path",
  "label",
  "platform-setting",
  "folder-name",
  "conflict",
  "service-name",
  "shared",
  // 2.82.0 (ADR 0181): the AI paired the call, applied by Atticus from its run (`joined-by-ai`).
  "ai",
  // 3.10.0 (ADR 0192): a `depends-on` edge's dependency, joined by the coordinates (group and
  // name) another component's build publishes: code at both ends, never a call.
  "coordinates",
  "unknown",
] as const;
export const HierJoin = z.object({
  /** The catalog Interface the call is. */
  interface: z.string(),
  from: z.string(),
  to: z.string(),
  how: z.enum(LINK_HOWS),
  /** Through one or more gateways (the Interface's via). */
  gateway: z.boolean(),
  /** The Interface is verified: both ends declared, and nobody had to guess the callee. */
  verified: z.boolean(),
  /**
   * 3.10.0 (beta.24 review): on a verified link, the guesses other calls it merged rest on (by
   * path, a platform-wide setting…), to show as "also", never as how the link was made: `how`
   * is the verified call's. Left out when there are none, and on a link that isn't verified.
   */
  also: z.array(z.enum(LINK_HOWS)).optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  /** The caller's lines: the call, and the config that ties it to the host. */
  caller: z.array(HierEvidence),
  /** The callee's lines: the entry that serves it. */
  callee: z.array(HierEvidence),
  /** Each gateway hop's lines, in order. */
  hops: z.array(HierEvidence),
  /** Lines the record doesn't place at either end (a built-in reader's). */
  other: z.array(HierEvidence),
  /**
   * 2.44.0 (ADR 0160): the call is answered by an entry of another team's shared map: the team,
   * their repo, the entry's line and the commit their code is at. Theirs to correct.
   */
  shared: z
    .object({
      team: z.string(),
      repo: z.string(),
      at: z.string(),
      commit: z.string().optional(),
    })
    .optional(),
  /**
   * 2.82.0 (ADR 0181): for a call the AI paired (`how: ai`), the run that decided it, from the
   * call's `source: ai` evidence; what the "Detected by AI" chip links to.
   */
  run: z.string().optional(),
  /**
   * 3.10.0 (ADR 0192): on a `depends-on` edge's join (`how: coordinates`), the coordinates the
   * dependency names and the library publishes, and its scope when not compile. `interface` is
   * then the link's own id (`depends-on:<repo>/<component>><repo>/<component>`, no Interface
   * record), `caller` the dependency's lines in the depending build file, `callee` the lines that
   * publish the coordinates. Left out on a call's join.
   */
  dependency: z
    .object({
      group: z.string(),
      name: z.string(),
      version: z.string().optional(),
      scope: z.string().optional(),
      /**
       * 3.11.0: every dependency fact the link rests on, the first (`caller`'s first line) first:
       * its repo, its id, its cited line (`file:line`) and every line it rests on.
       */
      facts: z
        .array(
          z.object({
            repo: z.string(),
            fact: z.string(),
            at: z.string(),
            lines: z.array(z.string()),
          }),
        )
        .optional(),
    })
    .optional(),
});

/** Parallel edges between the same two nodes of the same type are one edge with a count. */
export const HierEdge = z.object({
  id: z.string(),
  from: HierId,
  to: HierId,
  type: z.enum(HIER_EDGE_TYPES),
  sync: z.enum(["sync", "async", "mixed"]).optional(),
  /** How calls travel (gateway, direct, event-bus...); "mixed" when merged calls differ. */
  via: z.string().optional(),
  count: z.number().int().positive(),
  state: HierState,
  gaps: z.array(z.string()),
  /** Up to five pieces of evidence across the merged edges. */
  evidence: z.array(HierEvidence),
  /**
   * 2.32.0 (ADR 0135, C1): the calls merged into the edge, each with how it was joined and its
   * lines at both ends; at most 20, by Interface id (`count` says how many in all).
   */
  joins: z.array(HierJoin).optional(),
});

const Suggest = z.object({ mode: z.enum(["focus", "group"]), id: HierId.optional() });

/** GET /api/graph/node/{id}: a node, its children (lazy), and its edges inside and out. */
export const GraphNodeView = z.object({
  lens: GraphLens,
  node: HierNode,
  /** Ancestors from the estate down to the node's parent: the breadcrumbs. */
  path: z.array(HierNode),
  children: z.array(HierNode),
  /** Nodes outside this one that its children's edges reach, each lifted to the nearest level. */
  outside: z.array(HierNode),
  edges: z.array(HierEdge),
  /** True when "uses" edges are the transitive reduction (the default; ?all=1 draws all). */
  reduced: z.boolean(),
  /** Edges the reduction left out. */
  hiddenEdges: z.number().int().nonnegative(),
  /** The view is better drawn another way: in focus on a table, or grouped (over 60 nodes). */
  suggest: Suggest.optional(),
});

/** GET /api/graph/focus/{id}: a node and its direct neighbours, with the edges between them. */
export const GraphFocusView = z.object({
  lens: GraphLens,
  node: HierNode,
  path: z.array(HierNode),
  neighbours: z.array(HierNode),
  edges: z.array(HierEdge),
});

/**
 * 3.10.0 (review of beta.24): GET /api/graph/edge-calls: every call merged into one edge of a
 * view, not only the first 20 the view lists, so "All calls on this arrow are wrong" means all.
 */
export const GraphEdgeCallsView = z.object({
  /** The edge's id, as the view gives it. */
  edge: z.string(),
  /** How many it merged in all, as the view's edge says. */
  count: z.number().int().positive(),
  /** Every call merged into the edge, by Interface id. */
  joins: z.array(HierJoin),
});

export const LayoutPosition = z.object({ x: z.number().finite(), y: z.number().finite() });

/** PUT /api/graph/layout/{viewKey}: keep this arrangement. */
export const PutLayoutRequest = z.strictObject({
  lens: GraphLens,
  node: HierId,
  positions: z.record(HierId, LayoutPosition),
});

export const ViewLayoutResult = z.object({
  view: z.string(),
  saved: z.boolean(),
  path: z.string(),
  positions: z.record(z.string(), LayoutPosition),
});

export type GraphLensT = z.infer<typeof GraphLens>;
export type HierKindT = z.infer<typeof HierKind>;
export type HierNodeT = z.infer<typeof HierNode>;
export type HierEdgeT = z.infer<typeof HierEdge>;
export type HierJoinT = z.infer<typeof HierJoin>;
export type HierEvidenceT = z.infer<typeof HierEvidence>;
export type GraphNodeViewT = z.infer<typeof GraphNodeView>;
export type GraphFocusViewT = z.infer<typeof GraphFocusView>;
export type GraphEdgeCallsViewT = z.infer<typeof GraphEdgeCallsView>;

export const Impact = z.object({
  root: RecordId,
  affected: z.array(
    z.object({
      id: RecordId,
      kind: Kind,
      /** Hops from the root to this record. */
      path: z.array(RecordId),
      reason: z.string(),
      owner: z.string().optional(),
      /**
       * 2.84.0 (ADR 0181, ninth UX walk): the record is the AI's (an Interface flagged
       * `joined-by-ai`, or with evidence of source `ai`), with the deciding run when it says.
       */
      byAi: z.boolean().optional(),
      run: z.string().optional(),
    }),
  ),
  /** Facts that would sharpen the answer but are missing: knowledge gaps. */
  gaps: z.array(z.object({ record: RecordId, field: z.string(), question: z.string() })),
});

export const Coverage = z.object({
  areas: z.array(
    z.object({ area: z.string(), known: z.number().int(), expected: z.number().int() }),
  ),
  systems: z.array(
    z.object({
      system: RecordId,
      known: z.number().int(),
      expected: z.number().int(),
      gaps: z.number().int(),
    }),
  ),
});

export const JobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export const Job = z.object({
  id: z.string(),
  kind: z.enum(["scan", "sync", "reconcile", "index", "intake", "step", "local", "work"]),
  state: JobState,
  progress: z.object({ done: z.number().int(), total: z.number().int(), message: z.string() }),
  /** 3.1.0 (ADR 0187): what the job is, in words, for the Console. */
  title: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  errors: z.array(z.string()),
  /** Kind-specific outcome, e.g. scan diff counts. */
  result: z.record(z.string(), z.unknown()).optional(),
});
export const JobAccepted = z.object({ jobId: z.string() });

export const ArtifactStatus = z.object({
  artifact: ChangeArtifact,
  path: z.string(),
  status: z.enum(["blocked", "ready", "done", "not-required"]),
  /** 2.70.0 (seventh UX walk): whether the artifact's file is there at all. */
  written: z.boolean().optional(),
  owner: z.string().optional(),
  openFindings: z.number().int(),
});

export const ChangeState = z.enum([
  "draft",
  "define",
  "design",
  "plan",
  "build",
  "qa",
  "release-ready",
  "released",
  "archived",
  "returned",
  "post-release-review",
]);

export const ChangeSummary = z.object({
  id: RecordId,
  title: z.string(),
  type: RecordId,
  state: ChangeState,
  phaseOwner: z.string().optional(),
  repos: z.array(RecordId),
  openFindings: z.object({
    blocking: z.number().int(),
    gap: z.number().int(),
    risk: z.number().int(),
    idea: z.number().int(),
  }),
  updatedAt: z.string(),
  /** ADR 0113: it takes the fast path, one step from brief to tasks (its type is small, or its brief says so). */
  fastPath: z.boolean().optional(),
  /**
   * 3.9.0 (beta.23 review): the viewer's roles on the change, from its owners (any case, the
   * words people write for a role, roles.yaml's custom roles); empty when it names them nowhere.
   */
  yourRoles: z.array(QuestionRole).optional(),
});

export const ChangeDetail = ChangeSummary.extend({
  /** 2.66.0 (review round 35): what a hand-off said, such as a branch it couldn't push. */
  notes: z.array(z.string()).optional(),
  /** 2.83.0 (ninth UX walk): change.yaml's owners, role id to handles. */
  owners: z.record(z.string(), z.array(z.string())).optional(),
  artifacts: z.array(ArtifactStatus),
  repos: z.array(RecordId),
  workspace: ChangeRepos.optional(),
  handoff: z
    .object({
      phase: Phase,
      pr: z.string().optional(),
      state: z.enum(["none", "open", "merged", "closed"]),
      /**
       * 3.3.0 (app-only audit): the open hand-off's branch is here but not on the remote as it is
       * here (its push failed); POST .../handoff/push is Push again. Absent once it is there.
       */
      unpushed: z.boolean().optional(),
      branch: z.string().optional(),
    })
    .optional(),
});

export const ArtifactContent = z.object({
  artifact: ChangeArtifact,
  path: z.string(),
  content: z.string(),
  /** sha256 of the content; send it back on save to detect concurrent edits. */
  sha256: z.string(),
});

export const Task = z.object({
  id: z.string(),
  repo: RecordId,
  description: z.string(),
  done: z.boolean(),
  story: z.string().optional(),
  branch: z.string().optional(),
  /** The task's latest AI run (2.69.0: its task run's main run, or the one it waits on). */
  run: z.string().optional(),
  /**
   * 2.69.0 (sixth UX walk): where the task's Run with AI stands, from its
   * `tasks/<task>/task-run.yaml`: drafted (built or unverified) and waiting for its PR, the PR
   * open, with the person's assistant, or stopped for a person. Absent before the task first runs.
   */
  taskRun: z
    .object({
      state: z.string(),
      level: z.string(),
      branch: z.string(),
      commit: z.string().optional(),
      pr: z
        .object({
          number: z.number().int(),
          url: z.string(),
          /**
           * 2.71.0 (review round 43): the PR's state as the Git host says it now, asked read-only
           * when the tasks are listed; absent when the host isn't there or didn't answer in time
           * (the record's state stands). Merged or closed, the task can run with AI again.
           */
          state: z.enum(["open", "merged", "closed"]).optional(),
        })
        .optional(),
      /**
       * 2.75.0 (seventh UX walk): when Atticus ticked the task in tasks.md because its PR merged
       * on the Git host (once: a person may untick it after).
       */
      ticked: z.string().optional(),
      /**
       * 2.77.0 (eighth UX walk): who last ticked (done) or unticked the task by hand on the Task
       * board, and when; absent when no person has.
       */
      marked: z.object({ done: z.boolean(), by: z.string(), at: z.string() }).optional(),
      notes: z.array(z.string()),
    })
    .optional(),
  /**
   * 2.83.0 (ninth UX walk): the not-done tasks it waits for before it can run (its stories'
   * dependencies, and the earlier tasks of its own repo in tasks.md order); `sameRepo` names the
   * ones of its own repo. Absent when it waits for none, or once it is done.
   */
  waits: z.object({ tasks: z.array(z.string()), sameRepo: z.array(z.string()) }).optional(),
  /**
   * 3.3.0 (app-only audit): the task branch has commits the change branch here hasn't, so its
   * code isn't in the change yet (its PR raised and merged takes it in). Absent when it has none.
   */
  unmerged: z.object({ commits: z.number().int().positive(), branch: z.string() }).optional(),
  /** 3.3.0: a person decided the task's work isn't needed in the change, and why. */
  decision: z.object({ by: z.string(), at: z.string(), reason: z.string() }).optional(),
  /** 3.3.0: whether the task's repo has a build command now (repos.manifest.yaml). */
  repoBuilds: z.boolean().optional(),
});
export type TaskT = z.infer<typeof Task>;

export const RunView = RunSummary.extend({
  /**
   * 2.78.0 (ADR 0185): a batched hand-off's parts, each a lens with its own run, and that run's
   * state now (left out when its run is gone).
   */
  parts: z
    .array(RunPart.extend({ state: RunState.optional() }))
    .min(1)
    .optional(),
  /** For hand-off runs: the prompt file and the editor workspace to open. */
  promptPath: z.string().optional(),
  workspaceFile: z.string().optional(),
  /**
   * 2.61.0: the task run this run is part of (Run with AI on a task): where it stands, which a
   * run's own state doesn't say (a validated answer whose build fails, a run stopped with Atticus).
   */
  taskRun: z
    .object({
      task: z.string(),
      repo: RecordId,
      level: z.string(),
      state: z.string(),
      branch: z.string(),
      worktree: z.string(),
      notes: z.array(z.string()),
      commit: z.string().optional(),
      /** The last build's log, relative to the metarepo. */
      log: z.string().optional(),
    })
    .optional(),
});

/** ADR 0106: one run in the list of model runs. */
export const RunListItem = RunView.extend({
  /** The round of its step, carried across hand-offs (ADR 0103). */
  attempt: z.number().int().min(1),
  /** Whether an answer is there to read. */
  answered: z.boolean(),
  /** How many problems the checks handed back to this round. */
  handedBack: z.number().int().min(0),
  /** The prompt's size, as the context pack counted it. */
  promptTokens: z.number().int().min(0).optional(),
  /** How many tool calls the run's model made (ADR 0107 addendum). */
  toolCalls: z.number().int().min(0).optional(),
});
export type RunListItem = z.infer<typeof RunListItem>;
/** ADR 0106: the AI step to start on the server: its command words and arguments. */
export const StartStepRequest = z.object({ args: z.array(z.string().min(1)).min(2) });
/** 2.67.0: what Done did: the run, what it printed, and the step's next run when it offers one. */
/**
 * 3.9.0 (review of beta.23): Done's body. `job: true` runs it as a job: 202 and the job's id at
 * once, the job's result `answer` the RunDoneView (or `problem`, refused), so a panel's request
 * never outlasts the build and commit a task run's Done makes.
 */
export const RunDoneRequest = z.strictObject({ job: z.boolean().optional() });
export const RunDoneView = RunView.extend({
  lines: z.array(z.string()).optional(),
  next: z.string().optional(),
  /** 3.5.0 (ADR 0188): the repo a read's last batch put on the map (verify --write). */
  applied: z.string().optional(),
});
/** 3.5.0 (ADR 0188): a task's context, as `atticus task context --markdown` prints it. */
export const TaskContextView = z.object({ markdown: z.string() });
/** 3.5.0 (ADR 0188): this machine's prompt history recording, on or off. */
export const HistoryRecordingRequest = z.object({ on: z.boolean() });
export const HistoryRecordingView = z.object({ on: z.boolean() });
/** 3.5.0 (ADR 0188): the worktrees cleaned up: one change's, or every change's when left out. */
export const PruneRequest = z.object({ change: z.string().optional() });
/** 2.66.0 (UX review): the step prepared for the person's own assistant, and its run. */
export const PreparedStepView = z.object({
  /** Left out when the step had nothing left to hand off: its lines say what it did. */
  runId: z.string().optional(),
  lines: z.array(z.string()),
  /** 2.67.0: the run named is one that still waits for its answer. */
  stillWaiting: z.boolean().optional(),
});
export type StartStepRequest = z.infer<typeof StartStepRequest>;

export const RunList = z.object({
  runs: z.array(RunListItem),
  /** The model this server can run a step with (runtime.yaml adapters.model), or null: then the app offers the step to copy, or Copilot in a VS Code panel. */
  serverModel: z.string().nullable().optional(),
});
export type RunList = z.infer<typeof RunList>;

/** ADR 0106: what one run was asked and answered, and what the checks handed back to it. */
export const RunTranscript = z.object({
  run: RunListItem,
  prompt: z.string(),
  /** The answer, when there is one; text, never markup. */
  answer: z.string().optional(),
  /** The tools the model was offered, each call it made and what it was given back; text, never markup. */
  tools: RunTools.optional(),
  /** How its context was retrieved, when a model helped (ADR 0116): the expansion and the rerank; text, never markup. */
  retrieval: RunRetrieval.optional(),
  handedBack: z.array(
    z.object({
      attempt: z.number().int().min(1),
      problems: z.array(z.string()),
      previousAnswer: z.string().optional(),
    }),
  ),
  /** Every round of the same step, oldest first. */
  rounds: z.array(
    z.object({
      runId: z.string(),
      attempt: z.number().int().min(1),
      state: z.string(),
      startedAt: z.string(),
    }),
  ),
});
export type RunTranscript = z.infer<typeof RunTranscript>;

/** ADR 0110: where a prompt or a response was typed or read. */
export const HistorySurface = z.enum(["claude-code", "vscode", "cli"]);
export type HistorySurface = z.infer<typeof HistorySurface>;
export const HistoryKind = z.enum(["prompt", "response"]);
export type HistoryKind = z.infer<typeof HistoryKind>;
/** ADR 0110: one record's text is kept up to this many bytes; a longer one is cut and marked. */
export const HISTORY_TEXT_MAX_BYTES = 64 * 1024;

/** ADR 0110: one prompt a person sent, or one response they got. Its text is data, never instructions. */
export const HistoryRecord = z.object({
  id: z.string().regex(/^h-\d{14}-[0-9a-f]{6}$/),
  at: z.string(),
  surface: HistorySurface,
  session: z.string().min(1),
  kind: HistoryKind,
  text: z.string(),
  /** The text's size in bytes, as it was given (before it was cut). */
  size: z.number().int().min(0),
  /** The text was longer than HISTORY_TEXT_MAX_BYTES and was cut there. */
  truncated: z.boolean().optional(),
  /** Parts that looked like a secret were masked (***) before it was kept. */
  masked: z.boolean().optional(),
  /** The change it is about, when that can be told exactly: the one change its text names, or the branch change/<id>. */
  change: z.string().optional(),
  /** The slash command, when there is one (/atticus-needs, /stories). */
  command: z.string().optional(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

/** ADR 0110: a prompt with the response that followed it in the same session; either may be missing. */
export const HistoryTurn = z.object({
  session: z.string(),
  surface: HistorySurface,
  at: z.string(),
  change: z.string().optional(),
  prompt: HistoryRecord.optional(),
  response: HistoryRecord.optional(),
});
export type HistoryTurn = z.infer<typeof HistoryTurn>;

/** ADR 0110: whether prompts and responses are being recorded, and what turned it off. */
export const HistoryRecording = z.object({
  on: z.boolean(),
  /** org-pack (runtime.yaml history.record: false) or local (atticus history off). */
  offBy: z.enum(["org-pack", "local"]).optional(),
});
export type HistoryRecording = z.infer<typeof HistoryRecording>;

export const HistoryList = z.object({
  /** Newest first. */
  turns: z.array(HistoryTurn),
  /** How many turns matched before the limit. */
  total: z.number().int().min(0),
  recording: HistoryRecording,
});
export type HistoryList = z.infer<typeof HistoryList>;

export const HistoryEntry = z.object({
  record: HistoryRecord,
  /** The prompt this answered, or the response that followed it. */
  pair: HistoryRecord.optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const RepoView = ManifestRepo.extend({
  platform: RecordId,
  baseClone: z.object({
    present: z.boolean(),
    sha: z.string().optional(),
    dirty: z.boolean().optional(),
  }),
});

/**
 * ADR 0084: what the Onboarding and Dashboard screens show, read from files only: each repo
 * of every manifest, whether its base clone and scan settings are there, and what the last
 * scan wrote for it (counted from the evidence of catalog/generated); and the knowledge sources.
 */
/**
 * 2.28.0 (ADR 0128): what a repo is, in a person's words, as every screen shows it: the line,
 * whether a person wrote or confirmed it (`verified`) or the assistant drafted it and nobody has
 * (`suggested`), who, when, and the lines a draft was read from.
 */
export const RepoAbout = z.object({
  text: z.string(),
  trust: z.enum(["suggested", "verified"]),
  by: z.string().optional(),
  at: z.string().optional(),
  cites: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
});
export type RepoAboutT = z.infer<typeof RepoAbout>;

/** PUT /api/repos/{repo}/description (2.28.0): set or replace the line, confirm a draft, or drop it. */
export const EditRepoDescriptionRequest = z.object({
  /** The line a person typed; left out with `accept` to confirm the draft as it stands. */
  text: z.string().optional(),
  /** Confirm the draft on file as a person's own words. */
  accept: z.boolean().optional(),
  /** Drop the description: nothing then says what the repo is. */
  reject: z.boolean().optional(),
  /** 2.62.0: the line as the form showed it ("" for none); 409 when the manifest says otherwise. */
  was: z.string().optional(),
});

export const OnboardingRepo = z.object({
  id: RecordId,
  platform: RecordId,
  type: RecordId,
  owner: RecordId,
  /** 2.28.0: what it is, in a person's words (ADR 0128); left out when nothing says. */
  description: RepoAbout.optional(),
  /** The manifest file that lists it, relative to the metarepo. */
  manifest: z.string(),
  /** The branch the catalog is read from, and the others scanned beside it (ADR 0123). */
  defaultBranch: z.string().optional(),
  branches: z.array(z.string()).optional(),
  cloned: z.boolean(),
  /** org-pack/scan/<repo>.yaml (ADR 0075). */
  scanSettings: z.object({ path: z.string(), present: z.boolean() }),
  /** Null when no record in catalog/generated cites this repo. */
  lastScan: z
    .object({
      records: z.number().int(),
      kinds: z.record(z.string(), z.number().int()),
      commit: z.string().optional(),
      scannedAt: z.string().optional(),
    })
    .nullable(),
});

export const OnboardingView = z.object({
  manifests: z.array(z.object({ platform: RecordId, path: z.string(), repos: z.number().int() })),
  repos: z.array(OnboardingRepo),
  sources: z.object({
    path: z.string(),
    present: z.boolean(),
    wikis: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        location: z.string(),
        spaces: z.array(z.string()),
        owner: z.string().optional(),
        /** 2.30.0 (ADR 0132): how much its word counts, and where it applies, in words. */
        authority: z.enum(SOURCE_AUTHORITIES).optional(),
        scope: z.string().optional(),
      }),
    ),
    absorbed: z.array(
      z.object({ id: z.string(), url: z.string(), format: z.string(), mode: z.string() }),
    ),
  }),
  catalog: z.object({ records: z.number().int() }),
  /** Files that couldn't be read: a manifest, sources.yaml or a catalog file. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type OnboardingViewT = z.infer<typeof OnboardingView>;

/**
 * 2.22.0 (ADR 0124 addendum, the app's Trust tab): how far to trust each repo's map, read from
 * files only: `facts/<repo>.jsonl`, the verifier's `<repo>.verify.yaml`, the checkout's HEAD read
 * from its `.git` files (no git runs), and which records of catalog/generated cite the repo from
 * its facts and which from the built-in readers.
 */
export const TrustState = z.enum([
  /** No facts file: the assistant hasn't read the repo. */
  "not-read",
  /** Facts the verifier hasn't checked (no report, or facts still marked unverified). */
  "unverified",
  /** The verifier rejected some: fix them and verify again. */
  "rejected",
  /** The facts are of another commit than the checkout's. */
  "stale",
  /** Verified, but the catalog doesn't hold them yet (atticus verify --write). */
  "unwritten",
  /** Verified and in the catalog, with source files no fact cites yet. */
  "unknown-files",
  "trusted",
]);
/** 2.37.0 (ADR 0148): a sample audit's count of one kind, with its precision and 95% interval. */
export const AuditTallyView = z.object({
  drawn: z.number().int(),
  right: z.number().int(),
  wrong: z.number().int(),
  unsure: z.number().int(),
  open: z.number().int(),
  gone: z.number().int(),
  /** right / (right + wrong); null with neither. */
  precision: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});
export type AuditTallyViewT = z.infer<typeof AuditTallyView>;
export const TrustRepo = z.object({
  repo: z.string(),
  /** `facts/<repo>.jsonl`: how many facts, how many not verified, and their commit. */
  facts: z.object({
    path: z.string(),
    present: z.boolean(),
    count: z.number().int(),
    unverified: z.number().int(),
    commit: z.string().optional(),
  }),
  /** `facts/<repo>.verify.yaml`; report is null when it isn't there or can't be read. */
  verify: z.object({
    path: z.string(),
    report: z
      .object({
        accepted: z.number().int(),
        rejected: z.number().int(),
        redacted: z.number().int(),
        coverage: z.object({
          /** Files read over files that count, 0 to 1. */
          ratio: z.number(),
          read: z.number().int(),
          unknown: z.number().int(),
          excluded: z.number().int(),
        }),
        /** The first files no fact cites (at most 50). */
        unknownFiles: z.array(z.string()),
        commit: z.string().optional(),
        /**
         * 3.10.0 (beta.24): the config files' lines that hold what looks like a live secret, each
         * with its key; never its value.
         */
        secrets: z
          .array(z.object({ file: z.string(), line: z.number().int(), key: z.string() }))
          .optional(),
      })
      .nullable(),
  }),
  /** The repo's checkout (its base clone, or the metarepo when adopted) and its HEAD. */
  checkout: z.object({ path: z.string(), present: z.boolean(), commit: z.string().optional() }),
  /** Whether the facts' commit is the checkout's; null when either isn't known. */
  sameCommit: z.boolean().nullable(),
  /** Records of catalog/generated citing the repo: from its facts, from the readers. */
  catalog: z.object({
    from: z.enum(["facts", "readers", "both", "none"]),
    fromFacts: z.number().int(),
    fromReaders: z.number().int(),
  }),
  state: TrustState,
  /** The command to run next (and the assistant's slash command), absent when trusted. */
  next: z.object({ command: z.string(), slash: z.string().optional() }).optional(),
  /**
   * 2.29.0 (ADR 0124 addendum A-framework): what the repo is built on, from its framework facts
   * — one entry per framework, with the version as declared, the module when a module declares
   * its own, where it is cited (`file:line`), and whether the facts show none of its patterns,
   * which is a question for a person rather than a fact about the repo. Empty until the repo is
   * read; a framework is never guessed here.
   */
  frameworks: z
    .array(
      z.object({
        name: z.string(),
        version: z.string().optional(),
        component: z.string().optional(),
        cite: z.string(),
        /** The question its missing patterns raise, when the facts show none of them. */
        gap: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * 2.48.0 (ADR 0163): the organisation's terms the repo writes, from its term facts: the term,
   * the value as written, the role a note gave it (`unknown` when none says), where it is cited
   * (`file:line`), the line that gives it its role and the note it rests on. Empty until read.
   */
  terms: z
    .array(
      z.object({
        term: z.string(),
        value: z.string(),
        role: z.enum(["owner", "consumer", "none", "unknown"]),
        cite: z.string(),
        meaning: z.string().optional(),
        note: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .optional(),
  /**
   * 2.32.0 (ADR 0135, C3): what the counts count, so each opens its list. `rejected`: every line
   * of `<repo>.rejected.jsonl` (a rejected fact with its file and line, or a refused question,
   * reviewed entry or line that isn't a fact); `excluded`: the files the scan settings exclude
   * (the first 50); `asked`: the open questions about the repo with the lines they read;
   * `unverified`: the facts not checked yet (the first 50). Not read is `verify.report.unknownFiles`.
   */
  lists: z
    .object({
      rejected: z.array(
        z.object({
          fact: z.string().optional(),
          kind: z.string().optional(),
          file: z.string().optional(),
          line: z.number().int().optional(),
          code: z.string(),
          message: z.string(),
        }),
      ),
      excluded: z.array(z.string()),
      asked: z.array(
        z.object({ id: z.string(), question: z.string(), lines: z.array(z.string()) }),
      ),
      unverified: z.array(
        z.object({ fact: z.string(), kind: z.string(), file: z.string(), line: z.number().int() }),
      ),
    })
    .optional(),
  /**
   * 2.37.0 (ADR 0148, P3): the sample audit's precision, from `facts/<repo>.audit.yaml` (`path`):
   * the facts' (and per kind) and the links', each with the sample size and a 95% interval. A
   * fact answer whose fact has been read again since is gone, not counted; left out when the
   * repo has no audit.
   */
  audit: z
    .object({
      path: z.string(),
      facts: AuditTallyView,
      byKind: z.record(z.string(), AuditTallyView),
      links: AuditTallyView,
      /** 2.81.0 (ADR 0181): the AI's decisions drawn from this repo, audited apart. */
      ai: AuditTallyView.optional(),
    })
    .optional(),
});
/** 2.47.0 (ADR 0164): the contract check's counts. */
export const ContractCounts = z.object({
  links: z.number().int(),
  compared: z.number().int(),
  mismatches: z.number().int(),
  unconfirmed: z.number().int(),
  /** 2.50.0 (ADR 0172): the calls no link starts at, whose payload can't be checked yet. */
  unlinked: z.number().int().optional(),
});
/**
 * 3.10.0 (beta.24 review): a box on the map made from an answer's words, not a system's name (an
 * id of five or more words, or with a sentence's words in it, or a long name with spaces): a
 * system of a profile, the answers to questions about where calls go that name it, or both.
 */
export const AnswerBox = z.object({
  id: z.string(),
  name: z.string(),
  /** The profile that has it as a system, relative to the metarepo; none when only answers name it. */
  profile: z.string().optional(),
  /** The answered questions whose words name it. */
  questions: z.array(z.object({ id: z.string(), repo: z.string(), question: z.string() })),
});
export type AnswerBoxT = z.infer<typeof AnswerBox>;

export const TrustView = z.object({
  /** Where the facts files are, relative to the metarepo. */
  factsDir: z.string(),
  repos: z.array(TrustRepo),
  /** 3.10.0 (beta.24 review): the boxes made from an answer's words, for Map › Trust. */
  answerBoxes: z.array(AnswerBox).optional(),
  /** 2.47.0 (ADR 0164): the contract check's counts over the estate (the Mismatches page). */
  contracts: ContractCounts.optional(),
  /** Files that couldn't be read: a manifest, a facts file, a report or a catalog file. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type TrustViewT = z.infer<typeof TrustView>;

/**
 * 3.10.0 (beta.24 review): POST /api/trust/answer-boxes/ignore and /rename: put right a box an
 * answer's words made. Ignore turns each answer that names it into Ignore and takes the system out
 * of its profile; rename names it (a repo or system Atticus knows, or a new outside system's short
 * name) and points the answers at it. `preview` writes nothing. Local writes in the metarepo, for
 * review in the pull request (Propose for review), as the setup forms' are.
 */
export const AnswerBoxRequest = z.strictObject({
  id: z.string().trim().min(1).max(200),
  /** For rename: the repo or system it is, or a new outside system's name. */
  name: z.string().trim().min(1).max(200).optional(),
  preview: z.literal(true).optional(),
});
export const AnswerBoxResult = z.object({
  id: z.string(),
  written: z.boolean(),
  /** Each answer that names it: what it was, and what it is (or would be) now. */
  answers: z.array(
    z.object({ id: z.string(), repo: z.string(), was: z.string(), now: z.string() }),
  ),
  /** The profile's lines it changes, when it is a system of one. */
  profile: z
    .object({
      path: z.string(),
      changes: z.array(z.object({ was: z.string().optional(), now: z.string().optional() })),
    })
    .optional(),
  /** The repos whose answers changed: Apply (verify --write) puts them on the map. */
  repos: z.array(z.string()),
});
export type AnswerBoxResultT = z.infer<typeof AnswerBoxResult>;

/**
 * 2.34.0 (ADR 0141, plan item P5): which repos' clones have moved past their facts' commit, and
 * what reading each again costs, for every repo at once (the per-repo re-read plan of ADR 0124
 * addendum A-incremental over the estate). Read from the facts files and the clones with local
 * git only; nothing is fetched or written.
 */
export const FreshState = z.enum([
  /** Facts cite files that changed, or source files changed: read again. */
  "stale",
  /** The clone doesn't have the commit the facts were read at. */
  "unknown-commit",
  /** The clone moved, but nothing the facts cite changed and no source file did. */
  "moved",
  /** No clone to compare with. */
  "no-checkout",
  "fresh",
  /** No facts yet. */
  "not-read",
]);
export const FreshRepo = z.object({
  repo: z.string(),
  state: FreshState,
  factsFile: z.string(),
  facts: z.number().int(),
  /** The commits the facts were read at, sorted. */
  factsCommits: z.array(z.string()),
  /** The commit the clone is at. */
  head: z.string().optional(),
  /** Facts already of the clone's commit. */
  current: z.number().int(),
  /** Facts whose every cited file is unchanged: carried by atticus verify. */
  carried: z.number().int(),
  /** Facts citing a file that changed, or of a commit the clone lacks: read again. */
  reread: z.number().int(),
  /** Files the facts cite that changed since. */
  citedChanged: z.number().int(),
  /** Every file changed since the facts' commits. */
  changed: z.number().int(),
  /** The source files a re-read opens. */
  toRead: z.number().int(),
  /** Commits the facts name that the clone doesn't have. */
  unknown: z.array(z.string()),
  command: z.string().optional(),
  slash: z.string().optional(),
});
export const FreshView = z.object({
  factsDir: z.string(),
  /** Most stale first. */
  repos: z.array(FreshRepo),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type FreshViewT = z.infer<typeof FreshView>;
export type FreshRepoT = z.infer<typeof FreshRepo>;
export type TrustRepoT = z.infer<typeof TrustRepo>;

/**
 * 2.22.0 (ADR 0124, Part 5): the org knowledge that applies to a change (`knowledge.yaml`, as its
 * stages' selections wrote it), with what a person confirmed or excluded and the near-misses.
 */
export const ChangeKnowledgeItem = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["suggested", "confirmed", "excluded"]),
  stages: z.array(z.string()),
  score: z.number(),
  why: z.string().optional(),
  file: z.string().optional(),
  /** 2.24.0: what a person knows it by: an item's title, a section's heading path. */
  title: z.string().optional(),
  /** 2.24.0: why it was picked, in plain words (`why` is the selection's own account). */
  reason: z.string().optional(),
  /** 2.26.0: the tasks whose own selection picked it (B-task-knowledge). */
  tasks: z.array(z.string()).optional(),
  /** 2.30.0 (ADR 0132): the source of the page it is read from, and how much its word counts. */
  source: z.string().optional(),
  authority: z.enum(SOURCE_AUTHORITIES).optional(),
  /**
   * 3.6.0 (ADR 0191): what it says, to open it in place: a section's own text with its page and
   * heading, or an item's quote with its page. Left out when the page can't be read.
   */
  passage: z
    .object({
      source: z.string(),
      page: z.string(),
      path: z.string(),
      heading: z.string(),
      line: z.number().int(),
      text: z.string(),
      quote: z.string().optional(),
    })
    .optional(),
});

/**
 * 2.26.0 (ADR 0124 addendum B-task-knowledge): pages that disagree about a knowledge item, what
 * each says, the pages that apply (none while undecided, every one for "both, in different
 * cases") and who decided: a person's answer to the question about it, or the code (a record
 * verified from code holds one page's value: a document never overrides it). The page an
 * ownership signal suggests is shown as a suggestion, never as a decision.
 */
export const KnowledgeConflictView = z.object({
  /** The items it is about and its pages, each sorted: the same key is never asked twice. */
  key: z.string(),
  about: z.array(z.string()),
  summary: z.string().optional(),
  pages: z.array(z.object({ source: z.string(), page: z.string(), says: z.string() })),
  applies: z.array(z.object({ source: z.string(), page: z.string() })),
  decided: z
    .discriminatedUnion("by", [
      z.object({
        by: z.literal("person"),
        who: z.string(),
        at: z.string(),
        question: z.string(),
        /** "Both, in different cases" in the person's own words. */
        words: z.string().optional(),
      }),
      z.object({
        by: z.literal("code"),
        /** The catalog record verified from code, its kind, the value and where: repo:path:line. */
        record: z.string(),
        kind: z.string(),
        value: z.string(),
        at: z.string(),
      }),
    ])
    .optional(),
  /** The page an ownership signal suggests, and which signal: a suggestion only. */
  suggested: z
    .object({
      source: z.string(),
      page: z.string(),
      /** 2.30.0: status, exception and authority (ADR 0132). */
      signal: z.enum([
        "replaces",
        "owner",
        "source-kind",
        "space",
        "last-edited",
        "status",
        "exception",
        "authority",
      ]),
      detail: z.string(),
    })
    .optional(),
  question: z
    .object({ id: z.string(), state: z.enum(["open", "answered", "retired"]), repo: z.string() })
    .optional(),
});
export type KnowledgeConflictViewT = z.infer<typeof KnowledgeConflictView>;

export const ChangeKnowledgeView = z.object({
  change: z.string(),
  file: z.string(),
  /** False before a stage of the change has selected context. */
  present: z.boolean(),
  items: z.array(ChangeKnowledgeItem),
  nearMisses: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      score: z.number(),
      stage: z.string(),
      /** 2.24.0: what a person knows it by. */
      title: z.string().optional(),
    }),
  ),
  /** 2.26.0: the pages that disagree about what the change or one of its tasks relies on. */
  conflicts: z.array(KnowledgeConflictView).optional(),
  /** The command that lists it (and confirms or excludes with --confirm, --exclude). */
  command: z.string(),
});
/** atticus change knowledge <change> --confirm|--exclude <item>. */
export const SetChangeKnowledgeRequest = z.strictObject({
  status: z.enum(["confirmed", "excluded"]),
});
export const SetChangeKnowledgeResult = z.object({
  knowledge: ChangeKnowledgeView,
  file: z.string(),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
});
export type ChangeKnowledgeViewT = z.infer<typeof ChangeKnowledgeView>;
export type SetChangeKnowledgeResultT = z.infer<typeof SetChangeKnowledgeResult>;

/**
 * 2.23.0 (ADR 0124 addendum D-app, F3): a repo's facts as the Map cites them. Each fact with the
 * line it rests on and its quote, who made it and who checked it, the fields a person may correct
 * and a correction already on file. A flow's steps and error paths carry their own citations.
 */
export const FactCiteSpot = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  value: z.string(),
  quote: z.string().optional(),
});
export const FactCiteView = z.object({
  id: z.string(),
  kind: z.string(),
  /** The claim in a few words: `GET /accounts/{accountId}`, `ledger.entries (write)`. */
  label: z.string(),
  /** The fields a person may correct, with their values now. */
  claim: z.record(z.string(), z.string()),
  cite: FactCiteSpot,
  /** A flow's steps and error paths, each at its own line. */
  steps: z.array(FactCiteSpot.extend({ what: z.string() })).optional(),
  verified: z.enum(["line", "sample", "person", "none"]),
  by: z.enum(["assistant", "reader", "person"]),
  /** A person's correction of the fact, on file; atticus verify applies it. */
  correction: FactCorrection.optional(),
});
export const RepoFactsView = z.object({
  repo: z.string(),
  /** `facts/<repo>.jsonl`, from the metarepo's root. */
  file: z.string(),
  present: z.boolean(),
  commit: z.string().optional(),
  facts: z.array(FactCiteView),
  /** `facts/<repo>.corrections.jsonl`: how many, and the facts they name the file doesn't have. */
  corrections: z.object({ file: z.string(), count: z.number().int(), stale: z.array(z.string()) }),
  /** Open questions about the repo, with the lines they read (path:line). */
  questions: z.array(
    z.object({ id: z.string(), question: z.string(), evidence: z.array(z.string()) }),
  ),
  /** The command that checks the facts again and applies the corrections. */
  verify: z.string(),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
/** Mark a fact wrong (with why) or correct its claim: its fields, or the line it is on. */
export const FactCorrectionRequest = z.strictObject({
  fact: z.string().min(1),
  action: z.enum(["wrong", "edit"]),
  set: z.record(z.string().min(1), z.string()).optional(),
  line: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export const FactCorrectionResult = z.object({
  correction: FactCorrection,
  /** `facts/<repo>.corrections.jsonl`, from the metarepo's root. */
  file: z.string(),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
  /** The command that applies it: the verifier reads the corrections every time it runs. */
  verify: z.string(),
  /** 2.42.0 (ADR 0149): the line appended to the file, exactly as written. */
  line: z.string().optional(),
});
/**
 * 3.10.0 (beta.24): one correction of every call on an arrow between two boxes ("This whole arrow
 * is wrong"): each call's fact in its caller's repo, the same action for all, and the person's
 * why for every one (an item's own `reason` first). Every item is checked before any is written;
 * then each repo's corrections file takes its lines in one write.
 */
export const LinkCorrectionsRequest = z.strictObject({
  items: z
    .array(
      z.strictObject({
        repo: z.string().min(1),
        fact: z.string().min(1),
        action: z.enum(["wrong", "edit"]),
        set: z.record(z.string().min(1), z.string()).optional(),
        reason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
  reason: z.string().trim().min(1).max(500).optional(),
});
export const LinkCorrectionsResult = z.object({
  /** Each repo's corrections file, from the metarepo's root, and the lines appended to it. */
  files: z.array(
    z.object({
      repo: z.string(),
      file: z.string(),
      lines: z.array(z.string()),
      corrections: z.array(FactCorrection),
    }),
  ),
  /** The git command that commits every file (the app runs no git). */
  commit: z.string(),
  /** The commands that apply them, one per repo. */
  verify: z.array(z.string()),
  /**
   * Review of beta.24: the items left out because the newest correction on file for that fact
   * says the same already (asked again, nothing is written twice).
   */
  skipped: z.array(z.object({ repo: z.string(), fact: z.string() })).optional(),
});
/**
 * 2.42.0 (ADR 0149, C4): after a correction the app writes, the commands a person runs (the app
 * runs none) and what the next `atticus verify <repo> --write` will change, computed in-process
 * by the same functions that command uses, writing nothing.
 */
export const NextStepView = z.object({
  step: z.enum(["verify", "branch", "add", "commit", "push", "pr"]),
  /** The command to copy; absent for a pull request on a Git host Atticus has no command for. */
  command: z.string().optional(),
});
export const PreviewLinkView = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  method: z.string().optional(),
  path: z.string(),
  confidence: z.string(),
  how: z.string().optional(),
  flags: z.array(z.string()).optional(),
  /** Under changed: the confidence and flags it had before. */
  was: z.object({ confidence: z.string(), flags: z.array(z.string()).optional() }).optional(),
});
export const VerifyPreviewView = z.object({
  repo: z.string(),
  /** The one file the app wrote: `facts/<repo>.corrections.jsonl`. */
  wrote: z.string(),
  /** The branch the git steps make. */
  branch: z.string(),
  /** In order: verify --write, then branch, add (the exact files), commit, push, pull request. */
  steps: z.array(NextStepView),
  /** What the next verify --write will change; absent when it can't be worked out here (`unavailable`). */
  preview: z
    .object({
      facts: z.object({
        /** Facts the write leaves out: marked wrong by a person, or rejected by the verifier. */
        dropped: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            why: z.enum(["wrong", "rejected"]),
            message: z.string().optional(),
          }),
        ),
        /** Facts whose claim or line the write changes (a person's edit), field by field. */
        edited: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            fields: z.array(
              z.object({
                name: z.string(),
                was: z.string().optional(),
                now: z.string().optional(),
              }),
            ),
          }),
        ),
        kept: z.number().int(),
      }),
      /** The write puts nothing in the catalog while facts are rejected: how many. */
      blocked: z.object({ rejected: z.number().int() }).optional(),
      /** The catalog records it adds, changes and removes; absent when blocked. */
      catalog: z
        .object({
          added: z.number().int(),
          changed: z.number().int(),
          removed: z.number().int(),
          /** Record files whose only change is their evidence (a line moved, a new commit). */
          evidenceOnly: z.number().int(),
          /** The record files it writes or removes, from the metarepo's root. */
          files: z.array(z.string()),
        })
        .optional(),
      /** The links (Interfaces) it adds, removes, changes, and moves (one call, another callee). */
      links: z
        .object({
          added: z.array(PreviewLinkView),
          removed: z.array(PreviewLinkView),
          changed: z.array(PreviewLinkView),
          /**
           * Links this repo's calls no longer make whose record stays, held by the callee's side
           * alone, until that repo is written again.
           */
          unmade: z.array(PreviewLinkView),
          moved: z.array(
            z.object({
              from: z.string(),
              method: z.string().optional(),
              path: z.string(),
              was: z.string(),
              to: z.string(),
            }),
          ),
        })
        .optional(),
      /** The checkout's HEAD is past the facts' commit: verify reads the changed files' facts again. */
      headMoved: z.object({ head: z.string(), commit: z.string() }).optional(),
      /** Corrections on file that meet no fact in this read (kept, applied when it is read again). */
      staleCorrections: z.array(z.string()),
    })
    .optional(),
  /** Why there is no preview: no checkout of the repo, or a facts file that doesn't read. */
  unavailable: z.enum(["no-checkout", "unreadable-facts"]).optional(),
});
export type VerifyPreviewViewT = z.infer<typeof VerifyPreviewView>;
export type PreviewLinkViewT = z.infer<typeof PreviewLinkView>;
/**
 * 2.42.0 (ADR 0149, P3's follow-up): a sample audit drawn and answered in the app, by the same
 * functions as `atticus verify audit` (the same seed draws the same sample). Each item with the
 * text of every line it cites, read from the checkout.
 */
export const AuditItemView = AuditItem.extend({
  lines: z.array(z.object({ cite: z.string(), text: z.string().optional() })),
});
export const AuditSampleView = z.object({
  repo: z.string(),
  /** `facts/<repo>.audit.yaml`, from the metarepo's root. */
  file: z.string(),
  seed: z.string(),
  size: z.number().int(),
  /** The seed a draw takes when none is given, `<repo>@<commit>`, as the CLI's. */
  defaultSeed: z.string().optional(),
  /** This draw's items, with any answers on file. */
  items: z.array(AuditItemView),
  /** Why the repo can't be audited yet; then `items` is empty. */
  refused: z.enum(["no-facts", "bad-facts", "unverified", "bad-file"]).optional(),
  /** Under `unverified`: how many facts aren't verified. */
  unverified: z.number().int().optional(),
  /** The precision over the answers on file that still stand (links checked by the join). */
  precision: z.object({ facts: AuditTallyView, links: AuditTallyView }).optional(),
  /** The same draw in a terminal. */
  command: z.string(),
});
export const AuditAnswerRequest = z.strictObject({
  seed: z.string().min(1).max(200),
  size: z.number().int().positive().max(100),
  answers: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        answer: z.enum(AUDIT_ANSWERS),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});
export const AuditAnswerResult = z.object({
  file: z.string(),
  answered: z.number().int(),
  open: z.number().int(),
  items: z.array(AuditItemView),
  precision: z.object({ facts: AuditTallyView, links: AuditTallyView }),
  /** The git command that commits the file (the app runs no git). */
  commit: z.string(),
});
export type AuditItemViewT = z.infer<typeof AuditItemView>;
export type AuditSampleViewT = z.infer<typeof AuditSampleView>;
export type AuditAnswerResultT = z.infer<typeof AuditAnswerResult>;

/**
 * 2.47.0 (ADR 0164, F7): one difference the contract check found between the two sides of a
 * link: what each side says and its line, the mappings it went through, and whether it is a
 * mismatch or unconfirmed (a mapping on the way nobody traced).
 */
export const ContractEndView = z.object({
  repo: z.string().optional(),
  system: z.string().optional(),
  what: z.string(),
  value: z.string().optional(),
  at: z.string().optional(),
});
export const ContractFactEnd = z.object({
  repo: z.string(),
  fact: z.string(),
  component: z.string(),
  at: z.string(),
});
export const ContractMismatchView = z.object({
  id: z.string(),
  interface: z.string().optional(),
  interfaces: z.array(z.string()).optional(),
  call: ContractFactEnd,
  entry: ContractFactEnd.optional(),
  system: z.string().optional(),
  status: z.enum(["mismatch", "unconfirmed"]),
  kind: z.enum([
    "field-missing",
    "field-extra",
    "field-not-sent",
    "field-required",
    "field-type",
    "field-number",
    "error-unlisted",
    "error-unanswered",
  ]),
  side: z.enum(["request", "response", "message"]).optional(),
  field: z.string().optional(),
  error: z.string().optional(),
  sender: ContractEndView,
  receiver: ContractEndView,
  via: z.array(z.string()).optional(),
  untraced: z.string().optional(),
  message: z.string(),
});
export const ContractLinkView = z.object({
  key: z.string(),
  interface: z.string().optional(),
  interfaces: z.array(z.string()).optional(),
  call: ContractFactEnd,
  entry: ContractFactEnd.optional(),
  system: z.string().optional(),
  kind: z.enum(["rest", "topic", "outside"]),
  method: z.string().optional(),
  path: z.string(),
  through: z.array(z.string()),
  specs: z.array(z.string()),
  compared: z.number().int(),
  mismatches: z.number().int(),
  unconfirmed: z.number().int(),
});
/** GET /api/contracts (2.47.0, ADR 0164): the estate's contract check. */
export const ContractsView = z.object({
  links: z.array(ContractLinkView),
  findings: z.array(ContractMismatchView),
  counts: ContractCounts,
  /** What the facts or the specs on file left out, said once. */
  notes: z.array(z.string()),
});
export type ContractMismatchViewT = z.infer<typeof ContractMismatchView>;
export type ContractLinkViewT = z.infer<typeof ContractLinkView>;
export type ContractsViewT = z.infer<typeof ContractsView>;

/**
 * 2.42.0 (ADR 0149, O4): the systems outside the estate (every profile system no estate repo
 * belongs to: vendors and other teams), each with who calls it, the operations its intaken spec
 * publishes, the calls that match nothing in that spec, and its open questions.
 */
export const OutsideCallView = z.object({
  repo: z.string(),
  component: z.string().optional(),
  /** The call fact, when the join names it. */
  fact: z.string().optional(),
  /** `path:line` of the call. */
  at: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  /**
   * Where it was seen: a catalog Interface to the system, the estate join's outside list, the
   * system's spec (its hosts or names matched the call, ADR 0130), or more than one.
   */
  seen: z.array(z.enum(["interface", "join", "spec", "shared"])),
  /** The Interface record, when the catalog has one. */
  interface: z.string().optional(),
  /** The spec operation it reaches (its Endpoint id), when it matches one. */
  operation: z.string().optional(),
  /** Through a gateway's forwarding call (the route and the gateway's call), when it is. */
  through: z.object({ repo: z.string(), at: z.string() }).optional(),
  /** 2.44.0 (ADR 0160): the entry of another team's shared map that answers it. */
  entry: z
    .object({ team: z.string(), repo: z.string(), fact: z.string(), at: z.string() })
    .optional(),
});
export const OutsideSystemView = z.object({
  id: z.string(),
  name: z.string(),
  boundary: z.string(),
  owner: z.string().optional(),
  aliases: z.array(z.string()),
  callers: z.array(OutsideCallView),
  /** Its newest intaken spec in inputs/; absent when none is linked to it. */
  spec: z
    .object({
      path: z.string(),
      title: z.string().optional(),
      version: z.string().optional(),
      operations: z.array(
        z.object({
          id: z.string(),
          method: z.string(),
          path: z.string(),
          cite: z.string(),
          /** How many of the callers reach it. */
          calls: z.number().int(),
        }),
      ),
    })
    .optional(),
  /** Calls to it that match no operation of its spec, with why. */
  unmatched: z.array(OutsideCallView.extend({ message: z.string() })),
  /** Calls two or more of its operations answer equally well. */
  ambiguous: z.array(OutsideCallView.extend({ candidates: z.array(z.string()) })),
  /** Open questions about it: naming it, or citing a line one of its calls is on. */
  questions: z.array(z.object({ id: z.string(), repo: z.string(), question: z.string() })),
  /** With no spec: how to add one. */
  addSpec: z.array(z.string()).optional(),
  /**
   * 2.44.0 (ADR 0160): the map its team shares, read-only: whose, their commit, when it was
   * imported, each entry with how many of the callers reach it, and the calls it has no entry for.
   */
  shared: z
    .object({
      team: z.string(),
      name: z.string(),
      commit: z.string(),
      importedAt: z.string(),
      entries: z.array(
        z.object({
          repo: z.string(),
          component: z.string(),
          fact: z.string(),
          method: z.string().optional(),
          path: z.string(),
          at: z.string(),
          commit: z.string().optional(),
          calls: z.number().int(),
        }),
      ),
      unmatched: z.array(OutsideCallView.extend({ message: z.string() })),
    })
    .optional(),
  /**
   * 2.47.0 (ADR 0164): the calls to it checked against its newest intaken spec, and the ids of
   * the findings that spec brings that the one it replaced didn't (`new`, when there was one).
   */
  contracts: z
    .object({ findings: z.array(ContractMismatchView), new: z.array(z.string()).optional() })
    .optional(),
});
export const OutsideView = z.object({
  systems: z.array(OutsideSystemView),
  /** What the estate's facts left out (a repo not verified), said once. */
  notes: z.array(z.string()),
});
export type OutsideSystemViewT = z.infer<typeof OutsideSystemView>;
export type OutsideCallViewT = z.infer<typeof OutsideCallView>;
export type OutsideViewT = z.infer<typeof OutsideView>;

export type FactCiteViewT = z.infer<typeof FactCiteView>;
export type RepoFactsViewT = z.infer<typeof RepoFactsView>;
export type FactCorrectionResultT = z.infer<typeof FactCorrectionResult>;
export type FactCorrectionRequestT = z.infer<typeof FactCorrectionRequest>;
export type LinkCorrectionsRequestT = z.infer<typeof LinkCorrectionsRequest>;
export type LinkCorrectionsResultT = z.infer<typeof LinkCorrectionsResult>;

/**
 * 2.23.0 (ADR 0124 addendum D-app, B10): a stage tab's critic findings (the latest round of the
 * stage's gate, `review/<gate>/<round>/`), each with the options it allows and the comments a
 * person wrote on it, the stage's own questions, and the command to run next. A comment is a
 * question the person answered as they asked it (ADR 0078), listed in the stage's loop file, so
 * the stage's next run reads it as a person's answer and hands it to the drafter (ADR 0087).
 */
export const STAGE_TABS = ["feature", "architecture", "stories"] as const;
export const StageTab = z.enum(STAGE_TABS);
export const StageComment = z.object({
  /** The question the comment is written as, `questions/<id>.yaml`. */
  question: z.string(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
  /** A draft of the stage has read it. */
  read: z.boolean(),
});
export const StageFindingView = z.object({
  finding: Finding,
  /** The finding's file, from the metarepo's root. */
  file: z.string(),
  options: z.object({
    /** The fix's one action, in words. */
    fix: z.string(),
    /** Apply: record the fix as made (an issue). */
    apply: z.boolean(),
    /** Not relevant, with a reason (an issue). */
    dismiss: z.boolean(),
    /** Waive, with a reason: a blocking finding of a rule that allows it. */
    waive: z.boolean(),
    /** A knowledge gap's question to its owner: Ask routes it. */
    ask: z.object({ text: z.string(), owner: z.string() }).optional(),
  }),
  comments: z.array(StageComment),
  /**
   * ADR 0115 addendum (2026-10-25): what an assistant proposed about the open finding (that it
   * is not relevant, or fixed), waiting on a person. Only a person's resolution closes a blocking
   * or risk finding. Optional (additive, API 2.25.0).
   */
  proposal: z
    .object({
      claim: z.enum(["not-relevant", "fixed"]),
      by: z.string(),
      at: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
});
export const StageReviewView = z.object({
  change: z.string(),
  stage: StageTab,
  /** The gate the stage's critic reviews at; null when gates.yaml has none for its phase. */
  gate: z.string().nullable(),
  /** The round shown, the gate's latest; null before the critic reviewed anything. */
  round: z.number().int().nullable(),
  /** `stage/<stage>.yaml`, the stage's loop: whether the stage has run, and where it stopped. */
  loop: z.object({
    file: z.string(),
    present: z.boolean(),
    state: z.string().optional(),
    iteration: z.number().int().optional(),
  }),
  findings: z.array(StageFindingView),
  /** The questions the stage raised (comments aside), open first. */
  questions: z.array(Question),
  /** The stage's command (and slash command), which reads the answers and comments. */
  next: z.object({ command: z.string(), slash: z.string() }),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
/**
 * 2.77.0 (eighth UX walk): the feature stage's placement. feature.md is drawn from feature.yaml
 * (the source a person edits; the stage's next run reads it), so the page shows the one and
 * edits the other. `drafted` says who wrote feature.yaml last: the AI at the feature stage, or a
 * person who saved it here (or edited its first line away).
 */
export const PlacementView = z.object({
  change: z.string(),
  /** Whether feature.yaml is there (the feature stage has placed the change). */
  present: z.boolean(),
  /** feature.md, from the metarepo's root, and its text ("" when it isn't there). */
  file: z.string(),
  content: z.string(),
  /** feature.yaml, from the metarepo's root, its text and its sha256 (the save's base). */
  source: z.string(),
  sourceContent: z.string(),
  sha256: z.string(),
  drafted: z
    .object({
      by: z.enum(["ai", "person"]),
      who: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
});
export type PlacementViewT = z.infer<typeof PlacementView>;
export const SavePlacementRequest = z.strictObject({
  /** feature.yaml's new text; it must still read as a placement. */
  content: z.string().min(1),
  /** The sha256 the edit started from; a mismatch returns 409. */
  baseSha256: z.string(),
});
export const StageCommentRequest = z.strictObject({
  finding: z.string().min(1),
  /** The gate the finding belongs to, when its id alone is ambiguous. */
  gate: z.string().optional(),
  text: z.string().trim().min(1).max(4000),
});
export const StageCommentResult = z.object({
  comment: StageComment,
  /** The files written, from the metarepo's root: the question, and the stage's loop file. */
  files: z.array(z.string()),
  /** The git command that commits them (the app runs no git). */
  commit: z.string(),
  next: z.object({ command: z.string(), slash: z.string() }),
});
export type StageReviewViewT = z.infer<typeof StageReviewView>;

/**
 * 3.5.0 (ADR 0189): a stage of a change as one conversation, assembled from the files that hold
 * it (the runs, the stage's loop file, the critic's rounds, the questions, the corrections). The
 * thread is a view and the place to reply: the AI still runs in the person's editor (a hand-off),
 * unattended Copilot or a server model. Items are in order; a prompt's sizes, model and file
 * paths are its `details`, for a Details disclosure.
 */
export const THREAD_STAGES = ["proposal", "feature", "architecture", "stories", "small"] as const;
export const ThreadStage = z.enum(THREAD_STAGES);
export const ThreadRunDetails = z.object({
  agent: z.string(),
  runtime: z.string(),
  promptPath: z.string(),
  output: z.string().optional(),
  promptTokens: z.number().int().min(0).optional(),
  model: z.string().optional(),
  attempt: z.number().int().min(1),
});
export const ThreadItem = z.discriminatedUnion("kind", [
  /** A prompt handed to the assistant (the stage's drafter, or the critic's lenses). */
  z.object({
    kind: z.literal("prompt"),
    at: z.string(),
    runId: z.string(),
    who: z.enum(["drafter", "critic"]),
    prompt: z.string(),
    state: RunState,
    details: ThreadRunDetails,
  }),
  /** What came back, and what its checks said. */
  z.object({
    kind: z.literal("answer"),
    at: z.string(),
    runId: z.string(),
    who: z.enum(["drafter", "critic"]),
    /** passed: the checks read it; failed: they found problems (listed); checking: not yet. */
    checked: z.enum(["passed", "failed", "checking"]),
    /** Who checked it: the app when the file arrived (ADR 0189), or a person's Done. */
    by: z.enum(["app", "person"]).optional(),
    summary: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  /** The files the stage wrote from an answer. */
  z.object({ kind: z.literal("changed"), at: z.string(), files: z.array(z.string()) }),
  z.object({
    kind: z.literal("finding"),
    at: z.string(),
    view: StageFindingView,
    /**
     * Whether the stage's assistant writes the file the finding cites: Fix then goes to it in the
     * next round; otherwise Fix opens the file at its line in the app's editor (`edit`).
     */
    assistantWrites: z.boolean(),
    edit: z
      .object({
        artifact: z.string(),
        file: z.string().optional(),
        line: z.number().int().optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal("question"), at: z.string(), question: Question }),
  z.object({
    kind: z.literal("reply"),
    at: z.string(),
    text: z.string(),
    by: z.string(),
    /** A round of the stage has read it. */
    read: z.boolean(),
    /** The finding it is about, for a comment on one. */
    about: z.string().optional(),
  }),
  z.object({
    kind: z.literal("correction"),
    at: z.string(),
    text: z.string(),
    label: z.string(),
    by: z.string(),
    state: z.string(),
  }),
  /** A question the assistant raised that couldn't be kept: its evidence was no line. */
  z.object({
    kind: z.literal("dropped"),
    at: z.string(),
    key: z.string(),
    question: z.string(),
    evidence: z.array(z.string()),
    nearest: z.string().optional(),
  }),
  z.object({ kind: z.literal("note"), at: z.string(), text: z.string() }),
]);
export const StageThreadView = z.object({
  change: z.string(),
  stage: ThreadStage,
  /** Where the stage is, in one word, and the one sentence the thread opens with. */
  state: z.enum(["not-started", "waiting", "questions", "drafting", "stopped", "done"]),
  headline: z.string(),
  items: z.array(ThreadItem),
  /** The run waiting for the assistant's answer, if one does. */
  waiting: z.object({ runId: z.string(), prompt: z.string() }).optional(),
  /** The step's words, for POST /api/runs/handoff (the next round's prompt). */
  step: z.array(z.string()),
  /** Whether a reply is taken now, and if not, why. */
  reply: z.object({ open: z.boolean(), why: z.string().optional() }),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export const StageThreadPost = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reply"), text: z.string().trim().min(1).max(4000) }),
  z.strictObject({
    kind: z.literal("finding"),
    finding: z.string().min(1),
    gate: z.string().optional(),
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({ kind: z.literal("keep"), key: z.string().regex(/^[0-9a-f]{12}$/) }),
]);
export const StageThreadPostResult = z.object({
  files: z.array(z.string()),
  thread: StageThreadView,
});
export type ThreadStageT = z.infer<typeof ThreadStage>;
export type ThreadItemT = z.infer<typeof ThreadItem>;
export type StageThreadViewT = z.infer<typeof StageThreadView>;
export type StageThreadPostT = z.infer<typeof StageThreadPost>;
export type StageThreadPostResultT = z.infer<typeof StageThreadPostResult>;
export type StageFindingViewT = z.infer<typeof StageFindingView>;
export type StageCommentResultT = z.infer<typeof StageCommentResult>;

/**
 * 2.80.0 (ADR 0181, stage drafts): AI decides first, a person corrects, and the AI corrects the
 * rest like it. A page's stage drafts (Feature design: feature.md and proposal.md; Architecture:
 * the target flows, design.md and data.md; Stories: the stories and the specs; Tasks: tasks.md),
 * each with who wrote it last (`drafted`: the AI with its stage and run, from
 * `stage/drafted.yaml`, until a person saves it) and the items a person can correct. A
 * correction (`stage/corrections.yaml`) is read by the stage's next run as the person's word in
 * its brief; with `scope: similar` the run applies it to every item like it. After the run it is
 * `applied` when the draft changed its item (else `read`), and `touched` lists the other items
 * the draft changed for it. Kept on file either way.
 */
export const DRAFT_PAGES = ["feature", "architecture", "stories", "tasks"] as const;
export const DraftPage = z.enum(DRAFT_PAGES);
export const DraftProvenance = z.object({
  by: z.enum(["ai", "person"]),
  /** ai: the stage that drafted it. */
  stage: z.string().optional(),
  /** ai: the run that drafted it, when known (GET /api/runs/{runId}). */
  run: z.string().optional(),
  /** person: who saved it in the app; left out for an edit outside the app. */
  who: z.string().optional(),
  at: z.string().optional(),
});
export const DraftItemView = z.object({
  id: z.string(),
  label: z.string(),
  /** Names the item shares with items like it (a step's component, entry or table). */
  like: z.array(z.string()).optional(),
});
export const DraftFileView = z.object({
  /** Change-folder relative, as a correction names it. */
  file: z.string(),
  /** From the metarepo's root. */
  path: z.string(),
  /** The stage whose next run reads a correction of it. */
  stage: z.string(),
  drafted: DraftProvenance.optional(),
  items: z.array(DraftItemView),
});
export const CorrectionView = z.object({
  id: z.string(),
  stage: z.string(),
  file: z.string(),
  item: z.string().optional(),
  label: z.string(),
  text: z.string(),
  scope: z.enum(["one", "similar"]),
  like: z.string().optional(),
  by: z.string(),
  at: z.string(),
  state: z.enum(["waiting", "read", "applied"]),
  run: z.string().optional(),
  iteration: z.number().int().optional(),
  appliedAt: z.string().optional(),
  /** similar: the other items the draft changed for it, as `<file>#<item>`. */
  touched: z.array(z.string()).optional(),
});
export const StageDraftsView = z.object({
  change: z.string(),
  page: DraftPage,
  files: z.array(DraftFileView),
  /** The corrections of these files, oldest first. */
  corrections: z.array(CorrectionView),
  /** The stage to run again for the corrections waiting (or the page's), with its slash command. */
  next: z.object({ stage: z.string(), command: z.string(), slash: z.string() }),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});
export const AddCorrectionRequest = z.strictObject({
  /** The file, change-folder relative (a file of a page's drafts). */
  file: z.string().min(1),
  /** The item in it; left out, the whole file. */
  item: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(4000),
  /** Apply to similar: the next run applies it to every item like it. Default on. */
  similar: z.boolean().default(true),
  /** What the similar items share (a component, an entry, a term). */
  like: z.string().trim().max(200).optional(),
});
export const CorrectionResult = z.object({
  correction: CorrectionView,
  /** The files written, from the metarepo's root. */
  files: z.array(z.string()),
  /** The git command that commits them (the app runs no git). */
  commit: z.string(),
  next: z.object({ stage: z.string(), command: z.string(), slash: z.string() }),
});
export const CorrectionList = z.object({
  change: z.string(),
  corrections: z.array(CorrectionView),
});
export type StageDraftsViewT = z.infer<typeof StageDraftsView>;
export type DraftFileViewT = z.infer<typeof DraftFileView>;
export type DraftProvenanceT = z.infer<typeof DraftProvenance>;
export type CorrectionViewT = z.infer<typeof CorrectionView>;
export type CorrectionResultT = z.infer<typeof CorrectionResult>;
export type CorrectionListT = z.infer<typeof CorrectionList>;

/**
 * ADR 0092: the specs (ADR 0079) as the Flows screen reads them, from files only: the repos
 * with a spec, one repo's flows, and one flow with the joins of the estate pass (ADR 0085).
 */
export const SpecList = z.object({
  repos: z.array(z.object({ repo: RecordId, flows: z.number().int() })),
});

export const SpecFlowSummary = z.object({
  id: RecordId,
  name: z.string(),
  component: RecordId,
  trigger: z.object({ kind: z.string(), what: z.string() }),
  steps: z.number().int(),
  /** Steps a check, the AI's verification or a person confirmed. */
  confirmed: z.number().int(),
  errors: z.number().int(),
  /** Call-outs joined to another repo's flow, and the flows whose call-outs reach this one. */
  calls: z.number().int(),
  calledBy: z.number().int(),
});

export const SpecView = z.object({
  repo: RecordId,
  /** The spec folder, relative to the metarepo. */
  path: z.string(),
  commit: z.string().optional(),
  template: z.string().optional(),
  flows: z.array(SpecFlowSummary),
  /** Files in the folder that don't read, with why. */
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
});

/** A step of one flow joined to a step or trigger of another (estate.yaml). */
export const FlowLink = z.object({
  /** The caller's step, 1-based. */
  step: z.number().int().positive(),
  repo: RecordId,
  flow: RecordId,
  /** The other flow's name, when its spec reads. */
  name: z.string().optional(),
  how: z.string(),
});

export const FlowView = z.object({
  repo: RecordId,
  /** The flow's file, relative to the metarepo. */
  file: z.string(),
  flow: Flow,
  /** Whether specs/estate.yaml was there to read the joins from. */
  joined: z.boolean(),
  /** This flow's call-outs and the flows they start. */
  calls: z.array(FlowLink),
  /** The flows whose call-outs start this one; step is their step. */
  calledBy: z.array(FlowLink),
  /** This flow's call-outs the estate pass couldn't join, with why. */
  unmatched: z.array(
    z.object({
      step: z.number().int().positive(),
      entry: z.string(),
      reason: z.string(),
      message: z.string(),
    }),
  ),
});
/**
 * ADR 0094: one file's cited lines, for an editor's CodeLens: each line a spec flow (its trigger,
 * a step) or a catalog record cites, with what cites it.
 */
export const CiteList = z.object({
  /** The code's repo and the file's path in it, as the citations name them. */
  repo: RecordId,
  path: z.string(),
  lines: z.array(
    z.object({
      line: z.number().int().positive(),
      flows: z.array(
        z.object({
          /** The repo whose spec holds the flow. */
          repo: RecordId,
          flow: RecordId,
          name: z.string(),
          /** 0 for what starts the flow, else the step, counting from 1. */
          step: z.number().int().nonnegative(),
          kind: z.string(),
          confirmedBy: z.string().optional(),
          /** WP7.3: the changes in flight whose target flows touch this flow. */
          changes: z.array(z.string()).optional(),
        }),
      ),
      records: z.array(
        z.object({
          kind: z.string(),
          id: RecordId,
          name: z.string().optional(),
          /** The citation's source: code, config, migration… */
          source: z.string(),
        }),
      ),
    }),
  ),
});
export type CiteListT = z.infer<typeof CiteList>;
/**
 * ADR 0095: a change's target flows (target-flows/<flow>.yaml, ADR 0087) beside today's flows
 * in the specs: each step marked same, changed, added or removed, with its number in today's
 * flow and in the target flow (repeats are target numbers).
 */
export const TargetFlowSummary = z.object({
  flow: RecordId,
  repo: RecordId,
  change: z.enum(["modify", "new", "remove"]),
  name: z.string(),
  why: z.string(),
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
});

export const TargetFlowList = z.object({
  change: RecordId,
  flows: z.array(TargetFlowSummary),
  /** Target-flow files that don't read, with why. */
  problems: z.array(z.string()),
});

export const MergedStep = z.object({
  mark: z.enum(["same", "changed", "added", "removed"]),
  today: z.number().int().positive().optional(),
  target: z.number().int().positive().optional(),
  kind: z.string(),
  what: z.string(),
  to: z
    .object({ component: z.string(), entry: z.string(), new: z.boolean().optional() })
    .optional(),
  store: z
    .object({
      table: z.string(),
      columns: z.array(z.string()),
      new: z.boolean().optional(),
      migration: z.string().optional(),
    })
    .optional(),
  data: FlowData.optional(),
  repeats: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
  evidence: z.array(Evidence),
  confirmedBy: z.string().optional(),
  was: z
    .object({
      kind: z.string(),
      what: z.string(),
      to: z.object({ component: z.string(), entry: z.string() }).optional(),
    })
    .optional(),
  why: z.string().optional(),
});

export const TargetFlowView = z.object({
  change: RecordId,
  /** The target-flow file, relative to the metarepo. */
  file: z.string(),
  flow: RecordId,
  repo: RecordId,
  delta: z.enum(["modify", "new", "remove"]),
  name: z.string(),
  why: z.string(),
  component: z.string(),
  trigger: z.object({ kind: z.string(), what: z.string(), caller: FlowCaller.optional() }),
  triggerEvidence: z.array(Evidence),
  steps: z.array(MergedStep),
  counts: z.object({
    added: z.number().int(),
    changed: z.number().int(),
    removed: z.number().int(),
  }),
  /** Why some of it can't be shown (today's flow isn't in the spec). */
  problems: z.array(z.string()),
});
const MapLegend = z.enum(["new", "modify", "retire"]);

/** A change's picture (ADR 0108): what its target flows touch, each part marked + new, ◇ modify or ✕ retire. */
export const ChangeMap = z.object({
  change: RecordId,
  title: z.string(),
  /** The folder the picture is drawn from, relative to the metarepo. */
  source: z.string(),
  groups: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["system", "datastore"]),
      boundary: z.enum(["product", "internal", "vendor"]).optional(),
      legend: MapLegend.optional(),
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["system", "component", "table", "topic", "box"]),
      boundary: z.enum(["product", "internal", "vendor"]).optional(),
      legend: MapLegend.optional(),
      group: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      label: z.string(),
      async: z.boolean(),
      legend: MapLegend.optional(),
    }),
  ),
  /** The same picture as Mermaid, to paste into a chat, a wiki or a pull request. */
  mermaid: z.string(),
  /** How many target flows it is drawn from. */
  flows: z.number().int(),
  /** Target flows that don't read, or whose today isn't in the spec. */
  problems: z.array(z.string()),
});
export type ChangeMapT = z.infer<typeof ChangeMap>;

const Days = z.object({ p20: z.number(), p50: z.number(), p80: z.number() });

/** A change's estimate (ADR 0109): its size from the target flows, ranges with their drivers. */
export const ChangeEstimate = z.object({
  change: RecordId,
  title: z.string(),
  /** The target-flow folder it is counted from, relative to the metarepo. */
  source: z.string(),
  units: z.array(
    z.object({
      flow: z.string(),
      repo: z.string(),
      step: z.number().int().optional(),
      what: z.string(),
      class: z.string(),
      days: Days.optional(),
      source: z.string(),
    }),
  ),
  needsClass: z.number().int(),
  effort: Days.optional(),
  perRepo: z.array(
    z.object({ repo: z.string(), units: z.number().int(), effort: Days.optional() }),
  ),
  drivers: z.array(
    z.object({
      id: z.string(),
      what: z.string(),
      count: z.number().int(),
      widens: z.number().optional(),
      source: z.string().optional(),
    }),
  ),
  calendar: z.object({
    effortDays: z.number().optional(),
    waitDays: z.number().optional(),
    longer: z.enum(["work", "waiting"]).optional(),
  }),
  calibration: z.object({ calibrated: z.literal(false), source: z.string().optional() }),
  /** The org pack's estimates.yaml, relative to the metarepo, when it has one. */
  table: z.string().optional(),
  /** What couldn't be read: target flows, estimates.yaml, the forecast. */
  problems: z.array(z.string()),
});
export type ChangeEstimateT = z.infer<typeof ChangeEstimate>;

/** A team a question or a repo goes to, or why none does (ADR 0140). */
const OwnerOf = z.union([
  z.object({ team: z.string(), name: z.string().optional() }),
  z.object({ none: z.string() }),
]);

/**
 * 2.36.0 (ADR 0144, V1): a change's impact, as designed. For each entry or table its target flows
 * break: who calls or uses it today (`breaks`, or `may-break` when the join only guessed the link),
 * the fields that stop crossing, the gateway routes to update, each with its owner team.
 */
export const ChangeImpact = z.object({
  change: RecordId,
  /** How many target flows the change has; none means the architecture stage hasn't run. */
  flows: z.number().int(),
  breaks: z.number().int(),
  mayBreak: z.number().int(),
  /** 2.81.0 (ADR 0181): of the callers that break, those whose every link the AI decided. */
  byAi: z.number().int().optional(),
  routes: z.number().int(),
  /** 2.43.0 (ADR 0156): up the chain, hops that surely break and those resting on a guess. */
  upstream: z.object({ breaks: z.number().int(), mayBreak: z.number().int() }).optional(),
  /** The critic's rule that asks about a guessed link. */
  rule: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(["endpoint", "table"]),
      flow: z.string(),
      repo: z.string(),
      id: z.string().optional(),
      name: z.string(),
      why: z.array(z.string()),
      fields: z.object({ gone: z.array(z.string()), required: z.array(z.string()) }),
      owner: OwnerOf,
      callers: z.array(
        z.object({
          component: z.string(),
          repo: z.string().optional(),
          verdict: z.enum(["breaks", "may-break"]),
          guessed: z.enum(JOIN_GUESS_FLAGS).optional(),
          /** 2.81.0 (ADR 0181): every link of this caller the AI decided, none a person confirmed. */
          decidedByAi: z.literal(true).optional(),
          interfaces: z.array(z.string()),
          flows: z.array(z.string()),
          routes: z.array(z.string()),
          at: z.array(z.string()),
          owner: OwnerOf,
        }),
      ),
      routes: z.array(
        z.object({
          id: z.string(),
          proxy: z.string().optional(),
          basepath: z.string().optional(),
          repo: z.string().optional(),
          at: z.array(z.string()),
          callers: z.array(z.string()),
          owner: OwnerOf,
        }),
      ),
      /** 2.43.0 (ADR 0156): who calls the callers, by depth (2 up to 5) then component. */
      chain: z
        .array(
          z.object({
            component: z.string(),
            repo: z.string().optional(),
            depth: z.number().int(),
            via: z.array(z.string()),
            entries: z.array(z.string()),
            verdict: z.enum(["breaks", "may-break"]),
            guessed: z.enum(JOIN_GUESS_FLAGS).optional(),
            restsOn: z.string().optional(),
            interfaces: z.array(z.string()),
            flows: z.array(z.string()),
            routes: z.array(z.string()),
            at: z.array(z.string()),
            owner: OwnerOf,
          }),
        )
        .optional(),
      /** The walk stopped at its depth cap with callers still above. */
      capped: z.literal(true).optional(),
    }),
  ),
  owners: z.array(z.object({ owner: OwnerOf, repos: z.array(z.string()) })),
  /** What couldn't be read: target flows, the manifests, roles.yaml. */
  problems: z.array(z.string()),
});
export type ChangeImpactT = z.infer<typeof ChangeImpact>;

/** Where a conformance item is: a file of the repo at the branch's commit, or the target flow. */
const ConformCite = z.object({
  source: z.enum(["artifact", "code"]),
  repo: z.string().optional(),
  path: z.string(),
  line: z.number().int().positive().optional(),
});

/** One thing the conformance check looked for, or found that no target flow names (ADR 0114). */
export const ConformItem = z.object({
  status: z.enum(["found", "missing", "still-there", "unexpected"]),
  check: z.enum(["call", "publish", "table", "column", "migration", "trigger", "endpoint"]),
  /** The target flow and its step (from 1); none for something no target flow names. */
  flow: z.string().optional(),
  item: z.number().int().positive().optional(),
  task: z.string().optional(),
  what: z.string(),
  record: z.string().optional(),
  at: z.array(ConformCite),
  /** The finding it became on the conform gate, and its state; none for what was found. */
  finding: z.object({ id: z.string(), state: z.string() }).optional(),
});
export type ConformItemT = z.infer<typeof ConformItem>;

/**
 * The newest conformance check of one repo of a change (ADR 0114), as stored in the change
 * folder at conform/<repo>.yaml: the branch's commit scanned, compared with the target flows.
 */
export const ConformRepoResult = z.object({
  schemaVersion: z.literal(1),
  change: RecordId,
  repo: z.string(),
  /** The branch checked, and the commits: the branch's and the base it was cut from. */
  ref: z.string(),
  commit: z.string(),
  base: z.string(),
  /** The task whose steps were checked; none: every step of the repo's target flows. */
  task: z.string().optional(),
  checkedAt: z.string(),
  counts: z.object({
    found: z.number().int(),
    missing: z.number().int(),
    stillThere: z.number().int(),
    unexpected: z.number().int(),
  }),
  items: z.array(ConformItem),
  /**
   * Steps no scan can show (a branch, a transform), and (2.76.0) what the facts don't cover at
   * the commit, so the code couldn't confirm it: a person or a test checks them.
   */
  unchecked: z.array(
    z.object({
      flow: z.string(),
      item: z.number().int().positive().optional(),
      kind: z.string(),
      why: z.string(),
    }),
  ),
  problems: z.array(z.string()),
});
export type ConformRepoResultT = z.infer<typeof ConformRepoResult>;

/** A change's newest conformance results, one per repo checked (ADR 0114). */
export const ChangeConformance = z.object({
  change: RecordId,
  title: z.string(),
  /** How many target flows the change has; 0: nothing to compare yet. */
  flows: z.number().int(),
  results: z.array(ConformRepoResult),
  /** The built-in gate the findings are on, and its newest round. */
  gate: z.literal("conform"),
  round: z.number().int().positive().optional(),
  problems: z.array(z.string()),
});
export type ChangeConformanceT = z.infer<typeof ChangeConformance>;
export type TargetFlowListT = z.infer<typeof TargetFlowList>;
export type TargetFlowViewT = z.infer<typeof TargetFlowView>;

export type SpecListT = z.infer<typeof SpecList>;
export type SpecViewT = z.infer<typeof SpecView>;
export type FlowViewT = z.infer<typeof FlowView>;

export const OrgPackView = z.object({
  defaulted: z.array(z.string()),
  counts: z.record(z.string(), z.number().int()),
  problems: z.array(z.object({ file: z.string(), path: z.string(), message: z.string() })),
});

export const Health = z.object({
  version: z.string(),
  apiVersion: z.string(),
  schemaVersion: z.number().int(),
  root: z.string(),
  openspec: z.string().optional(),
  user: z.string(),
  /** 2.22.0: started with `atticus ui --full`, so the app offers every page, not only the six. */
  full: z.boolean().optional(),
  /**
   * 3.5.0 (ADR 0190): whether the folder the app runs in is a metarepo (org-pack/, or
   * .atticus/org-pack/). When it isn't, the app offers Create the metarepo here.
   */
  metarepo: z.boolean().optional(),
});

// ------------------------------------------------------------------ request bodies

export const ScanRequest = z.strictObject({
  repos: z.array(RecordId).optional(),
  /** Ignore the cache and rescan everything. */
  full: z.boolean().default(false),
  /** Another branch, scanned beside the baseline into catalog/branches/<branch>/ (ADR 0123). */
  ref: GitRef.optional(),
  /**
   * 3.3.0 (app-only audit): the app's scan is a cross-check with the built-in readers, and asks
   * which repo answers on an unknown host only for the repos the assistant has read (facts on
   * file); `askAll` asks for every repo, as the command line's `atticus scan` does.
   */
  askAll: z.boolean().optional(),
});

/** ADR 0123: each repo's branches, as the Repos screen shows them. */
export const RepoBranchesView = z.object({
  id: RecordId,
  platform: z.string(),
  url: z.string(),
  type: z.string(),
  owner: z.string(),
  /** 2.28.0: what it is, in a person's words (ADR 0128); left out when nothing says. */
  description: RepoAbout.optional(),
  defaultBranch: z.string(),
  /** The branch the remote calls its default, as the base clone last heard it. */
  remoteDefault: z.string().optional(),
  branches: z.array(z.string()),
  /** The base clone's commit: what the baseline catalog was read from. */
  commit: z.string().optional(),
  /** Its branches scanned beside the baseline, with when and at which commit. */
  scans: z.array(z.object({ branch: z.string(), scannedAt: z.string(), commit: z.string() })),
  /**
   * 2.74.0: the manifest's build command for this repo, when it names one. A task drafted in a
   * repo without one isn't built or tested, so its PR isn't raised.
   */
  build: z.string().optional(),
});
export const RepoBranchesList = z.object({ repos: z.array(RepoBranchesView) });
/** What a branch's catalog changes against the baseline, for the repos it read. */
export const BranchCompare = z.object({
  branch: z.string(),
  scannedAt: z.string(),
  repos: z.array(z.object({ id: z.string(), commit: z.string() })),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.object({ record: z.string(), fields: z.array(z.string()) })),
});
export const EditRepoBranchesRequest = z.strictObject({
  defaultBranch: GitRef.optional(),
  branches: z.array(GitRef).optional(),
  /** 2.62.0: the branches as the form showed them; 409 when the manifest says otherwise now. */
  was: z.strictObject({ defaultBranch: z.string(), branches: z.array(z.string()) }).optional(),
});
/**
 * 2.74.0: a repo's build command in its manifest, set on a person's click; empty clears it. `was`
 * is the command the form showed ("" for none): 409 when the manifest says otherwise now.
 */
export const EditRepoBuildRequest = z.strictObject({
  build: z.string().max(500),
  was: z.string().optional(),
});
/** 2.74.0: who looks after the org pack (pack.yaml's owner), set on a person's click. */
export const SetOrgPackOwnerRequest = z.strictObject({
  owner: z.string(),
  /** The owner the form showed ("" for none): 409 when pack.yaml says otherwise now. */
  was: z.string().optional(),
});
/** WP7.5: follow a change, or stop following it (the person's own .atticus/me.yaml). */
export const WatchRequest = z.strictObject({ change: RecordId, watch: z.boolean() });

/** WP7.2: the lines around each line a question cites. */
export const QuestionEvidenceList = z.object({
  excerpts: z.array(
    z.object({
      ref: z.string(),
      line: z.number().int(),
      start: z.number().int(),
      lines: z.array(z.string()),
      found: z.boolean(),
    }),
  ),
});
export type QuestionEvidenceListT = z.infer<typeof QuestionEvidenceList>;

/** WP7.1: the change cockpit, what a person needs to follow one change. */
export const ChangeCockpit = z.object({
  id: z.string(),
  state: z.string(),
  next: z
    .object({
      step: z.string(),
      command: z.string(),
      slash: z.string().optional(),
      why: z.string(),
      /** 2.72.0: the hand-off PR a `merge` step waits on (manual:// on a manual Git host). */
      pr: z.string().optional(),
    })
    .passthrough()
    .optional(),
  nextStep: z.string(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  risk: z.object({ level: z.string(), score: z.number() }),
  /** Where the stages' work is against the state (ADR 0124 addendum B-change, 2.25.0). */
  work: z.string().optional(),
  stages: z.array(
    z.object({
      stage: z.enum(["feature", "architecture", "stories"]),
      state: z.string(),
      drafts: z.number().int(),
      rounds: z.number().int(),
      openQuestions: z.number().int(),
    }),
  ),
  openQuestions: z.number().int(),
  /**
   * 2.79.0 (ADR 0181 part 4): the change's open questions by the role that owns them, and the
   * signed-in person's roles on it (change.yaml `owners`; empty when it doesn't name them).
   */
  openQuestionsByRole: z.partialRecord(QuestionRole, z.number().int()).optional(),
  yourRoles: z.array(QuestionRole).optional(),
  /** 3.6.0 (ADR 0191): who the change waits on now, by role and name. */
  waitsOn: z.lazy(() => WaitsOn).optional(),
  repos: z.array(
    z.object({ id: z.string(), branch: z.string(), base: z.string(), pr: z.string().optional() }),
  ),
});
export type ChangeCockpitT = z.infer<typeof ChangeCockpit>;
export type RepoBranchesViewT = z.infer<typeof RepoBranchesView>;
export type RepoBranchesListT = z.infer<typeof RepoBranchesList>;
export type BranchCompareT = z.infer<typeof BranchCompare>;

export const NewChangeRequest = z.strictObject({
  id: RecordId,
  title: z.string().min(1),
  type: RecordId,
  /** A work-tracker item the change starts from. */
  from: z.string().optional(),
  /** ADR 0043: role → people, the systems it touches and a change template. */
  owners: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  systems: z.array(z.string()).optional(),
  template: z.string().optional(),
  /** WP7.6: an archived change to start from (its folder or its id), attached as an example. */
  like: z.string().min(1).optional(),
});

/** 2.65.0 (ADR 0183): what Propose for review commits, and the person's yes to it. */
export const ProposeScope = z.enum([
  "answers",
  "corrections",
  "audit",
  "org-pack",
  /** 2.67.0 (UX review): owners' answers to the knowledge gaps, catalog/curated/ownerquestion/. */
  "owner-answers",
  /** 2.67.0 (UX review): the accepted baseline, catalog/baseline.yaml, over the catalog. */
  "baseline",
  /** 2.67.0 (UX review): initiatives, their commitments and notes; outcomes after release. */
  "initiatives",
  "outcomes",
  /** 2.67.0 (UX re-walk): everything the app's work writes, for the one Propose on Home. */
  "work",
  /** 2.67.0 (UX review): the changes' snow.md, after filling a service-desk draft's fields. */
  "service-desk",
]);
export const ProposePlanView = z.object({
  scope: ProposeScope,
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      from: z.string().optional(),
      /** Round 37: already in an open proposal, as this content: its PR, or its branch. */
      proposed: z.string().optional(),
    }),
  ),
  branch: z.string(),
  title: z.string(),
  /**
   * 2.69.0 (sixth UX walk): the repos whose corrections are newer than their last Apply, so the
   * map in the PR would miss them; a repo applied since its last correction isn't listed. 2.70.0
   * (seventh UX walk): and the repos whose answered map questions are newer than their last Apply.
   */
  applyFirst: z.array(z.string()).optional(),
});

/**
 * 3.0.0 (ADR 0186, review round 48): the writes to shared systems a person confirms in the app.
 * The session token drives the API and is printed for assistants and scripts (`--show-token`),
 * so it isn't a person's yes: the app's page asks for a confirmation (POST /api/confirmations,
 * with the page key only the page is given) when the person clicks, and the write sends it once.
 * `merge` is Sync's merge of a ready PR; `ai-model` a change of where runtime.yaml sends the
 * model's key (its provider, keyEnv or an address); `ai-test` a Test of settings not committed.
 */
export const CONFIRMED_WRITES = [
  "handoff",
  "release-prs",
  "merge",
  "task-pr",
  "digest-send",
  "propose",
  "step-run",
  "ai-model",
  "ai-test",
  // 3.6.0 (ADR 0191): the plan's work items in a live work tracker, and an owner question sent.
  "work-items",
  "owner-ask",
] as const;
export const ConfirmedWrite = z.enum(CONFIRMED_WRITES);
/** A confirmation the server gave the page: single use, for one write and target, two minutes. */
export const Confirmation = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "a confirmation");
export const ConfirmationRequest = z.strictObject({
  write: ConfirmedWrite,
  /**
   * What the write is for: the change, `<change>/<task>`, the step, the scope, the digest's
   * channel (3.1.0; `me` before) or `model`.
   */
  target: z.string().min(1).max(400),
  /** The page's own key, from its <meta name="atticus-page-key">; never printed. */
  pageKey: z.string().max(200).optional(),
});
export const ConfirmationView = z.object({
  confirmation: Confirmation,
  write: ConfirmedWrite,
  target: z.string(),
  expiresAt: z.string(),
});
/** The body of a write that takes nothing but the person's confirmation. */
export const ConfirmedRequest = z.strictObject({ confirmation: Confirmation.optional() });
export type ConfirmedWriteT = z.infer<typeof ConfirmedWrite>;
export type ConfirmationViewT = z.infer<typeof ConfirmationView>;

export const ProposeRequest = z.strictObject({
  scope: ProposeScope,
  /** Exactly the files the person saw listed; one that changed back since is left out. */
  files: z.array(z.string().min(1)).min(1),
  title: z.string().max(200).optional(),
  /** The branch GET's plan showed, so the PR is on the branch the person saw. */
  branch: z.string().max(200).optional(),
  /** 3.0.0 (ADR 0186): the person's confirmation from the app (`propose`, the scope). */
  confirmation: Confirmation.optional(),
});
export const LinesView = z.object({
  code: z.number().int().optional(),
  lines: z.array(z.string()),
});

/**
 * 2.67.0 (UX review, 2026-11-08): a knowledge gap's owner question (ADR 0021), as the Questions
 * page lists it and answers it. The answer is written to `file`, a curated OwnerQuestion record
 * (the same `atticus questions owner <id> --text` writes); the gap closes once the fact is in
 * the catalog.
 */
export const OwnerQuestionView = z.object({
  id: RecordId,
  system: z.string(),
  owner: z.string(),
  question: z.string(),
  neededFact: z.string(),
  channel: z.string(),
  state: z.enum(["sent", "answered", "overdue"]),
  answer: z.string().optional(),
  routeTo: z.string().optional(),
  fill: z.array(z.object({ file: z.string(), field: z.string(), what: z.string() })).optional(),
  records: z.array(z.string()),
  file: z.string(),
  /**
   * 2.83.0 (ninth UX walk): a critic knowledge gap a person asked of its owner (Ask): the change,
   * gate and finding. Its answer closes the gap at the gate.
   */
  finding: z.object({ change: z.string(), gate: z.string(), id: z.string() }).optional(),
});
export const OwnerQuestionList = z.object({
  /** The catalog has no records yet. */
  empty: z.boolean(),
  /** Not answered yet: the number Home shows. */
  open: z.number().int().nonnegative(),
  questions: z.array(OwnerQuestionView),
});
export const OwnerAnswerRequest = z.strictObject({
  answer: z.string().max(4000),
});
export const OwnerAnswerResult = z.object({
  file: z.string(),
  question: OwnerQuestionView,
});
export type OwnerQuestionViewT = z.infer<typeof OwnerQuestionView>;
export type OwnerQuestionListT = z.infer<typeof OwnerQuestionList>;
export type OwnerAnswerResultT = z.infer<typeof OwnerAnswerResult>;

/** 2.64.0: a change type, as the New change form offers it. */
export const ChangeTypeView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

/** WP7.6: an archived change near a new brief. */
export const PastChange = z.object({
  /** The archive folder's name, <date>-<id>. */
  id: z.string(),
  change: z.string(),
  title: z.string(),
  archived: z.string().optional(),
  summary: z.string(),
  file: z.string(),
  /** cos for meaning, the words' score for words. */
  score: z.number(),
});

/** WP7.6: the archived changes nearest a new brief, by meaning or, where that is off, by words. */
export const SimilarChanges = z.object({
  how: z.enum(["meaning", "words"]),
  note: z.string().optional(),
  changes: z.array(PastChange),
});
export type SimilarChangesT = z.infer<typeof SimilarChanges>;

/** WP7.6: attach an archived change to a change as an example its steps read (ADR 0113). */
export const AttachPastChangeRequest = z.strictObject({ like: z.string().min(1) });
export const AttachPastChangeResult = z.object({
  /** The archive folder attached. */
  like: z.string(),
  /** Where it went in the change: inputs/like-<id>.md. */
  file: z.string(),
});

/** ADR 0113: a file attached to a change, as inputs/index.yaml lists it. */
export const ChangeInput = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.string(),
  format: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  addedBy: z.string(),
  addedAt: z.string(),
  /** text: a reader read it, cited by line or page; needs-reading: a picture or a file no reader takes. */
  read: z.enum(["text", "needs-reading"]),
  readAs: z.string().optional(),
  citeBy: z.enum(["line", "page", "section"]).optional(),
  version: z.string().optional(),
  date: z.string().optional(),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
  defences: z
    .object({ risk: z.enum(["medium", "high"]), reason: z.string(), rules: z.array(z.string()) })
    .optional(),
});
export const ChangeInputList = z.object({ files: z.array(ChangeInput) });

/** ADR 0113: one file to attach, its bytes in base64; at most 15 MB of file. */
export const AttachFileRequest = z.strictObject({
  name: z.string().min(1).max(200),
  content: z
    .string()
    .min(1)
    .max(20 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64"),
});

export const AttachResult = z.object({
  added: z.array(ChangeInput),
  refused: z.array(z.object({ name: z.string(), why: z.string() })),
  notes: z.array(z.string()),
});
/** A file in the metarepo's inputs/ (ADR 0122): what it is, whether it was read, its items. */
export const DocumentView = z.object({
  path: z.string(),
  kind: z.string(),
  title: z.string().optional(),
  systems: z.array(z.string()),
  state: z.enum(["read", "skipped", "not-synced"]),
  reason: z.string().optional(),
  duplicateOf: z.string().optional(),
  supersededBy: z.string().optional(),
  inbox: z.boolean(),
  modifiedAt: z.string().optional(),
  items: z.array(z.object({ id: z.string(), title: z.string(), verified: z.boolean() })),
});
export const DocumentList = z.object({
  documents: z.array(DocumentView),
  snapshot: z.object({ date: z.string() }).nullable(),
  commands: z.array(z.string()),
});
export const AddDocumentResult = z.object({
  added: z.array(z.object({ name: z.string(), path: z.string(), kind: z.string() })),
  refused: z.array(z.object({ name: z.string(), why: z.string() })),
});
export const PromoteResult = z.object({ path: z.string(), note: z.string() });
export type DocumentViewT = z.infer<typeof DocumentView>;
export type DocumentListT = z.infer<typeof DocumentList>;
export type AddDocumentResultT = z.infer<typeof AddDocumentResult>;

export type ChangeInputT = z.infer<typeof ChangeInput>;
export type ChangeInputListT = z.infer<typeof ChangeInputList>;
export type AttachResultT = z.infer<typeof AttachResult>;

// ------------------------------------------------------------------ a prototype compared (ADR 0133)

/** One end of the comparison: a fact, its repo and component, and the line it cites. */
const PrototypeEnd = z.object({
  repo: z.string(),
  fact: z.string(),
  component: z.string(),
  at: z.string(),
});
const PrototypeSaid = z.object({ value: z.string(), at: z.string() });

/** One way the estate (or a vendor) serves an operation other than as the prototype needs. */
export const PrototypeDifferenceView = z.object({
  kind: z.enum([
    "field-missing",
    "field-type",
    "field-required",
    "field-enum",
    "header-missing",
    "header-required",
    "error-missing",
    "error-unhandled",
    "scope-missing",
    "auth",
  ]),
  side: z.enum(["request", "response"]).optional(),
  field: z.string().optional(),
  scope: z.string().optional(),
  value: z.string().optional(),
  status: z.string().optional(),
  prototype: PrototypeSaid,
  estate: PrototypeSaid.optional(),
  message: z.string(),
});

/** One call of the prototype (a screen's to its BFF, the BFF's to a mock), placed in a group. */
export const PrototypeCallView = z.object({
  id: z.string(),
  leg: z.enum(["ui-bff", "bff-mock"]),
  group: z.enum(["exists", "changes", "new", "vendor"]),
  method: z.string().optional(),
  path: z.string(),
  call: PrototypeEnd,
  lands: PrototypeEnd,
  auth: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  estate: z
    .object({
      entry: PrototypeEnd,
      endpoint: z.string(),
      how: z.string(),
      gateway: z.array(z.string()).optional(),
      auth: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  vendor: z
    .object({
      system: z.string(),
      name: z.string(),
      operation: z.string(),
      method: z.string(),
      path: z.string(),
      at: z.string().optional(),
      through: z.array(z.string()),
      boundary: z.enum(["vendor", "internal"]).optional(),
    })
    .optional(),
  candidates: z.array(PrototypeEnd).optional(),
  differences: z.array(PrototypeDifferenceView),
  sentence: z.string(),
});

export const PrototypeComparisonView = z.object({
  prototype: z.string(),
  counts: z.object({
    exists: z.number().int(),
    changes: z.number().int(),
    new: z.number().int(),
    vendor: z.number().int(),
  }),
  calls: z.array(PrototypeCallView),
  repos: z.array(z.string()),
  uses: z.array(z.string()),
  endpoints: z.array(z.string()),
  vendorOperations: z.array(z.string()),
  vendors: z.array(z.string()),
  left: z.array(z.object({ call: PrototypeEnd, why: z.string() })),
});

/**
 * A prototype attached to a change (`atticus change attach <change> --prototype <repo>`), compared
 * again from today's facts; `problem` says why it can't be (its facts aren't verified, it is no
 * longer typed a prototype).
 */
export const ChangePrototype = z.object({
  repo: z.string(),
  /** The attached comparison: inputs/prototype-<repo>.md. */
  attached: z.string(),
  about: z.object({ text: z.string(), trust: z.enum(["suggested", "verified"]) }).optional(),
  comparison: PrototypeComparisonView.optional(),
  problem: z.string().optional(),
});
export const ChangePrototypeList = z.object({
  prototypes: z.array(ChangePrototype),
  /** Round 36: the repos the manifest types prototype, for the page's Compare. */
  candidates: z.array(z.string()).optional(),
});
/** Round 36: compare a prototype from the app, as `atticus change attach <change> --prototype <repo>`. */
export const ComparePrototypeRequest = z.strictObject({ repo: z.string().trim().min(1).max(200) });
/** The prototypes attached now, and what the command printed (the four groups, the footprint). */
export const ComparePrototypeView = ChangePrototypeList.extend({ lines: z.array(z.string()) });
export type ComparePrototypeViewT = z.infer<typeof ComparePrototypeView>;
export type PrototypeCallViewT = z.infer<typeof PrototypeCallView>;
export type ChangePrototypeT = z.infer<typeof ChangePrototype>;
export type ChangePrototypeListT = z.infer<typeof ChangePrototypeList>;

export const SaveArtifactRequest = z.strictObject({
  content: z.string(),
  /** The sha256 the edit started from; a mismatch returns 409. */
  baseSha256: z.string(),
});

export const StartRunRequest = z.strictObject({
  agent: RecordId,
  runtime: RuntimeKind.default("hand-off"),
  /** For task runs: the task id and the autonomy level wanted (capped by runtime.yaml). */
  task: z.string().optional(),
  autonomy: z.enum(["plan-only", "draft", "draft-and-pr"]).optional(),
});

export const FindingActionRequest = z.strictObject({
  action: FindingAction,
  reason: z.string().min(1).optional(),
  askedOf: z.string().min(1).optional(),
  /** For edit-and-apply: the edited fix. */
  patch: z.string().optional(),
  /** ADR 0043: the gate the finding belongs to, when the id alone is ambiguous. */
  gate: z.string().optional(),
});

export const OpenWorkspaceRequest = z.strictObject({ repos: z.array(RecordId).min(1) });

/** ADR 0043: the phase defaults to the change's current one; repo names the metarepo when runtime.yaml doesn't. */
export const HandoffRequest = z.strictObject({
  phase: Phase.optional(),
  repo: z.string().optional(),
  /** 3.0.0 (ADR 0186): the person's confirmation from the app (`handoff`, the change). */
  confirmation: Confirmation.optional(),
});

/**
 * ADR 0043: refresh a change from its hand-off PR. 3.0.0 (ADR 0186): with a confirmation
 * (`merge`, the change) it merges a ready PR as the person; without one it only reads.
 */
export const SyncRequest = z.strictObject({
  repo: z.string().optional(),
  confirmation: Confirmation.optional(),
});

/** ADR 0184: raise the release PRs, change/<id> into each code repo's default branch. */
export const ReleasePrsRequest = z.strictObject({ confirmation: Confirmation.optional() });
/** 2.75.0 (seventh UX walk): tick (done) or untick a task in the change's tasks.md. */
export const TaskDoneRequest = z.strictObject({
  done: z.boolean(),
  /**
   * 3.3.0 (app-only audit): why the task's work isn't needed, when its branch has commits the
   * change branch hasn't (else marking it done is 409); recorded with the person's name.
   */
  reason: z.string().max(2000).optional(),
});
/**
 * 3.3.0 (app-only audit): Set the upstream of the branch checked out to the same branch on a
 * remote (`<remote>/<branch>`), when Bring in what merged found it follows none.
 */
export const UpstreamRequest = z.strictObject({
  upstream: z
    .string()
    .regex(/^[A-Za-z0-9][\w.-]*\/[\w./-]+$/, "a remote branch, such as origin/main"),
});
/** 3.3.0 (app-only audit): Build and raise PR; `raise` pushes and opens the PR (`task-pr`). */
export const TaskBuildRequest = z.strictObject({
  raise: z.boolean().optional(),
  confirmation: Confirmation.optional(),
});
/**
 * 2.83.0 (ninth UX walk): name a change's owners per role from the change page (an empty list
 * clears a role): the product owner, the architect, the business analyst and the tech lead
 * (team-lead). Other owner keys of change.yaml are kept.
 */
export const CHANGE_OWNER_ROLES = [
  "product-owner",
  "architect",
  "business-analyst",
  "team-lead",
] as const;
export const ChangeOwnersRequest = z.strictObject({
  owners: z.partialRecord(z.enum(CHANGE_OWNER_ROLES), z.array(z.string().trim().min(1)).max(20)),
});

/**
 * 2.79.0 (ADR 0181 part 4): Run all ready tasks. Every task not done yet, in the cross-repo order
 * (the deployment plan's order of the repos, else tasks.md's), ready to run or why not: a task
 * waits for the tasks of the stories its story depends on, and one already run waits on its PR,
 * the assistant or a person.
 */
export const ReadyTasks = z.object({
  change: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      ready: z.boolean(),
      waitsFor: z.array(z.string()),
      /** 2.83.0 (ninth UX walk): of waitsFor, the earlier not-done tasks of its own repo. */
      sameRepo: z.array(z.string()).optional(),
      why: z.string().optional(),
    }),
  ),
  /** The ready ones' ids, in the order they run. */
  ready: z.array(z.string()),
  /** The repos in the order they deploy, when the deployment plan could be made. */
  repoOrder: z.array(z.string()).optional(),
});
export type ReadyTasksT = z.infer<typeof ReadyTasks>;

/**
 * 2.79.0 (ADR 0181 part 4): run the ready tasks one after another as one server job. The app never
 * asks for the pr level (that is the person's --approve, in an editor or on the command line), so
 * the click is the approval for draft; `tasks` names the ready ones the person saw.
 */
export const RunReadyRequest = z.strictObject({
  level: z.enum(["plan", "draft"]).optional(),
  runtime: RuntimeKind.optional(),
  tasks: z.array(z.string()).optional(),
});
export const RunReadyAccepted = z.object({
  jobId: z.string(),
  /** The tasks the job runs, in order. */
  tasks: z.array(z.string()),
});
/** What the job's result says when it ends: each task run's state, and where it stopped and why. */
export const RunReadyResult = z.object({
  ran: z.array(
    z.object({
      task: z.string(),
      repo: z.string(),
      state: z.string().optional(),
      branch: z.string().optional(),
      refused: z.string().optional(),
    }),
  ),
  stopped: z.object({ task: z.string(), why: z.string() }).optional(),
  left: z.array(z.string()),
});
export type RunReadyResultT = z.infer<typeof RunReadyResult>;

/** ADR 0043, Release and Run screens: request bodies the CLI's uiRunRoutes parse. */
export const StepDoneRequest = z
  .strictObject({
    values: z.record(z.string(), z.string()).default({}),
    skip: z.boolean().optional(),
    note: z.string().trim().min(1).optional(),
    change: z.string().optional(),
  })
  .refine((x) => !x.skip || x.note, { message: "Say why you skip it.", path: ["note"] });
export const StepRunRequest = z.strictObject({
  with: z.string().min(1),
  inputsSha256: z.string().regex(/^[0-9a-f]{64}$/, "the sha-256 the preview showed"),
  fillOnly: z.boolean().optional(),
  change: z.string().optional(),
  /** 3.0.0 (ADR 0186): the person's confirmation from the app (`step-run`, the step). */
  confirmation: Confirmation.optional(),
});
export const ArchiveRequest = z.strictObject({ rescan: z.boolean().optional() });
export const DraftRequestsRequest = z.strictObject({ force: z.boolean().optional() });
/** Round 36 (UX review): fill a draft's fields in snow.md from the app. */
export const FillRequestFieldsRequest = z.strictObject({
  /** The request's heading in snow.md, as GET /api/service-desk gives it. */
  heading: z.string().min(1).max(300),
  /** The sha256 of snow.md the form was filled from (GET's `sha256`); a mismatch is 409. */
  baseSha256: z.string().min(1).max(64),
  /** Field name → value. */
  values: z.record(z.string().min(1).max(100), z.string().max(2000)),
});
export const FilledRequestFieldsView = z.object({
  path: z.string(),
  sha256: z.string(),
  /** The request's required fields still empty. */
  missing: z.array(z.string()),
  lines: z.array(z.string()),
});
export type FilledRequestFieldsView = z.infer<typeof FilledRequestFieldsView>;
/** ADR 0045: record a measured outcome of a released change, as the signed-in person. */
export const RecordOutcomeRequest = z.strictObject({
  /** The measure's id, its number in the brief, or its words. */
  measure: z.string().trim().min(1),
  value: z.string().trim().min(1).max(500),
  note: z.string().trim().min(1).max(1000).optional(),
});
/** Live mode is part of the shape so the server can refuse it in words: it calls a real model. */
export const EvalRunRequest = z.strictObject({
  mode: z.enum(["mock", "replay", "live"]).default("mock"),
  agents: z.array(z.string().min(1)).optional(),
  runs: z.number().int().min(1).max(10).optional(),
});
export const StartLessonRequest = z.strictObject({ lesson: z.string().min(1) });
export const CheckLessonRequest = z.strictObject({
  answer: z.string().optional(),
  lesson: z.string().optional(),
  step: z.string().optional(),
});
export const SandboxRequest = z.strictObject({ dir: z.string().trim().min(1) });

/** ADR 0047: accept the as-is catalog as the baseline, as the person (their Git user, ADR 0073). */
export const BaselineRequest = z.strictObject({ note: z.string().trim().min(1).optional() });

/** ADR 0046: run the critic at a gate (the change's current one by default). */
export const RunCriticRequest = z.strictObject({ gate: z.string().min(1).optional() });

/** ADR 0048: how often the person wants their digest, and where it goes. */
export const SaveNotifyRequest = z.strictObject({
  digest: z.enum(["off", "daily", "weekly"]),
  channel: z.string().trim().min(1).optional(),
});

/** ADR 0048: show the digest, or send it through the notify adapter (the click is the approval). */
/**
 * 3.0.0 (ADR 0186): send needs the person's confirmation from the app (`digest-send`). 3.1.0
 * (review round 50): of the channel it posts to, GET /api/me's notify.to.
 */
export const SendDigestRequest = z.strictObject({
  send: z.boolean().default(false),
  confirmation: Confirmation.optional(),
});

/** ADR 0043: choose one of a triage item's numbered options; it writes a curated decision. */
export const TriageDecideRequest = z.strictObject({
  option: z.number().int().min(1),
  reason: z.string().trim().min(1).optional(),
});

export const ReconcileRequest = z.strictObject({ diagram: z.string().min(1) });

/**
 * UX review: an initiative starts in the app, as `atticus initiative new` starts it; the
 * signed-in person is recorded as who started it.
 */
export const NewInitiativeRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  journey: Initiative.shape.journey,
  /** Default: a slug of the title. */
  id: RecordId.optional(),
  /** The target release, YYYY-MM-DD. */
  release: z.iso.date().optional(),
  /** A work-tracker epic it belongs to. */
  epic: z.string().trim().min(1).max(200).optional(),
});
/** UX review: plan an initiative's changes and commitments, as `atticus initiative plan` does. */
export const InitiativePlanRequest = z.strictObject({
  /** The system the journey is about; may be left out when the initiative was planned before. */
  target: RecordId.optional(),
  release: z.iso.date().optional(),
  /** Other systems it touches. */
  systems: z.array(RecordId).optional(),
});
/**
 * UX review: record where a commitment stands, as `atticus initiative commit` does, with an
 * optional note kept in the initiative's notes.yaml.
 */
export const CommitmentStatusRequest = z.strictObject({
  status: Commitment.shape.commitmentStatus,
  note: z.string().trim().max(2000).optional(),
});
/** What a save of an initiative printed, and the initiative it was for. */
export const InitiativeSavedView = z.object({
  initiative: z.string(),
  lines: z.array(z.string()),
});

/** ADR 0078: the questions in questions/, and the files that aren't valid questions. */
export const QuestionList = z.object({
  questions: z.array(Question),
  problems: z.array(z.object({ file: z.string(), message: z.string() })),
  /**
   * 2.51.0: every question on file by state, whatever `state` or `mine` the list asked for, so a
   * page shows its counts from the one request. With `change` they are that change's; with `role`
   * that role's, as the list is (`byRole` stays every role's).
   */
  counts: z
    .object({
      open: z.number().int(),
      answered: z.number().int(),
      retired: z.number().int(),
      total: z.number().int(),
      /** The same, per repo, for a page that shows one repo's. */
      byRepo: z
        .record(
          z.string(),
          z.object({
            open: z.number().int(),
            answered: z.number().int(),
            retired: z.number().int(),
            total: z.number().int(),
          }),
        )
        .optional(),
      /**
       * 2.79.0 (ADR 0181 part 4): the same, per role that owns the questions (product,
       * architecture, analysis, delivery); a role no question has is left out. Before `role`.
       */
      byRole: z
        .partialRecord(
          QuestionRole,
          z.object({
            open: z.number().int(),
            answered: z.number().int(),
            retired: z.number().int(),
            total: z.number().int(),
          }),
        )
        .optional(),
    })
    .optional(),
  /**
   * 2.33.0 (ADR 0140), by question id: the changes in flight that rest on it, how many calls its
   * answer joins, and the team it goes to (the repo manifest's owner, named by roles.yaml) or why
   * none does.
   */
  about: z
    .record(
      z.string(),
      z.object({
        restsOn: z.array(z.string()),
        joins: z.number().int(),
        owner: z.union([
          z.object({ team: z.string(), name: z.string().optional() }),
          /** 2.41.0 (ADR 0153, Q4): a change's own question goes to the change's people. */
          z.object({ change: z.string(), people: z.array(z.string()) }),
          z.object({ none: z.string() }),
        ]),
        /**
         * 2.79.0 (ADR 0181 part 4): the role that owns it on its change: the question's own, else
         * the stage's that asked. Left out for a question no change's phase raised.
         */
        role: QuestionRole.optional(),
        /** 3.6.0 (ADR 0191): what it asks (business, design, delivery), its own or its role's. */
        asks: QuestionAsks.optional(),
        /**
         * 2.36.0 (ADR 0144, Q5): the answer the assistant proposed, for an open question, when
         * every line it cites says what it quotes. A person accepts it or answers otherwise.
         */
        proposal: z
          .object({
            answer: z.object({
              option: z.number().int().optional(),
              text: z.string().optional(),
            }),
            why: z.string(),
            cites: z.array(
              z.object({
                repo: z.string().optional(),
                file: z.string(),
                line: z.number().int(),
                quote: z.string(),
              }),
            ),
            by: z.string(),
            at: z.string(),
            file: z.string(),
          })
          .optional(),
        /**
         * 2.49.0 (ADR 0168): the rule one answer could take to cover this open targets question
         * and the other open ones of its repo whose calls share its path prefix or host.
         */
        rule: z
          .object({
            match: z.string(),
            ids: z.array(z.string()),
            calls: z.number().int(),
          })
          .optional(),
      }),
    )
    .optional(),
  /** 2.33.0 (ADR 0140): with mine=true, who the person is and the teams roles.yaml puts them on. */
  me: z
    .object({
      handle: z.string(),
      teams: z.array(z.object({ id: z.string(), name: z.string().optional() })),
    })
    .optional(),
  /**
   * 2.79.0 (ADR 0181 part 4): with change=, the signed-in person's roles on that change, from its
   * change.yaml `owners` (roles.yaml's custom roles by the role each is based on); empty when the
   * change doesn't name them, and the page asks which role is theirs.
   */
  yourRoles: z.array(QuestionRole).optional(),
});
export type QuestionListT = z.infer<typeof QuestionList>;

/** ADR 0078: answer a question with one of its options or in the person's own words. */
export const AnswerQuestionRequest = z.strictObject({
  option: z.number().int().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  /** The scope the person confirms; default the one proposed. */
  scope: QuestionScopeLevel.optional(),
  /** The repo type, when a repo question is widened to its type. */
  repoType: RecordId.optional(),
  /**
   * 2.36.0 (ADR 0144, Q5): accept the assistant's proposed answer, checked again, as the person's
   * own (in place of option or text).
   */
  acceptProposal: z.literal(true).optional(),
  /**
   * 2.41.0 (ADR 0153, Q2): the rule the answer covers, for a target or hosts question: a host
   * pattern (`*.payments.forge.internal`) or a path prefix (`/forge/limits/**`).
   */
  match: AnswerMatch.optional(),
  /**
   * 2.45.0 (ADR 0162, F8): for a targets question, the repo, system or team the call goes to, from
   * the picker (in place of option or text). A vendor not in the profile, or a team with no
   * system, needs `addSystem`: the system is written into the profile, for review.
   */
  target: z.string().trim().min(1).optional(),
  addSystem: z.enum(["vendor", "internal"]).optional(),
  /** The new system's name, with `addSystem`; the target's words when left out. */
  name: z.string().trim().min(1).optional(),
  /**
   * 3.10.0 (beta.24 review): Ignore, for a question about where calls go: they aren't real calls
   * (CI/CD, a test, a template), so the join leaves them and draws no box. In place of option,
   * text and target; `reason` is kept as the answer's words (`Ignore: <reason>`).
   */
  ignore: z.literal(true).optional(),
  reason: z.string().trim().min(1).max(300).optional(),
});

/** ADR 0078: the answered question, the command to run next and, for a repo type, its skill file. */
export const AnsweredQuestion = z.object({
  question: Question,
  rerun: z.string(),
  skill: z.object({ path: z.string(), written: z.boolean() }).optional(),
  /** 2.45.0 (ADR 0162): the system a `target` answer wrote into the profile. */
  system: z
    .object({
      id: z.string(),
      profile: z.string(),
      added: z.boolean(),
      boundary: z.enum(["vendor", "internal"]),
      owner: z.string().optional(),
    })
    .optional(),
});

/** 2.45.0 (ADR 0162, F8): the "Another repo…" picker of a targets question. */
export const TargetPickList = z.object({
  picks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["repo", "system", "team"]),
      name: z.string(),
      read: z.boolean().optional(),
      boundary: z.string().optional(),
      /** A team with no system yet: the system naming it adds to the profile (with addSystem). */
      adds: z
        .object({
          id: z.string(),
          name: z.string(),
          boundary: z.literal("internal"),
          owner: z.string(),
        })
        .optional(),
    }),
  ),
});
export type TargetPickListT = z.infer<typeof TargetPickList>;

// ------------------------------------------------------------------ knowledge (ADR 0101, 0102)

const FileProblem = z.object({ file: z.string(), message: z.string() });
const KnowledgeKindE = z.enum(KNOWLEDGE_KINDS);

/** The wiki types sources.yaml takes (C6). */
export const WIKI_TYPES = [
  "confluence",
  "ado-wiki",
  "sharepoint",
  "markdown-folder",
  "git",
  // 2.30.0 (ADR 0132): a space or site exported to a folder.
  "confluence-export",
  "sharepoint-export",
] as const;

/** A person's review of a knowledge item (ADR 0101); stale: its page changed since. */
export const KnowledgeReviewSummary = z.object({
  state: z.enum(["verified", "corrected", "rejected", "stale"]),
  verdict: z.enum(["verified", "corrected", "rejected"]),
  by: z.string(),
  at: z.string(),
  note: z.string().optional(),
  /** The fields a correction set. */
  corrected: z.array(z.string()).optional(),
});

/** One knowledge source of sources.yaml, with its newest snapshot. */
export const KnowledgeSource = z.object({
  id: z.string(),
  type: z.string(),
  location: z.string(),
  ref: z.string().optional(),
  path: z.string().optional(),
  checkout: z.enum(["clone", "submodule"]).optional(),
  owner: z.string().optional(),
  tags: z.object({ kinds: z.array(z.string()), frameworks: z.array(z.string()) }),
  /** 2.30.0 (ADR 0132): how much its word counts; left out, as a team's. */
  authority: z.enum(SOURCE_AUTHORITIES).optional(),
  /** 2.30.0: where it applies (sources.yaml appliesTo); left out, everywhere. */
  appliesTo: SourceScope.optional(),
  /** 2.30.0: appliesTo in words: "platforms gcp; new components". */
  scope: z.string().optional(),
  /** 2.30.0: page overrides of its authority or status. */
  byPage: z.number().int().optional(),
  readRestricted: z.boolean().optional(),
  maxPages: z.number().int().optional(),
  /** The newest snapshot `atticus sources sync` took; none before the first sync. */
  snapshot: z
    .object({
      date: z.string(),
      takenAt: z.string(),
      /** A git wiki's commit the pages were read at. */
      commit: z.string().optional(),
      pages: z.number().int(),
      skipped: z.number().int(),
      ageDays: z.number().int(),
    })
    .optional(),
  /** The snapshot the last knowledge scan read of it. */
  scanned: z.object({ date: z.string(), pages: z.number().int() }).optional(),
  /** No snapshot, or the newest is older than staleDays: sync it again. */
  stale: z.boolean(),
  /** The commands to read it: sync here, then the AI step in a terminal or Copilot Chat. */
  commands: z.object({ sync: z.string(), scan: z.string(), slash: z.string() }),
});

export const KnowledgeSourceList = z.object({
  file: z.string(),
  types: z.array(z.string()),
  kindSuggestions: z.array(z.string()),
  staleDays: z.number().int(),
  sources: z.array(KnowledgeSource),
  problems: z.array(FileProblem),
});

/** atticus sources add <type> <location> [--id --path --ref --submodule --kind --framework --owner --save]. */
export const AddSourceRequest = z.strictObject({
  type: z.enum(WIKI_TYPES),
  location: z.string().trim().min(1),
  id: RecordId.optional(),
  path: z.string().trim().min(1).optional(),
  ref: z.string().trim().min(1).optional(),
  submodule: z.boolean().optional(),
  kinds: z.array(RecordId).optional(),
  frameworks: z.array(RecordId).optional(),
  owner: z.string().trim().min(1).optional(),
  /** Write the entry into sources.yaml; without it, the entry to add is only printed. */
  save: z.boolean().default(true),
});

/** What a command printed, and its exit code (0 done, 1 done with problems to read). */
export const CommandOutput = z.object({
  code: z.number().int(),
  lines: z.array(z.string()),
  problems: z.array(z.string()),
});

/** A knowledge item as people reviewed it, with what Correct may set. */
export const KnowledgeItemView = z.object({
  id: z.string(),
  kind: KnowledgeKindE,
  /** The C1 kind it is stored as. */
  recordKind: z.string(),
  title: z.string(),
  /** The record, with any correction applied (C1). */
  record: z.record(z.string(), z.unknown()),
  review: KnowledgeReviewSummary.optional(),
  /** The fields a person may correct and whether each is text, a list or links. */
  fields: z.record(z.string(), z.enum(["text", "list", "links"])),
  /** Another page disagrees with it. */
  conflict: z.boolean(),
  /** 2.26.0: the pages that disagree about it, and who decided which applies. */
  conflicts: z.array(KnowledgeConflictView).optional(),
});

export const KnowledgeItemList = z.object({
  items: z.array(KnowledgeItemView),
  problems: z.array(FileProblem),
});

/** What the last knowledge scan read and changed, and the reviews to check again. */
export const KnowledgeScanView = z.object({
  scannedAt: z.string().optional(),
  snapshots: z.array(z.object({ source: z.string(), date: z.string(), pages: z.number().int() })),
  changes: z
    .object({
      at: z.string(),
      added: z.array(z.string()),
      changed: z.array(z.string()),
      removed: z.array(z.string()),
    })
    .optional(),
  checkAgain: z.array(
    z.object({ id: z.string(), kind: KnowledgeKindE, title: z.string(), by: z.string() }),
  ),
  conflicts: z.number().int(),
  injections: z.number().int(),
  failed: z.number().int(),
  command: z.string(),
  slash: z.string(),
});

const FieldValue = z.union([
  z.string(),
  z.array(z.string()),
  z.array(z.strictObject({ url: z.string().min(1), label: z.string().optional() })),
]);

/** atticus knowledge verify|correct|reject <item>, as the signed-in person. */
export const ReviewItemRequest = z.strictObject({
  verdict: z.enum(["verified", "corrected", "rejected"]),
  /** Required to reject: the reason. */
  note: z.string().trim().min(1).optional(),
  /** Correct only: field → value; a list takes strings, links take { url, label }. */
  set: z.record(z.string(), FieldValue).optional(),
});

export const ReviewedItem = z.object({ item: KnowledgeItemView, file: z.string() });

/** A section of a snapshot page that mentions the phrase searched for. */
export const PageMatch = z.object({
  source: z.string(),
  page: z.string(),
  section: z.string(),
  line: z.number().int(),
  excerpt: z.string(),
});

export const WikiSearchResult = z.object({
  phrase: z.string(),
  /** Sources with a snapshot to search. */
  sources: z.number().int(),
  matches: z.array(PageMatch),
  pages: z.array(z.string()),
  /** The AI step that reads those pages: the command and the slash command. */
  command: z.string(),
  slash: z.string(),
});

export const FindCandidateView = z.object({
  id: z.string(),
  kind: KnowledgeKindE,
  recordKind: z.string(),
  title: z.string(),
  record: z.record(z.string(), z.unknown()),
  /** The item it already is, when it is one. */
  known: z.string().optional(),
  kept: z.object({ by: z.string(), at: z.string(), as: KnowledgeKindE }).optional(),
  /** The kinds it can be kept as. */
  keepAs: z.array(KnowledgeKindE),
});

export const SavedFindView = z.object({
  slug: z.string(),
  phrase: z.string(),
  at: z.string(),
  file: z.string(),
  matches: z.array(PageMatch),
  candidates: z.array(FindCandidateView),
});

export const SavedFindList = z.object({ finds: z.array(SavedFindView) });

/** atticus knowledge keep <item> --find <slug> [--as kind] [--set f=v] [--note]. */
export const KeepCandidateRequest = z.strictObject({
  item: RecordId,
  as: KnowledgeKindE.optional(),
  note: z.string().trim().min(1).optional(),
  set: z.record(z.string(), FieldValue).optional(),
});

export const KeptCandidate = z.object({ item: KnowledgeItemView, as: KnowledgeKindE });

/** One need of a change (needs.yaml, ADR 0101), with its item's review. */
export const NeedView = z.object({
  item: z.string(),
  kind: KnowledgeKindE,
  title: z.string(),
  for: z.string(),
  why: z.string(),
  because: z
    .object({ file: z.string(), quote: z.string(), line: z.number().int().optional() })
    .optional(),
  when: z.enum(["before-design", "before-build", "before-release"]).optional(),
  from: z.enum(["assistant", "stories"]),
  leadTime: z.string().optional(),
  handledBy: z.string().optional(),
  catalogueItem: z.string().optional(),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  rules: z.array(z.string()),
  urls: z.array(z.object({ url: z.string(), label: z.string().optional() })),
  page: z.string().optional(),
  status: z.enum(["open", "done", "not-needed"]),
  note: z.string().optional(),
  by: z.string().optional(),
  at: z.string().optional(),
  review: KnowledgeReviewSummary.optional(),
});

export const ChangeNeedsView = z.object({
  change: z.string(),
  file: z.string(),
  /** False before atticus change needs has run for the change. */
  present: z.boolean(),
  updatedAt: z.string().optional(),
  needs: z.array(NeedView),
  considered: z.array(z.object({ item: z.string(), why: z.string() })),
  command: z.string(),
  slash: z.string(),
});

/** atticus needs done|skip|reopen <change> <item> [--for t] [--note]. */
export const MarkNeedRequest = z.strictObject({
  status: z.enum(["done", "not-needed", "open"]),
  /** Required for not-needed: why. For done, the ticket (a CTASK number, say). */
  note: z.string().trim().min(1).optional(),
  /** Which target, when the item is needed for more than one. */
  for: z.string().min(1).optional(),
});

export const MarkedNeed = z.object({ need: NeedView, file: z.string() });

/** A system the org pack draft proposes for a platform profile (ADR 0101). */
export const OrgPackProposalView = z.object({
  from: z.string(),
  kind: z.string(),
  action: z.enum(["add", "update"]),
  system: z.object({
    id: z.string(),
    name: z.string(),
    boundary: z.enum(["product", "internal", "vendor"]),
    owner: z.string().optional(),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
  }),
  adds: z
    .object({ aliases: z.array(z.string()).optional(), owner: z.string().optional() })
    .optional(),
  verified: z.boolean(),
  verifiedBy: z.string().optional(),
  quote: z.string().optional(),
  page: z.string().optional(),
  notes: z.array(z.string()),
});

export const OrgPackDraftView = z.object({
  platforms: z.array(
    z.object({
      platform: z.string(),
      file: z.string(),
      /** False before atticus orgpack draft has run for the platform. */
      present: z.boolean(),
      at: z.string().optional(),
      proposals: z.array(OrgPackProposalView),
      command: z.string(),
    }),
  ),
});

export const DraftOrgPackRequest = z.strictObject({ platform: RecordId.optional() });

/** atticus orgpack accept <platform> --only id,id: the picked proposals into profile.yaml. */
export const AcceptOrgPackRequest = z.strictObject({
  only: z.array(z.string().min(1)).min(1),
});

export const AcceptedOrgPack = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  left: z.number().int(),
  file: z.string(),
});

export type KnowledgeSourceListT = z.infer<typeof KnowledgeSourceList>;
export type KnowledgeSourceT = z.infer<typeof KnowledgeSource>;
export type KnowledgeItemViewT = z.infer<typeof KnowledgeItemView>;
export type KnowledgeItemListT = z.infer<typeof KnowledgeItemList>;
export type KnowledgeScanViewT = z.infer<typeof KnowledgeScanView>;
export type WikiSearchResultT = z.infer<typeof WikiSearchResult>;
export type SavedFindViewT = z.infer<typeof SavedFindView>;
export type SavedFindListT = z.infer<typeof SavedFindList>;
export type FindCandidateViewT = z.infer<typeof FindCandidateView>;
export type NeedViewT = z.infer<typeof NeedView>;
export type ChangeNeedsViewT = z.infer<typeof ChangeNeedsView>;
export type OrgPackDraftViewT = z.infer<typeof OrgPackDraftView>;
export type OrgPackProposalViewT = z.infer<typeof OrgPackProposalView>;
export type KnowledgeReviewSummaryT = z.infer<typeof KnowledgeReviewSummary>;
export type CommandOutputT = z.infer<typeof CommandOutput>;
export type AcceptedOrgPackT = z.infer<typeof AcceptedOrgPack>;
export type MarkedNeedT = z.infer<typeof MarkedNeed>;
export type ReviewedItemT = z.infer<typeof ReviewedItem>;
export type KeptCandidateT = z.infer<typeof KeptCandidate>;

// ------------------------------------------------------------------ correcting the map (ADR 0174)

/** The other box of a connection: a repo of the manifest, or an outside system of the profile. */
export const LinkBox = z
  .strictObject({ repo: z.string().min(1).optional(), system: z.string().min(1).optional() })
  .refine((b) => !!b.repo !== !!b.system, { message: "name a repo or a system" });
export const CandidateSuggestion = z.object({
  api: z.string(),
  score: z.number(),
  why: z.enum([
    "same-path",
    "prefix",
    "parameter",
    "names-alike",
    "setting",
    "operation-words",
    "forwarded-path",
  ]),
});
export const CandidateCallView = z.object({
  fact: z.string(),
  callType: z.string(),
  method: z.string().optional(),
  path: z.string(),
  at: z.string(),
  status: z.enum(["asked", "missed", "left", "outside", "unresolved", "paired"]),
  why: z.string().optional(),
  paired: z.string().optional(),
  suggestion: CandidateSuggestion.optional(),
  /** 2.57: the APIs it most likely is, best first, at most three. */
  suggestions: z.array(CandidateSuggestion).max(3).optional(),
  /** 2.57: the best suggestion is sure and well ahead: Pair all confident takes it. */
  confident: z.boolean().optional(),
});
export const CandidateApiView = z.object({
  id: z.string(),
  kind: z.enum(["entry", "route", "operation"]),
  method: z.string().optional(),
  path: z.string(),
  at: z.string().optional(),
  /** 2.57: words that name it besides its path (an operationId). */
  words: z.string().optional(),
  /** 2.57: a gateway route: the path it forwards to. */
  forwards: z.string().optional(),
});
export const LinkCandidatesView = z.object({
  from: z.string(),
  to: LinkBox,
  /** The other box's name as the picture shows it. */
  toName: z.string(),
  calls: z.array(CandidateCallView),
  apis: z.array(CandidateApiView),
  /**
   * No calls of A on record: the command that reads them first; `why: unverified` when A's facts
   * are read but not all verified (the join leaves them out), and the command verifies them.
   */
  noCalls: z.object({ command: z.string(), why: z.enum(["unverified"]).optional() }).optional(),
  /** No APIs of B on record: why, and how to get them (read the repo, verify it, or intake the spec). */
  noApis: z
    .object({ why: z.enum(["not-read", "unverified", "no-spec"]), command: z.string() })
    .optional(),
  /** An open target question of A that one /** answer to B would close, with the calls it covers. */
  rule: z.object({ question: z.string(), calls: z.number().int().min(0) }).optional(),
});
/** ADR 0178 part 2: Copilot matches A's loose calls with B's APIs; a person ticks the proposals. */
export const MatchLinksRequest = z.object({ from: z.string().min(1), to: LinkBox });
export const MatchProposal = z.object({
  /** The call's fact id. */
  call: z.string(),
  /** The API it proposes, one of B's. */
  api: z.string(),
  why: z.string(),
  /** The lines of the call site it names, as it named them. */
  lines: z.array(z.string()).default([]),
});
export const MatchLinksView = z.object({
  from: z.string(),
  to: LinkBox,
  /**
   * idle: no brief yet; running: a session is under way; handoff: the brief is written for a
   * person to read in Copilot Chat (copilot-acp isn't allowed here); done: an answer was read
   * and checked; failed: the session ended without one, or the answer didn't read.
   */
  state: z.enum(["idle", "running", "handoff", "done", "failed"]),
  /** The brief, relative to the metarepo, once written. */
  brief: z.string().optional(),
  /** The answer file the session (or the person) writes, relative to the metarepo. */
  answer: z.string().optional(),
  jobId: z.string().optional(),
  proposals: z.array(MatchProposal).default([]),
  /** Calls the answer says match nothing of B, with its reason. */
  none: z.array(z.object({ call: z.string(), why: z.string() })).default([]),
  /** Lines of the answer that named a call or an API that isn't one, left out. */
  rejected: z.array(z.string()).default([]),
  error: z.string().optional(),
  /**
   * 2.84.0 (ADR 0181, ninth UX walk): the hand-off run the brief waits on. Done (POST
   * /api/links/match/done, or Done on Model runs) reads the answer in and decides from it.
   */
  run: z.string().optional(),
  /**
   * 2.81.0 (ADR 0181): what Atticus applied itself, as the AI's, once the session's answer was
   * read (runtime.yaml decide.links: auto, not paused): the batch, each pairing applied with the
   * bar it met, and each kept as a proposal with why. Absent when nothing was decided.
   */
  decided: z
    .object({
      mode: z.enum(["auto", "propose"]),
      batch: z.string().optional(),
      applied: z.array(z.object({ call: z.string(), api: z.string(), bar: z.enum(DECIDE_BARS) })),
      kept: z.array(z.object({ call: z.string(), api: z.string(), why: z.string() })),
      /** Why deciding is paused back to propose (the sample audit), when it is. */
      paused: z.string().optional(),
    })
    .optional(),
});

// ------------------------------------------------------------------ AI decisions (ADR 0181)

/** How many links or questions were settled each way: from code, by a person, by AI. */
export const DecisionCounts = z.object({
  /** Links: joined from the code (a name, a repo, a host, a path, a topic). Questions: retired because the code or a rule answers them. */
  fromCode: z.number().int(),
  /** A person's pairing or answer, or a rule a person gave. */
  byPerson: z.number().int(),
  /** Decided by AI ("Detected by AI"), not confirmed by a person. */
  byAi: z.number().int(),
  /** Questions still open; links still loose (not counted for links). */
  open: z.number().int().optional(),
  /** 2.84.0: questions retired (the code or a rule settles them, or asks them no more). */
  retired: z.number().int().optional(),
});
/** One decision the AI applied that still stands: what every "Detected by AI" chip shows. */
export const AiDecisionItem = z.object({
  kind: z.enum(["link", "question"]),
  /** What `POST /api/decisions/correct` takes: `link:<repo>:<call fact id>`, or the question's id. */
  item: z.string(),
  repo: z.string(),
  /** The decision in words. */
  what: z.string(),
  /** What it decided: the API's id (a link), or the option's label (a question). */
  decided: z.string(),
  /** A link: the call as it is cited, and the API it was paired with. */
  call: z
    .object({ fact: z.string(), file: z.string(), line: z.number().int(), value: z.string() })
    .optional(),
  to: z
    .object({
      repo: z.string(),
      entry: z.string().optional(),
      method: z.string().optional(),
      path: z.string(),
    })
    .optional(),
  /** A question: its words, the option picked (from 1) and every option's label. */
  question: z
    .object({ text: z.string(), option: z.number().int(), options: z.array(z.string()) })
    .optional(),
  runtime: z.string(),
  run: z.string(),
  bar: z.enum(DECIDE_BARS).optional(),
  batch: z.string().optional(),
  at: z.string(),
  /** The lines the decision rests on, `<repo> file:line`. */
  cites: z.array(z.string()).default([]),
});
/** A batch of decisions applied at once, one Undo away. */
export const DecisionBatchView = z.object({
  id: z.string(),
  /** ai: applied by Atticus from an AI run; rule: a person's correction and what its rule spread. */
  kind: z.enum(["ai", "rule"]),
  at: z.string(),
  /** Who: the person, or "AI (copilot-acp, run <id>)". */
  by: z.string(),
  run: z.string().optional(),
  applied: z.number().int(),
  reverted: z.number().int(),
  correction: z
    .object({
      item: z.string(),
      answer: z.string(),
      rule: z
        .object({ kind: z.enum(["path", "host", "topic"]), match: z.string(), from: z.string() })
        .optional(),
    })
    .optional(),
  undone: z.object({ by: z.string(), at: z.string() }).optional(),
  /** Its record, relative to the metarepo. */
  file: z.string(),
});
/** Whether the AI decides now, as runtime.yaml says and the sample audit allows (Home). */
export const DecideStateView = z.object({
  configured: z.object({
    links: z.enum(["auto", "propose"]),
    questions: z.enum(["auto", "propose"]),
    minPrecision: z.number(),
  }),
  now: z.object({ links: z.enum(["auto", "propose"]), questions: z.enum(["auto", "propose"]) }),
  /** Paused back to propose: why, in words Home shows, and the audit's numbers. */
  paused: z
    .object({
      why: z.string(),
      precision: z.number(),
      low: z.number().nullable(),
      high: z.number().nullable(),
      answered: z.number().int(),
      minPrecision: z.number(),
    })
    .optional(),
  /** The sample audit's precision for the AI's decisions, every repo summed (Map › Trust). */
  precision: AuditTallyView,
  /**
   * 2.84.0: the runs whose answers the AI decides from here, as runtime.yaml allows them: a
   * Copilot session Atticus starts (`copilot-acp`), a hand-off run marked done (`hand-off`).
   * Empty: nothing here decides, whatever decide says.
   */
  decideIn: z.array(z.enum(AI_RUNTIMES)).optional(),
});
/** GET /api/decisions: the AI's decisions, the counts split three ways, the batches, the pause. */
export const DecisionsView = z.object({
  decide: DecideStateView,
  /** `counts`: the Interfaces of the map as last applied (the catalog), by how each was joined. */
  links: z.object({
    counts: DecisionCounts,
    items: z.array(AiDecisionItem),
    /** 2.84.0: the pairings that stand in the corrections files now, the AI's and people's. */
    lines: z.object({ byAi: z.number().int(), byPerson: z.number().int() }).optional(),
  }),
  questions: z.object({ counts: DecisionCounts, items: z.array(AiDecisionItem) }),
  /** Newest first. */
  batches: z.array(DecisionBatchView),
  problems: z.array(z.object({ file: z.string(), message: z.string() })).default([]),
});
export const CorrectDecisionRequest = z.object({
  /** `link:<repo>:<call fact id>`, or a question's id. */
  item: z.string().min(1),
  /** A question: the right option, from 1. */
  option: z.number().int().min(1).optional(),
  /** A link: the right API (an entry's fact id) and the repo it is in. */
  api: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  /** None of these: the call reaches none, or no option is right ("None of these"). */
  none: z.boolean().optional(),
  /** Apply to similar (on by default): derive a rule and re-check every AI decision and open item it covers. */
  similar: z.boolean().optional(),
  /** The rule to spread in place of the derived one (a path prefix, host or topic pattern). */
  match: z.string().min(1).max(300).optional(),
  /** Say what it would write and spread; write nothing (shown before saving). */
  preview: z.boolean().optional(),
});
/** One item a correction's rule re-checked, and what became of it. */
export const SpreadItemView = z.object({
  item: z.string(),
  repo: z.string(),
  what: z.string(),
  /** What the AI had decided (or nothing, for an open item). */
  was: z.string().optional(),
  /** What the person's rule says now (absent when reverted to open). */
  now: z.string().optional(),
  /** applied: an open item answered by the rule; confirmed: the AI agreed; replaced: the AI disagreed and the rule decides; reverted: the AI disagreed and the rule can't decide it, so it is open again. */
  change: z.enum(["applied", "confirmed", "replaced", "reverted"]),
});
export const CorrectDecisionResult = z.object({
  written: z.boolean(),
  batch: z.string().optional(),
  item: z.string(),
  /** The person's answer, in words. */
  answer: z.string(),
  rule: z
    .object({
      kind: z.enum(["path", "host", "topic"]),
      match: z.string(),
      /** True when Atticus derived it; false when the person gave it. */
      derived: z.boolean(),
    })
    .optional(),
  /** Why no rule spreads, when Apply to similar was on. */
  noRule: z.string().optional(),
  spread: z.array(SpreadItemView),
  counts: z.object({
    applied: z.number().int(),
    confirmed: z.number().int(),
    replaced: z.number().int(),
    reverted: z.number().int(),
  }),
  /**
   * The same shape corrected again and again (three times or more): propose a reading rule
   * (ADR 0176, "Make this a rule"). For a pairing, `line` is the person's line in the repo's
   * corrections, as POST /api/reading-rules/from-pairing takes it.
   */
  makeRule: z
    .object({
      corrections: z.number().int(),
      shape: z.string(),
      repo: z.string(),
      line: z.string().optional(),
      command: z.string().optional(),
    })
    .optional(),
  /** The files written (or to be), relative to the metarepo. */
  files: z.array(z.string()),
  /** The commands that bring the map up to it (atticus verify <repo> --write). */
  verify: z.array(z.string()),
  commit: z.string(),
});
export const UndoBatchResult = z.object({
  batch: z.string(),
  /** Lines and answers of the batch taken away. */
  removed: z.number().int(),
  /** AI lines and answers it had taken away, put back. */
  restored: z.number().int(),
  /** What changed since the batch and was left as it is now, in words. */
  skipped: z.array(z.string()),
  files: z.array(z.string()),
  verify: z.array(z.string()),
  commit: z.string(),
});
/**
 * 2.84.0 (ADR 0181, ninth UX walk): Ask AI to propose answers as a hand-off run. The person's
 * assistant writes the proposals; Done (POST /api/runs/{runId}/done) reads them in and decides
 * from them as the AI's when runtime.yaml's decide.questions is auto, else keeps them as proposals.
 */
export const QuestionsProposeView = z.object({
  /** none: no hand-off run is open; waiting: handed to the assistant, its Done not yet given. */
  state: z.enum(["none", "waiting"]),
  run: z.string().optional(),
  /** What to paste in a new Copilot Chat (agent mode) or Claude Code session. */
  line: z.string(),
  /** The run's prompt, relative to the metarepo. */
  prompt: z.string().optional(),
  /** The same Done, for a terminal. */
  done: z.string().optional(),
});
/** 2.84.0: GET /api/upgrade: the upgrade steps this metarepo waits on (atticus upgrade --check). */
export const UpgradeView = z.object({
  atticus: z.string(),
  /** A newer Atticus upgraded it: this one must not run the upgrade. */
  newer: z.boolean(),
  /** The Atticus that last upgraded it. */
  stamp: z.string().optional(),
  pending: z.array(z.object({ id: z.string(), summary: z.string(), files: z.array(z.string()) })),
});
// ------------------------------------------------------------------ set up from the app (ADR 0190)

/**
 * 3.5.0: what a setup edit changed, or with `preview: true` would change: the file
 * (metarepo-relative), its lines (what each was, none when added; what it is now, none when
 * removed), whether it was written, and what to do next (Propose).
 */
export const FileEditView = z.object({
  path: z.string(),
  changes: z.array(z.object({ was: z.string().optional(), now: z.string().optional() })),
  written: z.boolean(),
  note: z.string(),
  /** The raw editor's runtime.yaml edit moves where the model's key goes: the write needs `ai-model`. */
  confirm: z.literal("ai-model").optional(),
});
/** GET /api/setup/metarepo: whether this folder is a metarepo, and what Create would use. */
export const SetupMetarepoView = z.object({
  metarepo: z.boolean(),
  root: z.string(),
  folder: z.string(),
  suggested: z.object({ name: z.string(), platform: z.string() }),
  /** The folder's origin, when it is a clone (without credentials). */
  origin: z.string().optional(),
  /** The metarepo's id on the Git host, read from origin. */
  metarepoId: z.string().optional(),
});
export const CreateMetarepoRequest = z.strictObject({
  name: RecordId,
  platform: RecordId,
  owner: z.string().trim().min(1).max(100).optional(),
  /** The metarepo's repo on the Git host, written under runtime.yaml's manual Git host. */
  metarepo: z.string().trim().min(1).max(300).optional(),
});
export const OpenFolderRequest = z.strictObject({ path: z.string().min(1).max(4096) });
export const OpenFolderView = z.object({
  url: z.string(),
  root: z.string(),
  metarepo: z.boolean(),
});
/** Repos to add: pasted clone URLs (one a line), or a folder of clones (repos discover's code). */
export const ReposPlanRequest = z
  .strictObject({
    urls: z.string().max(200_000).optional(),
    dir: z.string().min(1).max(4096).optional(),
    platform: RecordId.optional(),
  })
  .refine((b) => !!b.urls?.trim() !== !!b.dir, "send urls or dir, one of them");
export const PlannedRepoView = z.object({
  id: z.string(),
  url: z.string(),
  /** What the person gave, when the URL was normalised from it. */
  given: z.string().optional(),
  type: z.string(),
  defaultBranch: z.string().optional(),
  /** The id it would have had, and why it got another (`-2`). */
  renamed: z.object({ from: z.string(), why: z.string() }).optional(),
  detected: z.object({ signals: z.array(z.string()), confidence: z.string() }).optional(),
});
export const ReposPlanView = z.object({
  platform: z.string().optional(),
  platforms: z.array(z.string()),
  repos: z.array(PlannedRepoView),
  /** Given, but a manifest lists that clone URL already: left out. */
  listed: z.array(z.object({ url: z.string(), id: z.string() })),
  refused: z.array(z.object({ given: z.string(), why: z.string() })),
  /** Folders repos discover looked at that aren't repos. */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export const AddReposRequest = z.strictObject({
  platform: RecordId.optional(),
  repos: z
    .array(
      z.strictObject({
        id: RecordId,
        url: z.string().min(1).max(2000),
        type: z.string().max(100).optional(),
        owner: z.string().max(100).optional(),
        defaultBranch: z.string().max(250).optional(),
        /** What it is, in the person's words (ADR 0128); optional. */
        description: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(500),
  preview: z.boolean().optional(),
});
export const RepoTypeDetectView = z.object({
  repo: z.string(),
  /** The org pack's repo types (atticus repo-type detect), or the files as repo add reads them. */
  from: z.enum(["repo-types", "files"]),
  verdict: z.string(),
  /** The type to write, when the match settles one. */
  type: z.string().optional(),
  signals: z.array(z.string()).optional(),
  confidence: z.string().optional(),
  matches: z.array(z.object({ type: z.string(), name: z.string(), score: z.number() })),
});
export const RepoTypeRequest = z.strictObject({
  type: z.string().trim().min(1).max(100),
  preview: z.boolean().optional(),
});
const AdapterSettingValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export const AdaptersView = z.object({
  /** runtime.yaml, metarepo-relative. */
  path: z.string(),
  /** 3.9.0: runtime.yaml's sha256 as read, sent back as a write's `baseSha256`. */
  sha256: z.string(),
  kinds: z.array(
    z.object({
      kind: z.string(),
      types: z.array(z.string()),
      /** The settings Atticus reads for this kind; a plugin may read more. */
      fields: z.array(z.object({ name: z.string(), list: z.boolean() })),
      current: z
        .object({ type: z.string(), settings: z.record(z.string(), AdapterSettingValue) })
        .nullable(),
    }),
  ),
  problems: z.array(z.string()),
});
export const AdapterRequest = z.strictObject({
  /** The adapter, or null to take it out of runtime.yaml. */
  value: z
    .strictObject({
      type: z.string().min(1).max(100),
      settings: z.record(z.string().max(100), AdapterSettingValue).optional(),
    })
    .nullable(),
  /**
   * 3.9.0: runtime.yaml's sha256 as the form read it (AdaptersView's), so a write onto a file
   * changed since is refused (409), never overwriting the newer edit.
   */
  baseSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  preview: z.boolean().optional(),
});
export const OrgPackFileView = z.object({
  path: z.string(),
  /** Relative to the org pack folder. */
  rel: z.string(),
  content: z.string(),
  sha256: z.string(),
  exists: z.boolean(),
  /** Checked with its schema before it is written (a YAML file Atticus reads). */
  checked: z.boolean(),
});
export const OrgPackFileRequest = z.strictObject({
  path: z.string().min(1).max(500),
  content: z.string().max(2_000_000),
  /** The file's sha256 as opened (GET's), so an edit made meanwhile is refused. */
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  preview: z.boolean().optional(),
  confirmation: Confirmation.optional(),
});
export const PatternRequest = z.strictObject({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  definition: z.string().min(1).max(2000),
  interaction: z.string(),
  route: z.string(),
  targetType: z.string(),
  controls: z.array(z.string().max(200)).max(50).optional(),
  source: z.string().min(1).max(500),
  version: z.string().max(40).optional(),
  status: z.string().optional(),
  preview: z.boolean().optional(),
});
export const SourceRequest = z.strictObject({
  type: z.string().min(1).max(40),
  location: z.string().min(1).max(2000),
  id: RecordId.optional(),
  /** A git wiki's folder of pages, and its branch or tag. */
  path: z.string().max(500).optional(),
  ref: z.string().max(250).optional(),
  preview: z.boolean().optional(),
});
export type FileEditViewT = z.infer<typeof FileEditView>;
export type SetupMetarepoViewT = z.infer<typeof SetupMetarepoView>;
export type ReposPlanViewT = z.infer<typeof ReposPlanView>;
export type PlannedRepoViewT = z.infer<typeof PlannedRepoView>;
export type RepoTypeDetectViewT = z.infer<typeof RepoTypeDetectView>;
export type AdaptersViewT = z.infer<typeof AdaptersView>;
export type OrgPackFileViewT = z.infer<typeof OrgPackFileView>;
export type OpenFolderViewT = z.infer<typeof OpenFolderView>;

export const ConnectLinksRequest = z.object({
  from: z.string().min(1),
  to: LinkBox,
  pairs: z
    .array(z.object({ call: z.string().min(1), api: z.string().min(1) }))
    .max(500)
    .default([]),
  /** Answer A's open target question with /** to B, so calls read later follow it too. */
  rule: z.boolean().optional(),
  /** Say what it would write and what the next verify --write changes; write nothing. */
  preview: z.boolean().optional(),
});
export const ConnectLinksResult = z.object({
  written: z.boolean(),
  /** The corrections file the pairs go in, and its lines (to be) appended. */
  file: z.string(),
  lines: z.array(z.string()),
  /** The answer the rule writes, when asked. */
  rule: z.object({ question: z.string(), match: z.string(), target: z.string() }).optional(),
  /** What the next `atticus verify <from> --write` adds, moves and removes (ADR 0149). */
  preview: z.unknown().optional(),
  verify: z.string(),
  commit: z.string(),
});
export const UndoCorrectionRequest = z.object({ line: z.string().min(2) });
export const LineChangeView = z.object({ was: z.string().optional(), now: z.string().optional() });
/** G2: a repo's owner and system, and what each can be set to. */
export const RepoOwnerView = z.object({
  repo: z.string(),
  owner: z.string(),
  system: z.string().optional(),
  /** The manifest that lists the repo. */
  file: z.string(),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  systems: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const SetRepoOwnerRequest = z
  .object({
    owner: z.string().min(1).optional(),
    system: z.string().min(1).optional(),
    /** A team no team file names yet: added to roles.yaml for review, and made the owner. */
    addTeam: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
    preview: z.boolean().optional(),
  })
  .refine((b) => b.owner || b.system || b.addTeam, { message: "set owner, system or addTeam" });
export const SetRepoOwnerResult = z.object({
  written: z.boolean(),
  files: z.array(z.object({ file: z.string(), changes: z.array(LineChangeView) })),
  verify: z.string(),
  commit: z.string(),
});
/** G3: a link the code can't show, declared on the canvas. */
export const DeclareLinkRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("topic"),
    system: z.string().min(1),
    topic: z.string().min(1).max(300),
    side: z.enum(["publishes", "listens"]),
    preview: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("call"),
    system: z.string().min(1),
    /** `METHOD /path` as the gateway serves it, or the route's handler `proxy/flow`. */
    route: z.string().min(1).max(300),
    preview: z.boolean().optional(),
  }),
]);
export const FileChangeResult = z.object({
  written: z.boolean(),
  files: z.array(z.object({ file: z.string(), changes: z.array(LineChangeView) })),
  verify: z.string(),
  commit: z.string(),
});
/**
 * ADR 0179: a stroke drawn on the canvas for a change (a call, a topic, a table, a step removed
 * or sent elsewhere, one taken back), checked in full by the planner's Stroke schema.
 */
export const SketchStrokeRequest = z.object({
  stroke: z
    .object({ kind: z.enum(["call", "topic", "table", "remove", "retarget", "undo", "retire"]) })
    .passthrough(),
  /** Say what it would write; write nothing. */
  preview: z.boolean().optional(),
  /** The preview's fingerprint of the target flows: the write is refused (409) when they changed since. */
  expect: z.string().optional(),
});
export const SketchResult = z.object({
  written: z.boolean(),
  files: z.array(z.object({ file: z.string(), changes: z.array(LineChangeView) })),
  /** Why the stroke couldn't be drawn; nothing was written. */
  problem: z.string().optional(),
  /** The component has several flows: which to pick from. */
  pick: z.object({ flows: z.array(z.object({ id: z.string(), name: z.string() })) }).optional(),
  /** The change's picture after the stroke (as GET /api/changes/{id}/map), when it was written. */
  map: ChangeMap.optional(),
  /** The strokes drawn here that Undo can take back: flow, the first step's index in the delta, and who drew it. */
  drawn: z.array(
    z.object({
      flow: z.string(),
      index: z.number().int(),
      what: z.string(),
      by: z.string().optional(),
    }),
  ),
  commit: z.string(),
  /** The target flows as they are now, to send back as `expect` on the write. */
  fingerprint: z.string().optional(),
});
export const UndeclareLinkRequest = z.object({
  kind: z.enum(["topic", "call"]),
  system: z.string().min(1),
  value: z.string().min(1),
});
/** G3: what can be added to the picture: repos (read or not), systems and teams. */
/** ADR 0180: a component type as the app shows it (the org pack's shape, plus its source and notes). */
export const ComponentTypeView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.string().optional(),
  source: z.enum(["builtin", "org-pack"]),
  signals: z.array(z.object({ kind: z.string(), value: z.string(), why: z.string().optional() })),
  runsOn: z
    .object({
      platform: z.string().optional(),
      cloud: z.string().optional(),
      framework: z.string().optional(),
    })
    .optional(),
  draws: z
    .object({
      shape: z.string().optional(),
      colour: z.string().optional(),
      badge: z.string().optional(),
    })
    .optional(),
  must: z.array(z.string()),
  mustNot: z.array(z.string()),
  /** The architect's write-up (Markdown), when the type has one. */
  notes: z.string().optional(),
  /** Where its file is, relative to the metarepo (none for a built-in the pack doesn't reword). */
  file: z.string().optional(),
});
export const ComponentTypesView = z.object({
  types: z.array(ComponentTypeView),
  /** Where a new type goes: the org pack's component-types folder, relative to the metarepo. */
  folder: z.string(),
});
export const AddableView = z.object({
  repos: z.array(z.object({ id: z.string(), name: z.string(), read: z.boolean() })),
  systems: z.array(z.object({ id: z.string(), name: z.string(), boundary: z.string().optional() })),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const AddSystemRequest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(120),
  boundary: z.enum(["vendor", "internal"]),
  owner: z.string().min(1).optional(),
  preview: z.boolean().optional(),
});
/** G3: a box's corrections and declarations, each with what undoes it. */
export const BoxCorrections = z.object({
  items: z.array(
    z.object({
      /** 2.81.0 (ADR 0181): `unlink`, a person said the call reaches none of these. */
      kind: z.enum(["edit", "wrong", "link", "topic", "call", "unlink"]),
      /** In words: what it says. */
      says: z.string(),
      by: z.string().optional(),
      /** 2.81.0 (ADR 0181): a pairing the AI decided ("Detected by AI"), with its run; never a person's. */
      ai: z.object({ runtime: z.string(), run: z.string() }).optional(),
      /** 2.81.0 (ADR 0181): the batch that wrote the line (POST /api/decisions/batches/{batchId}/undo). */
      batch: z.string().optional(),
      at: z.string().optional(),
      file: z.string(),
      /** What undoes exactly it: the line to remove, or the declaration. */
      undo: z.union([
        z.object({ repo: z.string(), line: z.string() }),
        z.object({ kind: z.enum(["topic", "call"]), system: z.string(), value: z.string() }),
      ]),
      /** A correction the latest read didn't meet: kept, said. */
      stale: z.boolean().optional(),
    }),
  ),
});
/** G6 (ADR 0175): a canvas's named filters and layers, kept in the metarepo for review. */
export const SavedCanvasView = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  lens: z.string().min(1),
  node: z.string().min(1),
  filter: z.string().max(500).default(""),
  layers: z.record(z.string(), z.boolean()).default({}),
  overlay: z.enum(["none", "gaps", "questions"]).default("none"),
  mismatches: z.boolean().default(false),
  by: z.string().optional(),
  at: z.string().optional(),
});
export const SavedCanvasViews = z.object({ views: z.array(SavedCanvasView), dir: z.string() });
/** G6: a cited line, as a file to open in an editor. */
export const CodeLink = z.object({
  /** The file on this machine, when the repo's checkout is here. */
  path: z.string().optional(),
  line: z.number().int().positive(),
  vscode: z.string().optional(),
  idea: z.string().optional(),
  /** Why there is no file: no checkout of the repo. */
  missing: z.string().optional(),
});
export type SavedCanvasViewT = z.infer<typeof SavedCanvasView>;
export type SavedCanvasViewsT = z.infer<typeof SavedCanvasViews>;
export type CodeLinkT = z.infer<typeof CodeLink>;
/** G4 from the canvas (ADR 0176): a draft reading rule for a repo's type, from a pairing. */
export const RuleFromPairingRequest = z.object({
  repo: z.string().min(1),
  line: z.string().min(2),
});
export const RuleFromPairingResult = z.object({
  file: z.string(),
  key: z.string(),
  rule: z.string(),
  activate: z.string(),
});
export type RuleFromPairingResultT = z.infer<typeof RuleFromPairingResult>;
export type DeclareLinkRequestT = z.infer<typeof DeclareLinkRequest>;
export type FileChangeResultT = z.infer<typeof FileChangeResult>;
export type SketchStrokeRequestT = z.infer<typeof SketchStrokeRequest>;
export type SketchResultT = z.infer<typeof SketchResult>;
export type AddableViewT = z.infer<typeof AddableView>;
export type ComponentTypeViewT = z.infer<typeof ComponentTypeView>;
export type ComponentTypesViewT = z.infer<typeof ComponentTypesView>;
export type AddSystemRequestT = z.infer<typeof AddSystemRequest>;
export type BoxCorrectionsT = z.infer<typeof BoxCorrections>;
export type RepoOwnerViewT = z.infer<typeof RepoOwnerView>;
export type SetRepoOwnerRequestT = z.infer<typeof SetRepoOwnerRequest>;
export type SetRepoOwnerResultT = z.infer<typeof SetRepoOwnerResult>;
export type LinkBoxT = z.infer<typeof LinkBox>;
export type CandidateCallViewT = z.infer<typeof CandidateCallView>;
export type CandidateApiViewT = z.infer<typeof CandidateApiView>;
export type LinkCandidatesViewT = z.infer<typeof LinkCandidatesView>;
export type ConnectLinksRequestT = z.infer<typeof ConnectLinksRequest>;
export type ConnectLinksResultT = z.infer<typeof ConnectLinksResult>;
export type MatchLinksRequestT = z.infer<typeof MatchLinksRequest>;
export type MatchLinksViewT = z.infer<typeof MatchLinksView>;
export type MatchProposalT = z.infer<typeof MatchProposal>;
export type DecisionCountsT = z.infer<typeof DecisionCounts>;
export type AiDecisionItemT = z.infer<typeof AiDecisionItem>;
export type DecisionBatchViewT = z.infer<typeof DecisionBatchView>;
export type DecideStateViewT = z.infer<typeof DecideStateView>;
export type DecisionsViewT = z.infer<typeof DecisionsView>;
export type CorrectDecisionRequestT = z.infer<typeof CorrectDecisionRequest>;
export type SpreadItemViewT = z.infer<typeof SpreadItemView>;
export type CorrectDecisionResultT = z.infer<typeof CorrectDecisionResult>;
export type UndoBatchResultT = z.infer<typeof UndoBatchResult>;
export type QuestionsProposeViewT = z.infer<typeof QuestionsProposeView>;
export type UpgradeViewT = z.infer<typeof UpgradeView>;

// ------------------------------------------------------------------ copilot runs (ADR 0173)

/** What an unattended Copilot run started from the app reads. */
export const CopilotRunKind = z.enum(["stale", "gaps", "all", "repos"]);
export const StartCopilotRunRequest = z.object({
  /** stale: the repos whose clone moved past their facts; gaps: the second pass; all: every repo not read yet; repos: the repos named, read whole. */
  kind: CopilotRunKind,
  repos: z.array(z.string().min(1)).max(500).optional(),
  /** Read the repos whole again (`--force`). */
  force: z.boolean().optional(),
});
export const CopilotRunState = z.enum(["running", "done", "stopped", "failed"]);
export const CopilotRunTab = z.object({
  /** "run" for the run's own tab; s1, s2, ... for each session. */
  id: z.string(),
  title: z.string(),
  repo: z.string().optional(),
  state: z.enum(["running", "ended", "failed"]),
  /** Why the session ended, as Copilot or Atticus said. */
  ended: z.string().optional(),
  /** The number of the first line kept (older lines are dropped past the cap). */
  from: z.number().int().min(0),
  lines: z.array(z.string()),
});
export const CopilotRunView = z.object({
  runId: z.string(),
  jobId: z.string(),
  kind: CopilotRunKind,
  repos: z.array(z.string()).optional(),
  force: z.boolean().optional(),
  state: CopilotRunState,
  by: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  model: z.string().optional(),
  /** The repos the plan reads, and how far along it is. */
  progress: z.object({
    repos: z.number().int().min(0),
    repoIndex: z.number().int().min(0),
    repo: z.string().optional(),
    session: z.string().optional(),
    sessions: z.number().int().min(0),
  }),
  totals: z.object({
    kept: z.number().int().min(0),
    rejected: z.number().int().min(0),
    tokens: z.number().int().min(0),
  }),
  /** The last thing said: the error a failed run ended on, or how it ended. */
  message: z.string().optional(),
  tabs: z.array(CopilotRunTab),
});
export const CopilotRunCurrent = z.object({
  /** The run under way, else the last one this server ran; null when none yet. */
  run: CopilotRunView.nullable(),
  /** Whether runtime.yaml allows copilot-acp here, and if not, why. */
  allowed: z.boolean(),
  why: z.string().optional(),
  model: z.string().optional(),
});
export type CopilotRunKindT = z.infer<typeof CopilotRunKind>;
export type StartCopilotRunRequestT = z.infer<typeof StartCopilotRunRequest>;
export type CopilotRunStateT = z.infer<typeof CopilotRunState>;
export type CopilotRunTabT = z.infer<typeof CopilotRunTab>;
export type CopilotRunViewT = z.infer<typeof CopilotRunView>;
export type CopilotRunCurrentT = z.infer<typeof CopilotRunCurrent>;

/** ADR 0187: one thing Atticus is doing or did on this metarepo, for the Console. */
export const ActivityKind = z.enum([
  // The app's own jobs (ADR 0015), by their kind.
  "scan",
  "sync",
  "reconcile",
  "index",
  "intake",
  "step",
  "local",
  /** A request the page waits on, run as a job (the critic, a wiki's sync, a step run, Done). */
  "work",
  /** An unattended Copilot run the app started (ADR 0173): its lines are its tabs. */
  "copilot",
  /** A command run in a terminal, by an editor or by a Copilot session. */
  "command",
  /** A hand-off run waiting for the person's assistant, and its Done. */
  "handoff",
]);
export const ActivityState = z.enum([
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  /** Its process is gone and it never said how it ended (a terminal closed, a crash). */
  "ended",
]);
/** Where it was started. */
export const ActivityWhere = z.enum([
  "app",
  "terminal",
  "vscode",
  "intellij",
  "copilot",
  /** A hand-off run: the person's own assistant does the work. */
  "assistant",
]);
export const ActivityEntry = z.object({
  /** A job's id (job-N), a Copilot run's (copilot-run-...), term-<runId> for a command, a hand-off run's (run-...). */
  id: z.string().min(1),
  kind: ActivityKind,
  /** What it is, in its own words: the command (`atticus map forge-ledger`), or the app's job. Left out for a job that gave none: the page names it by its kind. */
  title: z.string().optional(),
  where: ActivityWhere,
  state: ActivityState,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** How far it is, when it says (a job's progress). */
  progress: z
    .object({ done: z.number().int(), total: z.number().int(), message: z.string() })
    .optional(),
  exitCode: z.number().int().optional(),
  /** How many lines it has printed: the page asks for the ones it hasn't. */
  lines: z.number().int().min(0),
  /** The first line still kept (older ones are dropped past the cap). */
  from: z.number().int().min(0),
  /**
   * 3.9.0 (review of beta.23): which version of its lines these are, for an entry whose lines
   * are rewritten rather than only added to (a hand-off run's say what to do, then what Done
   * did). When it changes, the page reads its lines again from the start instead of adding.
   */
  rev: z.string().optional(),
  /** The route that stops it (POST), when the app can; a command stops in its terminal. */
  stop: z.string().optional(),
  jobId: z.string().optional(),
  copilotRunId: z.string().optional(),
  /** A command's run id (its files in .atticus/logs/). */
  runId: z.string().optional(),
  /** A hand-off run: its change, where its prompt is and where the answer goes. */
  handoff: z
    .object({
      runId: z.string(),
      change: z.string(),
      agent: z.string().optional(),
      promptPath: z.string(),
      output: z.string().optional(),
    })
    .optional(),
});
export const ActivityList = z.object({
  /** Newest first. */
  entries: z.array(ActivityEntry),
  /** How many are running now. */
  running: z.number().int().min(0),
});
export const ActivityLines = z.object({
  id: z.string(),
  /** The number of the first of these lines. */
  from: z.number().int().min(0),
  lines: z.array(z.string()),
  /** How many lines it has printed in all. */
  total: z.number().int().min(0),
  state: ActivityState,
});
export type ActivityKindT = z.infer<typeof ActivityKind>;
export type ActivityStateT = z.infer<typeof ActivityState>;
export type ActivityWhereT = z.infer<typeof ActivityWhere>;
export type ActivityEntryT = z.infer<typeof ActivityEntry>;
export type ActivityListT = z.infer<typeof ActivityList>;
export type ActivityLinesT = z.infer<typeof ActivityLines>;

// ------------------------------------------------------------------ live events

/** Messages on the WebSocket at /api/events. */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file.changed"),
    path: z.string(),
    /** 3.9.0: whether it can change the catalog, by the folders the org pack's layout names. */
    catalog: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("job.progress"),
    jobId: z.string(),
    done: z.number().int(),
    total: z.number().int(),
    message: z.string(),
  }),
  z.object({ type: z.literal("job.done"), jobId: z.string(), state: JobState }),
  z.object({ type: z.literal("index.rebuilt"), records: z.number().int() }),
  z.object({ type: z.literal("run.changed"), runId: z.string(), state: RunState }),
  // ADR 0173: an unattended Copilot run's state, and new lines for one of its tabs.
  z.object({ type: z.literal("copilot-run.state"), run: CopilotRunView.omit({ tabs: true }) }),
  z.object({
    type: z.literal("copilot-run.lines"),
    runId: z.string(),
    tab: z.string(),
    title: z.string(),
    /** The number of the first of these lines in the tab. */
    at: z.number().int().min(0),
    lines: z.array(z.string()),
  }),
  // ADR 0187: an activity appeared or changed, and new lines one printed.
  z.object({ type: z.literal("activity.changed"), entry: ActivityEntry }),
  z.object({
    type: z.literal("activity.lines"),
    id: z.string(),
    /** The number of the first of these lines. */
    at: z.number().int().min(0),
    lines: z.array(z.string()),
  }),
]);

// ------------------------------------------------------------------ roles and the BA (ADR 0191)

/** 3.6.0 (ADR 0191): a person moves a question to another role. */
export const RouteQuestionRequest = z.strictObject({ role: QuestionRole });

/**
 * 3.6.0 (ADR 0191): the owners roles.yaml suggests for a change's roles: the team that owns its
 * repos (a team's `roles`), else the organisation's default for the role. Suggestions only: a
 * person accepts one with a click (PUT .../owners), nothing is written by itself. A role the
 * change already names is left out.
 */
export const OwnerSuggestion = z.object({
  role: z.string(),
  people: z.array(z.string()),
  from: z.union([
    z.object({ team: z.string(), name: z.string().optional(), repos: z.array(z.string()) }),
    z.object({ default: z.literal(true) }),
  ]),
});
export const OwnerSuggestionList = z.object({
  change: z.string(),
  suggestions: z.array(OwnerSuggestion),
  /** Why there are none, in words, when there are none. */
  note: z.string().optional(),
});
export type OwnerSuggestionListT = z.infer<typeof OwnerSuggestionList>;

/** 3.6.0 (ADR 0191): who a change waits on now, by role, with their names. */
export const WaitsOn = z.object({
  /** The change.yaml owner key: product-owner, architect, business-analyst or team-lead. */
  role: z.string(),
  people: z.array(z.string()),
  /** `handoff`: its hand-off PR waits on their review; `phase`: the phase's work is theirs. */
  because: z.enum(["handoff", "phase"]),
  phase: z.string(),
});
export type WaitsOnT = z.infer<typeof WaitsOn>;

/** 3.6.0 (ADR 0191): a critic finding with the level of what it asks (business, design, delivery). */
export const FindingView = z.strictObject({ ...Finding.shape, asks: QuestionAsks });

/**
 * 3.6.0 (ADR 0191): the work items a change's plan puts in the work tracker, one per feature,
 * story and task, as sync.yaml remembers them. With a manual tracker each is a step for a person
 * (the fields to copy, and where to record the tracker's id); with a live one, a write the
 * person confirms (`work-items`).
 */
export const WorkItemPlan = z.object({
  change: z.string(),
  /** none: runtime.yaml names no work tracker; manual: steps for a person; live: the tracker. */
  tracker: z.enum(["none", "manual", "live"]),
  items: z.array(
    z.object({
      key: z.string(),
      type: z.string(),
      title: z.string(),
      action: z.enum(["create", "update", "unchanged", "orphaned"]),
      /** The tracker's id once known; `manual:<step>` until a person records it. */
      id: z.string().optional(),
      /** The step to record it on, for a manual id. */
      step: z.string().optional(),
      /** The story it is under, for a task; the story's own key for a story. */
      story: z.string().optional(),
    }),
  ),
  /** The command that does the same in a terminal. */
  command: z.string(),
});
export type WorkItemPlanT = z.infer<typeof WorkItemPlan>;
export const WorkItemSyncRequest = z.strictObject({
  confirmation: Confirmation.optional(),
  /** 3.9.0: run the sync as a job (202 and its id; the job's result `answer` is the result). */
  job: z.boolean().optional(),
});
export const WorkItemSyncResult = z.object({
  plan: WorkItemPlan,
  lines: z.array(z.string()),
  done: z.array(z.object({ key: z.string(), action: z.string(), id: z.string() })),
  failed: z.array(z.object({ key: z.string(), reason: z.string() })),
});
export type WorkItemSyncResultT = z.infer<typeof WorkItemSyncResult>;

/**
 * 3.6.0 (ADR 0191): send an owner question through the configured notifications adapter, on the
 * person's confirmation (`owner-ask`, target the question's id). With manual notifications it is
 * a step for a person, as before.
 */
export const SendOwnerAskRequest = z.strictObject({ confirmation: Confirmation.optional() });
export const SentOwnerAsk = z.object({
  /** sent: through the adapter; step: a manual step for a person; not-sent: why in `why`. */
  state: z.enum(["sent", "step", "not-sent"]),
  to: z.string(),
  id: z.string().optional(),
  why: z.string().optional(),
});
export type SentOwnerAskT = z.infer<typeof SentOwnerAsk>;

/** 3.6.0 (ADR 0191): a passage of the org's wikis or inputs/ files, with where it is. */
export const KnowledgePassageView = z.object({
  source: z.string(),
  page: z.string(),
  /** The page's root-relative path (the snapshot copy, or the inputs/ file). */
  path: z.string(),
  heading: z.string(),
  line: z.number().int(),
  text: z.string(),
});
export type KnowledgePassageViewT = z.infer<typeof KnowledgePassageView>;

/**
 * 3.6.0 (ADR 0191): what the organisation's knowledge says to a question, found by its words (no
 * AI): the knowledge items it matches, each with the quote it rests on, and the passages of the
 * wikis' snapshots and inputs/ files. Nothing is made up: each shows where it is from.
 */
export const KnowledgeAnswerView = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      quote: z
        .object({
          source: z.string(),
          page: z.string(),
          section: z.string().optional(),
          text: z.string(),
        })
        .optional(),
    }),
  ),
  passages: z.array(KnowledgePassageView),
  /** The AI step that answers from the items in words, citing them (atticus knowledge ask). */
  command: z.string(),
});
export type KnowledgeAnswerViewT = z.infer<typeof KnowledgeAnswerView>;

/**
 * 3.6.0 (ADR 0191): the business analyst's shaping of a change's stories, in plain words. A
 * rename keeps the story's number; a split's first part keeps it and each other part gets the next
 * free one; a merge keeps the first story's; an added story gets the next free one. The AI maps
 * the tasks to the stories at the next draft, and the critic checks none is left without a story.
 */
export const StoryShapeOp = z.enum(["rename", "split", "merge", "add"]);
export const StoryShapeRequest = z.strictObject({
  op: StoryShapeOp,
  /** rename, split: the story; merge: the stories, the first keeps its number. */
  story: z.string().optional(),
  stories: z.array(z.string()).min(2).optional(),
  /** rename, merge, add: its name; split: the first part's. */
  name: z.string().trim().min(1).max(200),
  /** What the story is for, in the person's words (add, a split's parts). */
  words: z.string().trim().max(2000).optional(),
  /** split: the other parts, each a story of its own. */
  parts: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        words: z.string().trim().max(2000).optional(),
      }),
    )
    .optional(),
});
export const StoryShapeEntryView = z.object({
  id: z.string(),
  op: StoryShapeOp,
  story: z.string().optional(),
  stories: z.array(z.string()).optional(),
  name: z.string(),
  words: z.string().optional(),
  parts: z
    .array(z.object({ id: z.string(), name: z.string(), words: z.string().optional() }))
    .optional(),
  /** The story an added one is. */
  added: z.string().optional(),
  by: z.string(),
  at: z.string(),
  /** waiting: no draft has read it yet; applied: the stories now have it, with the run. */
  state: z.enum(["waiting", "applied"]),
  run: z.string().optional(),
});
export const StoryShapeView = z.object({
  change: z.string(),
  file: z.string(),
  entries: z.array(StoryShapeEntryView),
  /** Each task's story as the last draft mapped it, by task id. */
  assigned: z.record(z.string(), z.string()),
  /** What the coverage check found: a story with no task, a task with no story. */
  uncovered: z.array(z.string()),
  /** The step that maps the tasks to the stories again. */
  command: z.string(),
});
export type StoryShapeViewT = z.infer<typeof StoryShapeView>;

// ------------------------------------------------------------------ the document

type Op = {
  id: string;
  summary: string;
  tag: string;
  params?: {
    name: string;
    in: "path" | "query";
    schema: object;
    required?: boolean;
    description?: string;
  }[];
  body?: z.ZodType;
  /** The body may be left out (an empty body reads as `{}`). */
  bodyOptional?: boolean;
  ok: { status: 200 | 201 | 202 | 204; schema?: string | object; description: string };
  /** Another answer it can give on success (3.9.0: 202 JobAccepted when asked `job: true`). */
  alsoOk?: { status: 200 | 201 | 202 | 204; schema?: string | object; description: string };
  errors?: number[];
};

const str = { type: "string" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name: string) => ({ type: "array", items: ref(name) });
const p = (name: string, extra: Partial<NonNullable<Op["params"]>[number]> = {}) => ({
  name,
  in: "path" as const,
  schema: str,
  required: true,
  ...extra,
});
const q = (name: string, schema: object = str, description?: string) => ({
  name,
  in: "query" as const,
  schema,
  ...(description ? { description } : {}),
});

/** What a read-only view returns: the command's exit code, its JSON and anything it printed to stderr. */
const VIEW_RESULT = {
  type: "object",
  required: ["code", "data", "problems"],
  properties: { code: { type: "integer" }, data: {}, problems: { type: "array", items: str } },
};

const OPS: Record<string, Record<string, Op>> = {
  "/api/health": {
    get: {
      id: "getHealth",
      summary: "Versions, the metarepo root and who is signed in",
      tag: "system",
      ok: { status: 200, schema: "Health", description: "OK" },
    },
  },
  "/api/confirmations": {
    post: {
      id: "confirmWrite",
      summary:
        "3.0.0 (ADR 0186): the app's page asks, on the person's click, for a confirmation of one write to a shared system (a hand-off, the release PRs, a merge, a task's PR, sending the digest, Propose for review, a step run with a team's tool, where the model's key goes, a Test of uncommitted model settings). It needs the page key the server puts in the page and never prints, so the session token alone gets 403; the confirmation is for that write and target, used once, and expires after two minutes",
      tag: "system",
      body: ConfirmationRequest,
      ok: { status: 201, schema: "ConfirmationView", description: "The confirmation" },
      errors: [400, 403],
    },
  },
  "/api/me": {
    get: {
      id: "getMe",
      summary:
        "Who is using the app: the metarepo's Git user (handle, name, email, and a warning when the OS user stood in), what AI may do and the digest settings (ADR 0073); 3.1.0: notify.to, where Send it to me posts",
      tag: "system",
      ok: {
        status: 200,
        schema: { type: "object", required: ["user", "source", "ai"] },
        description: "OK",
      },
    },
  },
  "/api/me/notify": {
    put: {
      id: "saveNotify",
      summary: "How often the person wants their digest and where it goes (.atticus/me.yaml)",
      tag: "system",
      body: SaveNotifyRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Saved" },
      errors: [400],
    },
  },
  "/api/me/watch": {
    put: {
      id: "watchChange",
      summary:
        "Follow a change, or stop following it: the digest and the editors say how each watched change is doing (.atticus/me.yaml, never committed)",
      tag: "system",
      body: WatchRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Saved" },
      errors: [400],
    },
  },
  "/api/me/digest": {
    post: {
      id: "sendDigest",
      summary:
        "What waits on the person; with send, posted through the notify adapter as their approval. 3.0.0 (ADR 0186): send needs the person's confirmation, else 403. 3.1.0 (review round 50): its target is the channel it posts to (GET /api/me's notify.to, read again at the send), not `me`",
      tag: "system",
      body: SendDigestRequest,
      ok: {
        status: 200,
        schema: { type: "object", required: ["title", "body", "lines"] },
        description: "The digest, with sent or notSent",
      },
      errors: [400, 403],
    },
  },
  "/api/across": {
    get: {
      id: "listAcross",
      summary:
        "One view across every open change: findings, tasks, stories, tests, requests or releases",
      tag: "views",
      params: [
        q("view", {
          type: "string",
          enum: ["findings", "tasks", "stories", "tests", "requests", "releases"],
        }),
      ],
      ok: {
        status: 200,
        schema: { type: "object", required: ["view", "changes", "rows"] },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/changes/{changeId}/mappings": {
    get: {
      id: "getMappingGrid",
      summary:
        "The change's field mappings per hop, next to the catalog's FieldMapping records for the same interface",
      tag: "views",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object", required: ["hops"] }, description: "OK" },
      errors: [404],
    },
  },
  "/api/catalog/kinds": {
    get: {
      id: "listKinds",
      summary: "Record counts per kind, with stale counts",
      tag: "catalog",
      ok: { status: 200, schema: arrayOf("KindCount"), description: "OK" },
    },
  },
  "/api/catalog/{kind}": {
    get: {
      id: "listRecords",
      summary: "Records of one kind, filtered and paged",
      tag: "catalog",
      params: [
        p("kind", { schema: { type: "string", enum: RECORD_KINDS } }),
        q("status"),
        q("system"),
        q("q", str, "Text search over id and name"),
        q("confidence", str, "2.63.0: only records of this confidence (verified, inferred, ...)"),
        q("limit", { type: "integer", minimum: 1, maximum: 500 }),
        q("cursor"),
      ],
      ok: { status: 200, schema: "RecordPage", description: "OK" },
      errors: [400],
    },
  },
  "/api/catalog/{kind}/{id}": {
    get: {
      id: "getRecord",
      summary: "One record with its evidence",
      tag: "catalog",
      params: [p("kind", { schema: { type: "string", enum: RECORD_KINDS } }), p("id")],
      ok: { status: 200, schema: "CatalogRecord", description: "OK" },
      errors: [404],
    },
  },
  "/api/search": {
    get: {
      id: "search",
      summary: "Find records with the query language (docs/query-language.md)",
      tag: "catalog",
      params: [
        q("q", str, "The query, e.g. kind:interface via:gateway"),
        q("limit", { type: "integer" }),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          properties: {
            rows: { type: "array", items: { type: "object" } },
            total: { type: "integer" },
          },
        },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/view/{name}": {
    get: {
      id: "getView",
      summary: "A read-only view: the JSON the matching atticus … --json command prints (ADR 0043)",
      tag: "views",
      params: [
        p("name", {
          schema: {
            type: "string",
            enum: [
              "coverage",
              "questions",
              "intake",
              "triage",
              "features",
              "glossary",
              "critic-stats",
              "conflicts",
              "sources",
              "reconcile",
            ],
          },
        }),
      ],
      ok: { status: 200, schema: VIEW_RESULT, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/view/{name}/{id}": {
    get: {
      id: "getViewOf",
      summary: "A read-only view of one change, feature or initiative (ADR 0043)",
      tag: "views",
      params: [
        p("name", {
          schema: {
            type: "string",
            enum: ["features", "findings", "drift", "trace", "story-bar", "initiatives"],
          },
        }),
        p("id"),
      ],
      ok: { status: 200, schema: VIEW_RESULT, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/setup": {
    get: {
      id: "getSetup",
      summary:
        "The setup checklist until the catalog is accepted, with a plain fix for each step; the machine step says `checking` while the machine's checks run",
      tag: "system",
      params: [
        q(
          "machine",
          { type: "string", enum: ["wait"] },
          "Wait for the machine's checks instead of answering with the machine step checking",
        ),
      ],
      ok: {
        status: 200,
        schema: { type: "object", required: ["steps", "baselined"] },
        description: "OK",
      },
    },
  },
  "/api/doctor": {
    get: {
      id: "getDoctor",
      summary:
        "What this machine needs for Atticus (Node, Git, OpenSpec, proxy, TLS, disk, assistant), each with a fix; never a secret",
      tag: "system",
      params: [
        q(
          "fresh",
          { type: "string", enum: ["1"] },
          "Check again instead of the last five minutes' result",
        ),
      ],
      ok: {
        status: 200,
        schema: { type: "object", required: ["checks", "ok"] },
        description: "OK",
      },
    },
  },
  "/api/baseline": {
    post: {
      id: "acceptBaseline",
      summary:
        "Accept the as-is catalog as the baseline (catalog/baseline.yaml), as the signed-in person",
      tag: "system",
      body: BaselineRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Accepted" },
      errors: [400, 403, 422],
    },
  },
  "/api/guide/{system}": {
    get: {
      id: "getGuide",
      summary: "A system's guide, generated from the catalog, with what it doesn't know yet",
      tag: "views",
      params: [p("system")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["system", "markdown", "gaps"] },
        description: "OK",
      },
      errors: [400, 404],
    },
  },
  "/api/triage/{itemId}/decide": {
    post: {
      id: "decideTriage",
      summary: "Choose a triage item's option as the signed-in person; writes a curated decision",
      tag: "views",
      params: [p("itemId")],
      body: TriageDecideRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Decided" },
      errors: [400, 404, 422],
    },
  },
  "/api/initiatives": {
    get: {
      id: "listInitiatives",
      summary: "Every initiative with its status, critical path and commitments",
      tag: "views",
      ok: { status: 200, schema: { type: "array", items: { type: "object" } }, description: "OK" },
    },
    post: {
      id: "createInitiative",
      summary:
        "UX review: start an initiative from a guided journey, as atticus initiative new does; the signed-in person started it",
      tag: "views",
      body: NewInitiativeRequest,
      ok: { status: 201, schema: "InitiativeSavedView", description: "Started" },
      errors: [400, 409, 422],
    },
  },
  "/api/initiatives/{initiativeId}/plan": {
    post: {
      id: "planInitiative",
      summary:
        "UX review: plan an initiative's changes and commitments back from its release, as atticus initiative plan does",
      tag: "views",
      params: [p("initiativeId")],
      body: InitiativePlanRequest,
      ok: { status: 200, schema: "InitiativeSavedView", description: "Planned" },
      errors: [400, 404, 422],
    },
  },
  "/api/commitments/{commitmentId}/status": {
    post: {
      id: "recordCommitment",
      summary:
        "UX review: record a commitment's state (open, at-risk, done, slipped) with a note, as the signed-in person",
      tag: "views",
      params: [p("commitmentId")],
      body: CommitmentStatusRequest,
      ok: { status: 200, schema: "InitiativeSavedView", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/diagram/{view}": {
    get: {
      id: "getDiagram",
      summary: "A catalog view drawn as Mermaid text",
      tag: "views",
      params: [
        p("view", {
          schema: { type: "string", enum: ["context", "container", "data", "event", "sequence"] },
        }),
        q("focus", str, "The system, for container and sequence views"),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["text"],
          properties: {
            code: { type: "integer" },
            text: str,
            problems: { type: "array", items: str },
          },
        },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/diagram/{view}/graph": {
    get: {
      id: "getDiagramGraph",
      summary: "A catalog view's groups, nodes and edges, for the app's canvas",
      tag: "views",
      params: [
        p("view", {
          schema: { type: "string", enum: ["context", "container", "data", "event"] },
        }),
        q("focus", str, "The system, for the container view"),
      ],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["view"],
          properties: { view: { type: "object" } },
        },
        description: "OK",
      },
      errors: [400, 422],
    },
  },
  "/api/graph/node/{id}": {
    get: {
      id: "getGraphNode",
      summary:
        "A node of the estate hierarchy with its children (one level, lazy) and its edges to siblings and outside; the root is estate (ADR 0081)",
      tag: "views",
      params: [
        p("id", { description: "estate, or <kind>:<record id>, e.g. system:ledger" }),
        q(
          "lens",
          { type: "string", enum: [...GRAPH_LENSES] },
          "Which part of the model to show (default architecture)",
        ),
        q("depth", { type: "integer", minimum: 1, maximum: 3 }, "Levels of children (default 1)"),
        q(
          "all",
          { type: "string", enum: ["1"] },
          "Every 'uses' edge, not the transitive reduction",
        ),
      ],
      ok: { status: 200, schema: "GraphNodeView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/graph/focus/{id}": {
    get: {
      id: "getGraphFocus",
      summary: "A node and its direct neighbours, with the edges between them (ADR 0081)",
      tag: "views",
      params: [p("id"), q("lens", { type: "string", enum: [...GRAPH_LENSES] }, "Default data")],
      ok: { status: 200, schema: "GraphFocusView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/graph/edge-calls": {
    get: {
      id: "getGraphEdgeCalls",
      summary:
        "Every call merged into one edge of a view (a node's, or a focus), not only the first 20 the view lists (review of beta.24)",
      tag: "views",
      params: [
        q("edge", str, "The edge's id, as the view gives it (required)"),
        q("node", str, "The node whose view has the edge (or focus)"),
        q("focus", str, "The node whose focus view has the edge (or node)"),
        q("lens", { type: "string", enum: [...GRAPH_LENSES] }, "The view's lens"),
      ],
      ok: { status: 200, schema: "GraphEdgeCallsView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/graph/layout/{viewKey}": {
    get: {
      id: "getViewLayout",
      summary:
        "A view's kept arrangement (diagrams/layouts/<view-key>.yaml); saved is false when there is none",
      tag: "views",
      params: [p("viewKey", { description: "<lens>.<node>, e.g. architecture.system-ledger" })],
      ok: { status: 200, schema: "ViewLayoutResult", description: "OK" },
      errors: [400, 422],
    },
    put: {
      id: "putViewLayout",
      summary:
        "Keep this arrangement: writes diagrams/layouts/<view-key>.yaml in the metarepo, as the signed-in person",
      tag: "views",
      params: [p("viewKey")],
      body: PutLayoutRequest,
      ok: { status: 200, schema: "ViewLayoutResult", description: "Kept" },
      errors: [400],
    },
  },
  "/api/ask": {
    get: {
      id: "ask",
      summary:
        "Answer a plain-language question from the catalog; the query used is always returned. 3.6.0 (ADR 0191): `knowledge` (KnowledgeAnswerView) says what the organisation's knowledge items, wiki snapshots and inputs/ files say to it, each cited",
      tag: "catalog",
      params: [q("q", str, "The question, e.g. who calls ledger-api?")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["question", "action", "query", "explanation"] },
        description: "OK",
      },
      errors: [400],
    },
  },
  "/api/graph": {
    get: {
      id: "getGraph",
      summary: "Systems, components and interfaces as a graph",
      tag: "catalog",
      params: [
        q("focus", str, "Record id to centre on"),
        q("depth", { type: "integer", minimum: 1, maximum: 6 }),
        q("status"),
      ],
      ok: { status: 200, schema: "Graph", description: "OK" },
    },
  },
  "/api/impact/{id}": {
    get: {
      id: "getImpact",
      summary: "Blast radius of changing a record (API, table, column, topic...)",
      tag: "catalog",
      params: [p("id"), q("depth", { type: "integer", minimum: 1, maximum: 10 })],
      ok: { status: 200, schema: "Impact", description: "OK" },
      errors: [404],
    },
  },
  "/api/coverage": {
    get: {
      id: "getCoverage",
      summary: "What the catalog knows per area and system, and the gaps",
      tag: "catalog",
      ok: { status: 200, schema: "Coverage", description: "OK" },
    },
  },
  "/api/incident/{id}": {
    get: {
      id: "getIncident",
      summary:
        "Incident mode: a failing record's blast radius, the owners to call, what watches it and recent nearby changes (read-only, from the last scan)",
      tag: "catalog",
      params: [p("id")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["id", "affected", "call", "recentChanges"] },
        description: "OK",
      },
      errors: [404],
    },
  },
  "/api/repos": {
    get: {
      id: "listRepos",
      summary: "Repos from every manifest with their base-clone state",
      tag: "workspace",
      ok: { status: 200, schema: arrayOf("RepoView"), description: "OK" },
    },
  },
  "/api/repos/branches": {
    get: {
      id: "listRepoBranches",
      summary:
        "Each repo's default branch (the manifest's and the remote's), its named branches, the commit the baseline was read from, and its branches scanned beside it (ADR 0123)",
      tag: "workspace",
      ok: { status: 200, schema: "RepoBranchesList", description: "OK" },
    },
  },
  "/api/repos/compare": {
    get: {
      id: "compareBranch",
      summary:
        "What a branch scanned beside the baseline changes against it, for the repos it read: records added, removed and changed (ADR 0123)",
      tag: "workspace",
      params: [{ ...q("branch"), required: true }],
      ok: { status: 200, schema: "BranchCompare", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/repos/{repoId}/branches": {
    put: {
      id: "editRepoBranches",
      summary:
        "Set a repo's default branch and named branches in its manifest, keeping the rest of the file and its comments; commit it in a pull request (ADR 0123)",
      tag: "workspace",
      params: [p("repoId")],
      body: EditRepoBranchesRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404],
    },
  },
  "/api/repos/{repoId}/build": {
    put: {
      id: "editRepoBuild",
      summary:
        "Set or clear a repo's build command in its manifest, keeping the rest of the file and its comments; checked as the manifest schema checks it, and committed in a pull request. A task's PR is raised only after a passing build",
      tag: "workspace",
      params: [p("repoId")],
      body: EditRepoBuildRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404, 409],
    },
  },
  "/api/orgpack/owner": {
    put: {
      id: "setOrgPackOwner",
      summary:
        "Set who looks after the org pack (pack.yaml's owner, one handle), as atticus orgpack owner does; committed in a pull request its owner approves",
      tag: "run",
      body: SetOrgPackOwnerRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404, 409],
    },
  },
  "/api/repos/{repoId}/description": {
    put: {
      id: "editRepoDescription",
      summary:
        "Say what a repo is in one line, confirm the draft your assistant wrote, or drop it; written to the manifest, which you commit in a pull request (ADR 0128)",
      tag: "workspace",
      params: [p("repoId")],
      body: EditRepoDescriptionRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Written" },
      errors: [400, 404],
    },
  },
  "/api/specs": {
    get: {
      id: "listSpecs",
      summary: "The repos with a spec, and how many flows each has (ADR 0092)",
      tag: "views",
      ok: { status: 200, schema: "SpecList", description: "OK" },
    },
  },
  "/api/specs/{repo}": {
    get: {
      id: "getSpec",
      summary: "A repo's flows: what starts each, its steps and how many are confirmed (ADR 0092)",
      tag: "views",
      params: [p("repo")],
      ok: { status: 200, schema: "SpecView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/specs/{repo}/flows/{flowId}": {
    get: {
      id: "getFlow",
      summary:
        "One flow, with the flows its call-outs start and the flows that call it, from specs/estate.yaml (ADR 0092)",
      tag: "views",
      params: [p("repo"), p("flowId")],
      ok: { status: 200, schema: "FlowView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/target-flows": {
    get: {
      id: "listTargetFlows",
      summary:
        "The change's target flows: each flow it adds, changes or removes, with counts (ADR 0095)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "TargetFlowList", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/inputs": {
    get: {
      id: "listChangeInputs",
      summary:
        "The files attached to a change: what each is, who attached it and when, and how it is cited (ADR 0113)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeInputList", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "attachChangeInput",
      summary:
        "Attach a file to a change (its bytes in base64): copied into its inputs/, read and cited by its steps, as data (ADR 0113)",
      tag: "changes",
      params: [p("changeId")],
      body: AttachFileRequest,
      ok: { status: 201, schema: "AttachResult", description: "Attached, or refused with why" },
      errors: [400, 404, 413, 422],
    },
  },
  "/api/changes/{changeId}/prototypes": {
    get: {
      id: "listChangePrototypes",
      summary:
        "The prototypes attached to a change, each compared again with the estate: every call its UI makes to its BFF and its BFF makes to a mock, as exists, changes, new or vendor, cited (ADR 0133)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangePrototypeList", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "compareChangePrototype",
      summary:
        "Round 36 (UX review): compare a prototype repo with the estate and attach the comparison to the change, as atticus change attach <change> --prototype <repo>; 422 with its words when it refuses",
      tag: "changes",
      params: [p("changeId")],
      body: ComparePrototypeRequest,
      ok: { status: 201, schema: "ComparePrototypeView", description: "Compared and attached" },
      errors: [400, 404, 422],
    },
  },
  "/api/questions/{id}/targets": {
    get: {
      id: "getQuestionTargets",
      summary:
        "The Another repo… picker of a targets question: every repo of the manifest (read or not), every system of the profiles and every team in roles.yaml",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "TargetPickList", description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/questions/{id}/evidence": {
    get: {
      id: "getQuestionEvidence",
      summary:
        "The lines around each line a question cites, from the repo's base clone or the metarepo, so a person answers looking at the code",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "QuestionEvidenceList", description: "OK" },
      errors: [404],
    },
  },
  "/api/past-changes": {
    get: {
      id: "listPastChanges",
      summary:
        "The archived changes nearest a new change's title or brief, by meaning where the embedding model is on and by words where it isn't, to start from one (WP7.6)",
      tag: "changes",
      params: [q("text"), q("change"), q("limit", { type: "integer" })],
      ok: { status: 200, schema: "SimilarChanges", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/like": {
    post: {
      id: "attachPastChange",
      summary:
        "Attach an archived change to a change as an example its steps read, as data (WP7.6)",
      tag: "changes",
      params: [p("changeId")],
      body: AttachPastChangeRequest,
      ok: { status: 201, schema: "AttachPastChangeResult", description: "Attached" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/cockpit": {
    get: {
      id: "getChangeCockpit",
      summary:
        "One change at a glance: where it is, the next step with its slash command, what blocks it, each stage's progress, the risk, and each repo's change branch and base",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeCockpit", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/inputs/{name}/promote": {
    post: {
      id: "promoteChangeInput",
      summary:
        "Copy a file attached to a change into general knowledge (inputs/inbox/); the change keeps its copy (ADR 0122)",
      tag: "changes",
      params: [p("changeId"), p("name")],
      ok: { status: 200, schema: "PromoteResult", description: "Copied" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/map": {
    get: {
      id: "getChangeMap",
      summary:
        "The change's picture: the components, entries and tables its target flows touch, marked new, modify or retire (ADR 0108)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeMap", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/sketch": {
    get: {
      id: "getChangeSketch",
      summary:
        "What was drawn on the canvas for the change: the strokes Undo can take back, and the picture (ADR 0179)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "SketchResult", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "sketchChange",
      summary:
        "Draw one stroke of the change on the canvas: a call, a topic, a table, a step removed or sent elsewhere, or one taken back; written as a flow delta in target-flows/ after the person's yes, preview first (ADR 0179)",
      tag: "changes",
      params: [p("changeId")],
      body: SketchStrokeRequest,
      ok: { status: 200, schema: "SketchResult", description: "Drawn, or why not" },
      errors: [400, 404, 409],
    },
  },
  "/api/changes/{changeId}/impact": {
    get: {
      id: "getChangeImpact",
      summary:
        "The change's impact, as designed: who each entry or table it breaks is called or used by, the fields that stop crossing and the gateway routes to update, each with its owner; a guessed link may break (ADR 0144)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeImpact", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/estimate": {
    get: {
      id: "getChangeEstimate",
      summary:
        "The change's estimate: its size from the target flows, the org pack's ranges summed, the drivers with their sources (ADR 0109)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeEstimate", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/conformance": {
    get: {
      id: "getChangeConformance",
      summary:
        "Does the code do what the design says: the newest check of each repo's branch against the change's target flows, with what is missing, still there or unexpected and where (ADR 0114)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeConformance", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "checkChangeConformance",
      summary:
        "2.76.0 (eighth UX walk): check the code against the design again on the person's click, as atticus change conform; what the facts don't cover is never missing (rule 4)",
      tag: "changes",
      params: [p("changeId")],
      ok: {
        status: 202,
        schema: "JobAccepted",
        description: "Started: its job's result is the code and the lines",
      },
      errors: [400, 404, 409],
    },
  },
  "/api/changes/{changeId}/target-flows/{flowId}": {
    get: {
      id: "getTargetFlow",
      summary:
        "One target flow beside today's: each step marked same, changed, added or removed (ADR 0095)",
      tag: "changes",
      params: [p("changeId"), p("flowId")],
      ok: { status: 200, schema: "TargetFlowView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/cites": {
    get: {
      id: "getCites",
      summary:
        "Each line of one file that a spec flow or a catalog record cites, with what cites it (ADR 0094)",
      tag: "views",
      params: [
        q("repo", str, "The code's repo, as citations name it"),
        q("path", str, "The file's path in that repo, as citations name it"),
      ],
      ok: { status: 200, schema: "CiteList", description: "OK" },
      errors: [400],
    },
  },
  "/api/onboarding": {
    get: {
      id: "getOnboarding",
      summary:
        "Each manifest repo with its clone, scan settings and last scan's counts, and the knowledge sources (ADR 0084)",
      tag: "workspace",
      ok: { status: 200, schema: "OnboardingView", description: "OK" },
    },
  },
  "/api/trust": {
    get: {
      id: "getTrust",
      summary:
        "How far to trust each repo's map: its facts, the verifier's report (kept, rejected, coverage, unknown files), the facts' commit against the checkout's, and whether its catalog records come from the facts or the readers (ADR 0124)",
      tag: "workspace",
      ok: { status: 200, schema: "TrustView", description: "OK" },
    },
  },
  "/api/trust/answer-boxes/ignore": {
    post: {
      id: "ignoreAnswerBox",
      summary:
        "A box an answer's words made (beta.24 review), put right as 'it was ignore this': each answer that names it becomes Ignore (the join leaves its calls) and the system leaves its profile. preview writes nothing; the write is local, for Propose for review",
      tag: "workspace",
      body: AnswerBoxRequest,
      ok: { status: 200, schema: "AnswerBoxResult", description: "Previewed or written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/trust/answer-boxes/rename": {
    post: {
      id: "renameAnswerBox",
      summary:
        "A box an answer's words made (beta.24 review), renamed to a real system: a repo or system Atticus knows, or a new outside system's short name; the answers that name it name that instead. preview writes nothing; the write is local, for Propose for review",
      tag: "workspace",
      body: AnswerBoxRequest,
      ok: { status: 200, schema: "AnswerBoxResult", description: "Previewed or written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/trust/fresh": {
    get: {
      id: "getTrustFresh",
      summary:
        "Which repos' clones have moved past their facts' commit, most stale first: per repo the facts' commit and the clone's, the files changed that the facts cite, the facts to read again and carried, and the command to run; local git only (ADR 0141)",
      tag: "workspace",
      ok: { status: 200, schema: "FreshView", description: "OK" },
    },
  },
  "/api/facts/{repo}": {
    get: {
      id: "getRepoFacts",
      summary:
        "A repo's facts as the Map cites them: each with its line and quote, who made and checked it, the fields a person may correct and any correction on file; the open questions about the repo (ADR 0124)",
      tag: "workspace",
      params: [p("repo")],
      ok: { status: 200, schema: "RepoFactsView", description: "OK" },
      errors: [400],
    },
  },
  "/api/facts/{repo}/corrections": {
    post: {
      id: "correctFact",
      summary:
        "Mark a fact wrong or correct its claim: a line in facts/<repo>.corrections.jsonl, which atticus verify applies every time it runs. Returns the git command that commits the file and the verify command",
      tag: "workspace",
      params: [p("repo")],
      body: FactCorrectionRequest,
      ok: { status: 200, schema: "FactCorrectionResult", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/links/corrections": {
    post: {
      id: "correctLinkCalls",
      summary:
        "This whole arrow is wrong (beta.24): one correction of every call on a link, each in its caller repo's facts/<repo>.corrections.jsonl (several lines in one write per repo), every item checked before any is written. Returns each file, the git command that commits them all and the verify command per repo",
      tag: "workspace",
      body: LinkCorrectionsRequest,
      ok: { status: 200, schema: "LinkCorrectionsResult", description: "Recorded" },
      errors: [400, 404, 422, 500],
    },
  },
  "/api/facts/{repo}/preview": {
    get: {
      id: "previewVerifyWrite",
      summary:
        "After a correction: the commands to run (atticus verify <repo> --write, then the git steps with the exact files) and what that write will change in the facts and the catalog (links moved, added, removed; facts dropped or edited), computed in-process without writing (ADR 0149)",
      tag: "workspace",
      params: [p("repo"), q("fact", str, "The fact corrected, for the branch and commit message")],
      ok: { status: 200, schema: "VerifyPreviewView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/facts/{repo}/audit": {
    get: {
      id: "drawAudit",
      summary:
        "A repo's sample audit drawn as atticus verify audit draws it (the same seed, the same sample): each item with its cited lines and any answer on file, and the precision so far. Writes nothing (ADR 0149)",
      tag: "workspace",
      params: [
        p("repo"),
        q("seed", str, "The seed; default <repo>@<commit>"),
        q("size", { type: "integer" }, "How many facts and how many links; default 10"),
      ],
      ok: { status: 200, schema: "AuditSampleView", description: "OK" },
      errors: [400],
    },
    post: {
      id: "answerAudit",
      summary:
        "Answer items of a draw right, wrong or unsure (with a note): written to facts/<repo>.audit.yaml by the same functions as atticus verify audit. Returns the precision and the git command (ADR 0149)",
      tag: "workspace",
      params: [p("repo")],
      body: AuditAnswerRequest,
      ok: { status: 200, schema: "AuditAnswerResult", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/contracts": {
    get: {
      id: "getContracts",
      summary:
        "The contract check on every link: the payload on both sides of each REST call, gateway hop, topic and call to an outside system, compared from the field facts and the specs on file; each mismatch and unconfirmed difference with both lines (ADR 0164)",
      tag: "views",
      ok: { status: 200, schema: "ContractsView", description: "OK" },
    },
  },
  "/api/outside": {
    get: {
      id: "getOutsideSystems",
      summary:
        "The systems outside the estate (vendors and other teams): who calls each, the operations its intaken spec publishes, the calls that match nothing in it, its open questions, and how to add a spec (ADR 0149)",
      tag: "views",
      ok: { status: 200, schema: "OutsideView", description: "OK" },
    },
  },
  "/api/workspace/sync": {
    post: {
      id: "syncWorkspace",
      summary:
        "Clone or update base clones. 3.0.0 (review round 48): 409 while a sync runs on this server",
      tag: "workspace",
      body: ScanRequest.pick({ repos: true }),
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  "/api/scan": {
    post: {
      id: "startScan",
      summary: "Scan repos into the catalog",
      tag: "scans",
      body: ScanRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  "/api/reconcile": {
    post: {
      id: "startReconcile",
      summary:
        "Check a diagram against the catalog. 3.0.0 (review round 48): 409 while a reconcile runs on this server",
      tag: "scans",
      body: ReconcileRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [404, 409],
    },
  },
  "/api/jobs/{jobId}": {
    get: {
      id: "getJob",
      summary: "Follow a job",
      tag: "scans",
      params: [p("jobId")],
      ok: { status: 200, schema: "Job", description: "OK" },
      errors: [404],
    },
  },
  "/api/jobs/{jobId}/cancel": {
    post: {
      id: "cancelJob",
      summary: "Cancel a job",
      tag: "scans",
      params: [p("jobId")],
      ok: { status: 200, schema: "Job", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/changes": {
    get: {
      id: "listChanges",
      summary: "Changes in the metarepo",
      tag: "changes",
      params: [q("state"), q("mine", { type: "boolean" })],
      ok: { status: 200, schema: arrayOf("ChangeSummary"), description: "OK" },
    },
    post: {
      id: "createChange",
      summary: "Start a change (creates the OpenSpec change)",
      tag: "changes",
      body: NewChangeRequest,
      ok: { status: 201, schema: "ChangeDetail", description: "Created" },
      errors: [400, 409, 422],
    },
  },
  "/api/facts/{repo}/apply": {
    post: {
      id: "applyFacts",
      summary:
        "2.65.0 (ADR 0183): run atticus verify <repo> --write, as Apply after an answer or a correction",
      tag: "workspace",
      params: [p("repo")],
      ok: {
        status: 202,
        schema: "JobAccepted",
        description: "Started: its job's result is the code and the lines verify printed",
      },
      // 2.68.0: 409 while another local step (Apply, Propose, Bring in) runs.
      errors: [400, 409],
    },
  },
  "/api/propose": {
    get: {
      id: "proposePlan",
      summary:
        "2.65.0 (ADR 0183): the files a kind of work changed, the branch and the title Propose for review would use",
      tag: "workspace",
      params: [
        q(
          "scope",
          str,
          "answers, corrections, audit, org-pack, owner-answers, baseline, initiatives, outcomes, work or service-desk",
        ),
      ],
      ok: { status: 200, schema: "ProposePlanView", description: "OK" },
      errors: [400, 422],
    },
    post: {
      id: "proposeForReview",
      summary:
        "2.65.0 (ADR 0183): on the person's yes, commit exactly those files to the branch, push it and open the PR; a person merges. 3.0.0 (ADR 0186): needs the person's confirmation (`propose`, the scope), else 403",
      tag: "workspace",
      body: ProposeRequest,
      ok: {
        status: 202,
        schema: "JobAccepted",
        description: "Started: its job's result is the code and the lines",
      },
      // 2.68.0: 409 while another local step (Apply, Propose, Bring in) runs.
      errors: [400, 403, 409],
    },
  },
  "/api/owner-questions": {
    get: {
      id: "listOwnerQuestions",
      summary:
        "2.67.0 (UX review): the knowledge gaps' owner questions, answered or not, and how many are open",
      tag: "questions",
      ok: { status: 200, schema: "OwnerQuestionList", description: "OK" },
    },
  },
  "/api/owner-questions/{id}/send": {
    post: {
      id: "sendOwnerQuestion",
      summary:
        "3.6.0 (ADR 0191): send the owner question through the notify adapter to its owner, on the person's `owner-ask` confirmation; with manual notifications it is a step for a person, and with none it says to copy the text",
      tag: "questions",
      params: [p("id")],
      body: SendOwnerAskRequest,
      ok: { status: 200, schema: "SentOwnerAsk", description: "Sent, or why not" },
      errors: [400, 403, 404],
    },
  },
  "/api/owner-questions/{id}/answer": {
    post: {
      id: "answerOwnerQuestion",
      summary:
        "2.67.0 (UX review): record an owner's answer as the signed-in person, in catalog/curated/ownerquestion/<id>.yaml (as atticus questions owner); the gap closes once the fact is in the catalog",
      tag: "questions",
      params: [p("id")],
      body: OwnerAnswerRequest,
      ok: { status: 200, schema: "OwnerAnswerResult", description: "Recorded" },
      errors: [400, 404],
    },
  },
  "/api/propose/bring-in": {
    post: {
      id: "bringInMerged",
      summary:
        "2.66.0 (review round 35): after a proposal or hand-off merges, put back each edit the upstream branch already has and fast-forward; the person's own edits stay",
      tag: "workspace",
      ok: {
        status: 202,
        schema: "JobAccepted",
        description: "Started: its job's result is the code and the lines",
      },
      // 2.68.0: 409 while another local step (Apply, Propose, Bring in) runs.
      errors: [409],
    },
  },
  "/api/change-types": {
    get: {
      id: "listChangeTypes",
      summary: "2.64.0: the org pack's change types, for the New change form",
      tag: "changes",
      ok: { status: 200, schema: arrayOf("ChangeTypeView"), description: "OK" },
    },
  },
  "/api/changes/{changeId}": {
    get: {
      id: "getChange",
      summary: "A change with its artifacts, workspace and hand-off",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeDetail", description: "OK" },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/owners/suggested": {
    get: {
      id: "suggestChangeOwners",
      summary:
        "3.6.0 (ADR 0191): who roles.yaml suggests for each role the change doesn't name yet: the team owning its repos, else the organisation's default; a person accepts one with PUT .../owners",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "OwnerSuggestionList", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/work-items": {
    get: {
      id: "planWorkItems",
      summary:
        "3.6.0 (ADR 0191): the feature, stories and tasks the plan puts in the work tracker, and what sync.yaml remembers of each (atticus ado sync --dry-run)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "WorkItemPlan", description: "OK" },
      errors: [400, 404, 422],
    },
    post: {
      id: "syncWorkItems",
      summary:
        "3.6.0 (ADR 0191): put them in the work tracker as the signed-in person: with a manual tracker a step each (the fields to copy, the id to record); with a live one, on the person's `work-items` confirmation. sync.yaml keeps each id, so a later sync updates rather than duplicates. 3.9.0: with `job: true`, 202 JobAccepted at once; the job's result `answer` is the result, or `problem` when refused",
      tag: "changes",
      params: [p("changeId")],
      body: WorkItemSyncRequest,
      ok: { status: 200, schema: "WorkItemSyncResult", description: "Synced" },
      alsoOk: { status: 202, schema: "JobAccepted", description: "Started as a job (`job: true`)" },
      errors: [400, 403, 404, 422],
    },
  },
  "/api/changes/{changeId}/stories/shape": {
    get: {
      id: "getStoryShape",
      summary:
        "3.6.0 (ADR 0191): the business analyst's renames, splits, merges and added stories, each task's story as the last draft mapped it, and what is uncovered",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "StoryShapeView", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "shapeStories",
      summary:
        "3.6.0 (ADR 0191): rename, split, merge or add a story in plain words, as the signed-in person; a rename and a merge keep the number, a split's new part and an added story take the next free one. The next draft of the stories maps the tasks to them",
      tag: "changes",
      params: [p("changeId")],
      body: StoryShapeRequest,
      ok: { status: 201, schema: "StoryShapeView", description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/stories/shape/{entryId}/remove": {
    post: {
      id: "removeStoryShape",
      summary:
        "3.6.0 (ADR 0191): take back a shaping no draft has read yet; one a draft applied stays, and a later one changes it",
      tag: "changes",
      params: [p("changeId"), p("entryId")],
      ok: { status: 200, schema: "StoryShapeView", description: "Removed" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/owners": {
    put: {
      id: "setChangeOwners",
      summary:
        "2.83.0 (ninth UX walk): name the change's owners per role (product owner, architect, business analyst, tech lead) in change.yaml, on the person's click",
      tag: "changes",
      params: [p("changeId")],
      body: ChangeOwnersRequest,
      ok: { status: 200, schema: "ChangeDetail", description: "The change with its owners" },
      errors: [400, 403, 404],
    },
  },
  "/api/changes/{changeId}/status": {
    get: {
      id: "getChangeStatus",
      summary: "State, next step, risk, test kinds, approvals and what blocks it (ADR 0043)",
      tag: "changes",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["state", "nextStep"] },
        description: "OK",
      },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/release-prs": {
    post: {
      id: "raiseReleasePrs",
      summary:
        "Raise one release PR per code repo from change/<id> into its default branch, as the signed-in person (ADR 0184). 3.0.0 (ADR 0186): needs the person's confirmation (`release-prs`, the change), else 403",
      tag: "changes",
      params: [p("changeId")],
      body: ReleasePrsRequest,
      ok: {
        status: 201,
        schema: "LinesView",
        description: "Raised: what each repo's release PR said",
      },
      errors: [400, 403, 404, 422],
    },
  },
  "/api/changes/{changeId}/sync": {
    post: {
      id: "syncChange",
      summary:
        "Refresh the change from its hand-off PR and advance it when merged (ADR 0043). 3.0.0 (ADR 0186): merges a ready PR only with the person's confirmation (`merge`, the change); without one it only reads, and a confirmation that isn't valid is 403",
      tag: "changes",
      params: [p("changeId")],
      body: SyncRequest,
      ok: { status: 200, schema: "ChangeDetail", description: "OK" },
      errors: [400, 403, 404, 422],
    },
  },
  "/api/changes/{changeId}/artifacts/{artifact}": {
    get: {
      id: "getArtifact",
      summary: "Read an artifact",
      tag: "changes",
      params: [
        p("changeId"),
        p("artifact", { schema: { type: "string", enum: ChangeArtifact.options } }),
        q(
          "file",
          str,
          "2.74.0: one file of a many-file artifact, relative to the change folder (stories/<id>.md, specs/<capability>/spec.md); left out, its first file",
        ),
      ],
      ok: { status: 200, schema: "ArtifactContent", description: "OK" },
      errors: [400, 404],
    },
    put: {
      id: "saveArtifact",
      summary: "Save an artifact edited in the UI",
      tag: "changes",
      params: [
        p("changeId"),
        p("artifact", { schema: { type: "string", enum: ChangeArtifact.options } }),
        q(
          "file",
          str,
          "2.74.0: one file of a many-file artifact, relative to the change folder (stories/<id>.md, specs/<capability>/spec.md); left out, its first file",
        ),
      ],
      body: SaveArtifactRequest,
      ok: { status: 200, schema: "ArtifactContent", description: "Saved" },
      errors: [400, 403, 404, 409],
    },
  },
  "/api/changes/{changeId}/tasks": {
    get: {
      id: "listTasks",
      summary: "Tasks by repo, in order",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: arrayOf("Task"), description: "OK" },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/tasks/{taskId}/pr": {
    post: {
      id: "raiseTaskPr",
      summary:
        "2.69.0 (sixth UX walk): on the person's yes, push a drafted task's branch and open its PR into the change branch. 3.0.0 (ADR 0186): needs the person's confirmation (`task-pr`, `<change>/<task>`), else 403",
      tag: "changes",
      params: [p("changeId"), p("taskId")],
      body: ConfirmedRequest,
      ok: { status: 201, schema: "Task", description: "The task, its PR raised" },
      errors: [403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/tasks/ready": {
    get: {
      id: "readyTasks",
      summary:
        "2.79.0 (ADR 0181 part 4): the change's tasks not done yet in cross-repo order, each ready to run or why not",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ReadyTasks", description: "OK" },
      errors: [404],
    },
  },
  "/api/changes/{changeId}/tasks/run-ready": {
    post: {
      id: "runReadyTasks",
      summary:
        "2.79.0 (ADR 0181 part 4): Run all ready tasks, one task run each in order as one job, stopping on the first that needs a person; the click is the approval for draft, never the pr level. 3.1.0: in model mode 403 unless runtime.yaml sends the key where the person last confirmed",
      tag: "changes",
      params: [p("changeId")],
      body: RunReadyRequest,
      ok: { status: 202, schema: "RunReadyAccepted", description: "Job started" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/tasks/{taskId}/done": {
    post: {
      id: "setTaskDone",
      summary:
        "2.75.0 (seventh UX walk): tick or untick a task in the change's tasks.md, on the person's click",
      tag: "changes",
      params: [p("changeId"), p("taskId")],
      body: TaskDoneRequest,
      ok: { status: 200, schema: "Task", description: "The task as tasks.md now says it" },
      errors: [400, 403, 404, 409],
    },
  },
  "/api/propose/upstream": {
    post: {
      id: "setUpstream",
      summary:
        "3.3.0 (app-only audit): set the upstream of the branch checked out to the same branch on a remote, a local setting (nothing is sent), as a local job; refused (the job's result says why) for any other branch",
      tag: "workspace",
      body: UpstreamRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [400, 409],
    },
  },
  "/api/changes/{changeId}/handoff/push": {
    post: {
      id: "pushHandoff",
      summary:
        "3.3.0 (app-only audit): Push again: push the open hand-off's branch, kept here when its push failed, by name and never forced; needs the person's confirmation (`handoff`, the change), else 403; 422 with git's words when the push fails",
      tag: "changes",
      params: [p("changeId")],
      body: ConfirmedRequest,
      ok: { status: 200, schema: "ChangeDetail", description: "The change, its branch pushed" },
      errors: [403, 404, 422],
    },
  },
  "/api/changes/{changeId}/tasks/{taskId}/build": {
    post: {
      id: "buildTask",
      summary:
        "3.3.0 (app-only audit): Build and raise PR on a task drafted but not built (UNVERIFIED) or taken over by a person: build it with its repo's build command as it is now, and with `raise` push its branch and open its PR (needs the person's confirmation, `task-pr`, `<change>/<task>`, else 403)",
      tag: "changes",
      params: [p("changeId"), p("taskId")],
      body: TaskBuildRequest,
      ok: { status: 200, schema: "Task", description: "The task, built (201 with its PR raised)" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/workspace": {
    post: {
      id: "openWorkspace",
      summary:
        "Create the change's worktrees and editor workspaces; 3.1.0: 409 while a sync of one of its repos' base clones runs elsewhere",
      tag: "changes",
      params: [p("changeId")],
      body: OpenWorkspaceRequest,
      ok: { status: 200, schema: "ChangeRepos", description: "OK" },
      errors: [400, 404, 409],
    },
  },
  "/api/changes/{changeId}/handoff": {
    post: {
      id: "handOff",
      summary:
        "Open the phase's hand-off PR after its gate passes. 3.0.0 (ADR 0186): needs the person's confirmation (`handoff`, the change), else 403",
      tag: "changes",
      params: [p("changeId")],
      body: HandoffRequest,
      ok: { status: 201, schema: "ChangeDetail", description: "Hand-off PR opened" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/runs": {
    get: {
      id: "listRuns",
      summary: "AI runs for a change",
      tag: "ai",
      params: [p("changeId")],
      ok: { status: 200, schema: arrayOf("RunView"), description: "OK" },
      errors: [404],
    },
    post: {
      id: "startRun",
      summary:
        "Prepare an AI run (hand-off by default); 3.1.0: in model mode 403 unless runtime.yaml sends the key where the person last confirmed (ADR 0186 addendum), and 409 while a sync of the task's repo runs elsewhere",
      tag: "ai",
      params: [p("changeId")],
      body: StartRunRequest,
      ok: { status: 201, schema: "RunView", description: "Prepared" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/critic": {
    post: {
      id: "runCritic",
      summary:
        "Run the critic: rule checks, and AI lenses handed to the assistant unless AI is off",
      tag: "findings",
      params: [p("changeId")],
      body: RunCriticRequest,
      ok: { status: 200, schema: { type: "object", required: ["ai", "round"] }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/runs/{runId}": {
    get: {
      id: "getRun",
      summary: "A run's state",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404],
    },
  },
  "/api/runs": {
    get: {
      id: "listModelRuns",
      summary:
        "Every model run, newest first: its step, round, state and whether it was answered (ADR 0106)",
      tag: "ai",
      params: [
        q("change", str, "Only the runs of this change or step"),
        q("limit", { type: "integer", minimum: 1 }, "At most this many (default 200)"),
      ],
      ok: { status: 200, schema: "RunList", description: "OK" },
      errors: [400],
    },
    post: {
      id: "startStep",
      summary:
        "Start an AI step on the server with runtime.yaml's model, as a job (ADR 0106); 409 when no model is configured, or (2.68.0) while another AI step runs; 3.1.0: 403 unless runtime.yaml sends the key where the person last confirmed (ADR 0186 addendum)",
      tag: "ai",
      body: StartStepRequest,
      ok: {
        status: 202,
        schema: { type: "object", required: ["jobId", "model"] },
        description: "Started",
      },
      errors: [400, 403, 409],
    },
  },
  "/api/runs/handoff": {
    post: {
      id: "prepareStep",
      summary:
        "2.66.0 (UX review): prepare an AI step for the person's own assistant (`--handoff`): its run's page has the prompt to copy and Done",
      tag: "ai",
      body: StartStepRequest,
      ok: { status: 201, schema: "PreparedStepView", description: "Prepared" },
      errors: [400, 422],
    },
  },
  "/api/links/candidates": {
    get: {
      id: "getLinkCandidates",
      summary:
        "Connect two boxes (ADR 0174, G1): box A's calls that join nothing, box B's APIs, and the API each call most likely is",
      tag: "views",
      params: [
        q("from", str, "Box A: the caller's repo"),
        q("to", str, "Box B: a repo of the manifest"),
        q("system", str, "Box B: an outside system of the profile (instead of to)"),
      ],
      ok: { status: 200, schema: "LinkCandidatesView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/links/connect": {
    post: {
      id: "connectLinks",
      summary:
        "Pair box A's calls with box B's APIs (ADR 0174, G1): a link line per pair in A's corrections, and with rule a /** answer; with preview, what it would write and the next verify --write changes",
      tag: "views",
      body: ConnectLinksRequest,
      ok: { status: 200, schema: "ConnectLinksResult", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/links/match": {
    get: {
      id: "getLinkMatch",
      summary:
        "Where Copilot's match of box A's calls to box B's APIs stands (ADR 0178, part 2): the brief, the answer read back and checked, as proposals a person ticks",
      tag: "views",
      params: [q("from"), q("to"), q("system")],
      ok: { status: 200, schema: "MatchLinksView", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "matchLinks",
      summary:
        "Start a Copilot session that proposes pairings of A's loose calls with B's APIs from a brief of their cited lines (ADR 0178, part 2); it writes only its answer file, and nothing is a correction until a person ticks and confirms it. Where copilot-acp isn't allowed, writes the brief for Copilot Chat and says so",
      tag: "views",
      body: MatchLinksRequest,
      ok: { status: 202, schema: "MatchLinksView", description: "Accepted" },
      errors: [400, 404, 409],
    },
  },
  "/api/links/match/done": {
    post: {
      id: "matchLinksDone",
      summary:
        "Read in the answer of a hand-off Match (ADR 0178 part 2; ADR 0181, ninth UX walk): the person's assistant wrote it from the brief; Atticus checks it and, when runtime.yaml's decide.links is auto, applies what passes the citation check and the bar as the AI's (runtime hand-off, with the run), keeping the rest as proposals. 409 when no answer is written yet",
      tag: "views",
      body: MatchLinksRequest,
      ok: { status: 200, schema: "MatchLinksView", description: "OK" },
      errors: [400, 404, 409],
    },
  },
  "/api/propose-answers": {
    get: {
      id: "getQuestionsPropose",
      summary:
        "Ask AI to propose answers (ADR 0144, 0181): the hand-off run open for the person's assistant, if any, and the line to paste",
      tag: "questions",
      ok: { status: 200, schema: "QuestionsProposeView", description: "OK" },
    },
    post: {
      id: "proposeQuestions",
      summary:
        "Hand the open questions to the person's assistant as one hand-off run (/atticus-propose); its Done reads the proposals in and, when runtime.yaml's decide.questions is auto, applies each that checks and meets the bar as the AI's (runtime hand-off, with the run). Nothing is answered as a person",
      tag: "questions",
      ok: { status: 201, schema: "QuestionsProposeView", description: "Created" },
      errors: [409],
    },
  },
  "/api/facts/apply-all": {
    post: {
      id: "applyAllFacts",
      summary:
        "3.5.0 (ADR 0188): run atticus verify --all --write as a local job, as Apply after a declaration or an owner set on the canvas",
      tag: "workspace",
      ok: {
        status: 202,
        schema: "JobAccepted",
        description: "Started: its job's result is the code and the lines verify printed",
      },
      errors: [409],
    },
  },
  "/api/estate/join": {
    post: {
      id: "joinEstate",
      summary:
        "3.5.0 (ADR 0188): run atticus estate join as a local job: each flow's calls to other repos followed into the flows they reach",
      tag: "workspace",
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  "/api/knowledge/sources/sync": {
    post: {
      id: "syncAllKnowledgeSources",
      summary:
        "3.5.0 (ADR 0188): run atticus sources sync as a local job: every wiki in sources.yaml read into a dated snapshot",
      tag: "knowledge",
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  "/api/workspace/prune": {
    post: {
      id: "pruneWorktrees",
      summary:
        "3.5.0 (ADR 0188): run atticus workspace prune as a local job, for one change or every change with worktrees; a worktree with uncommitted work is kept",
      tag: "workspace",
      body: PruneRequest,
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [400, 409],
    },
  },
  "/api/changes/{changeId}/tasks/{taskId}/context": {
    get: {
      id: "getTaskContext",
      summary:
        "3.5.0 (ADR 0188): a task's context as atticus task context --markdown prints it, for the person to copy into their assistant",
      tag: "changes",
      params: [p("changeId"), p("taskId")],
      ok: { status: 200, schema: "TaskContextView", description: "OK" },
      errors: [400],
    },
  },
  "/api/history/recording": {
    put: {
      id: "setPromptHistoryRecording",
      summary:
        "3.5.0 (ADR 0188): atticus history on|off, this machine's recording (.atticus/me.yaml); the org pack's history.record: false still holds",
      tag: "ai",
      body: HistoryRecordingRequest,
      ok: { status: 200, schema: "HistoryRecordingView", description: "OK" },
      errors: [400],
    },
  },
  "/api/upgrade": {
    get: {
      id: "getUpgrade",
      summary:
        "The upgrade steps this metarepo waits on (atticus upgrade --check): each step's summary and files, and whether a newer Atticus upgraded it",
      tag: "run",
      ok: { status: 200, schema: "UpgradeView", description: "OK" },
    },
    post: {
      id: "runUpgrade",
      summary:
        "Run atticus upgrade as a local job on the person's click: it backs up every file it changes, runs each pending step and stamps the metarepo; the changes are files to propose for review",
      tag: "run",
      ok: { status: 202, schema: "JobAccepted", description: "Job started" },
      errors: [409],
    },
  },
  // ADR 0190: settings and setup in the app, "Edit, then Propose".
  "/api/setup/metarepo": {
    get: {
      id: "getSetupMetarepo",
      summary:
        "3.5.0 (ADR 0190): whether the folder the app runs in is a metarepo, and what Create the metarepo here would use (a name and platform from the folder's name, the metarepo's id on the Git host from its origin)",
      tag: "run",
      ok: { status: 200, schema: "SetupMetarepoView", description: "OK" },
    },
    post: {
      id: "createMetarepo",
      summary:
        "Create the metarepo in this folder with atticus init's own code (name, platform, owner; the Git host manual, with the metarepo's id when given or read from origin), brought up to date as init does. Local files only: nothing is pushed. 409 when it is a metarepo already",
      tag: "run",
      body: CreateMetarepoRequest,
      ok: { status: 201, schema: "LinesView", description: "Created" },
      errors: [400, 409, 422],
    },
  },
  "/api/setup/open": {
    post: {
      id: "openFolder",
      summary:
        "Open another folder: start the app for that folder (a full path on this machine) on a free port, for the same person, and give its address; a folder that isn't a metarepo offers Create there",
      tag: "run",
      body: OpenFolderRequest,
      ok: { status: 200, schema: "OpenFolderView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/setup/repos/plan": {
    post: {
      id: "planRepos",
      summary:
        "The repos pasted clone URLs (one a line, up to 500) or a folder of clones (repos discover's own code, a dry run) would add: each normalised URL and the id repo add gives it, a clone URL a manifest lists already left out, a taken id given -2, and a folder's type from its files. A folder with several platforms and none given reads nothing and answers the platforms to choose from (`platforms`, no `platform`). Writes nothing",
      tag: "run",
      body: ReposPlanRequest,
      ok: { status: 200, schema: "ReposPlanView", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/setup/repos": {
    post: {
      id: "addRepos",
      summary:
        "Add the repos the person ticked to the platform's repos.manifest.yaml (core's addManifestRepos: comments, order and line endings kept, the manifest checked first); a description is the person's own (verified). With preview: the lines it would change, nothing written. Propose for review then opens the PR",
      tag: "run",
      body: AddReposRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/repos/{repoId}/type/detect": {
    post: {
      id: "detectRepoType",
      summary:
        "Detect a cloned repo's type: the org pack's repo types (atticus repo-type detect) when it has any, else the type repo add reads from the files. Writes nothing; 409 when the repo isn't cloned here",
      tag: "run",
      params: [p("repoId")],
      ok: { status: 200, schema: "RepoTypeDetectView", description: "OK" },
      errors: [404, 409, 422],
    },
  },
  "/api/repos/{repoId}/type": {
    put: {
      id: "setRepoType",
      summary:
        "Set a repo's type in the manifest that lists it (comments and order kept); with preview, the line it would change",
      tag: "run",
      params: [p("repoId")],
      body: RepoTypeRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/setup/adapters": {
    get: {
      id: "getAdapters",
      summary:
        "The outside systems runtime.yaml names (Git host, work tracker, service desk, notifications, wiki, design tool): the types its schema takes for each, the settings Atticus reads, what is set now, and runtime.yaml's sha256 to send back with a write. No secret is ever in them",
      tag: "run",
      ok: { status: 200, schema: "AdaptersView", description: "OK" },
    },
  },
  "/api/setup/adapters/{kind}": {
    put: {
      id: "setAdapter",
      summary:
        "Set (or with null, take out) one outside system in runtime.yaml, checked with the Runtime schema first (a type it doesn't take, a setting named like a secret or a value that looks like a token is refused, 422); edited in place, so comments, value types and line endings are kept. With `baseSha256` (GET's `sha256`), a runtime.yaml changed since is 409. With preview, the lines it would change. A token is kept in the credential store from the terminal (atticus secret set), never through this API",
      tag: "run",
      params: [p("kind")],
      body: AdapterRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/setup/file": {
    get: {
      id: "getOrgPackFile",
      summary:
        "One org-pack file for the raw editor (a path inside org-pack/ ending .yaml, .md, .txt or .json): its text, its sha256 and whether it is checked with a schema",
      tag: "run",
      params: [q("path")],
      ok: { status: 200, schema: "OrgPackFileView", description: "OK" },
      errors: [404, 422],
    },
    put: {
      id: "putOrgPackFile",
      summary:
        "The raw editor's write, the fallback for a setting with no form: the file's whole text, checked with its schema (YAML that doesn't parse, or doesn't read, is 422), onto the file as opened (another edit meanwhile is 409). With preview, the lines it would change. A runtime.yaml edit that moves where the model's key goes needs the person's confirmation (`ai-model`, `model`), else 403; a value that looks like a key is refused",
      tag: "run",
      body: OrgPackFileRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 403, 409, 422],
    },
  },
  "/api/setup/patterns": {
    post: {
      id: "addPattern",
      summary:
        "A new integration pattern from the app's form, as its own org-pack/patterns/<code>.yaml, checked with the pattern schema; a code that is there already is 409 (edit it in the raw editor). With preview, the lines it would write",
      tag: "run",
      body: PatternRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 409, 422],
    },
  },
  "/api/setup/sources": {
    post: {
      id: "addSource",
      summary:
        "A wiki added to sources.yaml with atticus sources add's own code (its checks, its id, the path written relative to the org pack); comments and line endings kept. A location with a user name or password in it is refused (422: Git's credential helper or an environment variable gives them), and so is a sources.yaml changed meanwhile (409). With preview, the entry it would add",
      tag: "run",
      body: SourceRequest,
      ok: { status: 200, schema: "FileEditView", description: "OK" },
      errors: [400, 409, 422],
    },
  },
  "/api/decisions": {
    get: {
      id: "getDecisions",
      summary:
        "The AI's decisions that stand (ADR 0181): its pairings and answers, each 'Detected by AI' with its run, the bar it met and its batch; counts split from code, by a person and by AI; the batches, newest first; and whether the AI decides now or is paused (with why, for Home)",
      tag: "questions",
      ok: { status: 200, schema: "DecisionsView", description: "OK" },
    },
  },
  "/api/decisions/correct": {
    post: {
      id: "correctDecision",
      summary:
        "A person corrects one AI decision (ADR 0181): the right option, API or none, recorded as theirs; with similar (on by default) a rule derived from it (or the one given) re-checks every AI decision and open item it covers, applied as their rule or opened again; with preview, what it would write and spread, and nothing written. One batch, one Undo away",
      tag: "questions",
      body: CorrectDecisionRequest,
      ok: { status: 200, schema: "CorrectDecisionResult", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/decisions/batches/{batchId}/undo": {
    post: {
      id: "undoDecisionBatch",
      summary:
        "Undo a batch of decisions (ADR 0181): remove exactly the lines and answers it wrote, and put back the AI decisions it took away; what changed since is left as it is and said",
      tag: "questions",
      params: [p("batchId")],
      ok: { status: 200, schema: "UndoBatchResult", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/facts/{repo}/corrections/undo": {
    post: {
      id: "undoCorrection",
      summary:
        "Remove exactly one line a person wrote to a repo's corrections file (ADR 0174, Undo)",
      tag: "views",
      params: [p("repo")],
      body: UndoCorrectionRequest,
      ok: {
        status: 200,
        schema: { type: "object", required: ["removed", "file"] },
        description: "OK",
      },
      errors: [400, 404],
    },
  },
  "/api/repos/{repo}/owner": {
    get: {
      id: "getRepoOwner",
      summary:
        "A repo's owner and system from its manifest, with the teams and systems to pick from (ADR 0174, G2)",
      tag: "workspace",
      params: [p("repo")],
      ok: { status: 200, schema: "RepoOwnerView", description: "OK" },
      errors: [400, 404],
    },
    put: {
      id: "setRepoOwner",
      summary:
        "Set a repo's owner or system in its manifest after the person's yes, or add a team to roles.yaml for review; with preview, the lines it would change (ADR 0174, G2)",
      tag: "workspace",
      params: [p("repo")],
      body: SetRepoOwnerRequest,
      ok: { status: 200, schema: "SetRepoOwnerResult", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/declared-links": {
    post: {
      id: "declareLink",
      summary:
        "Declare a link the code can't show (ADR 0174, G3): a topic a system publishes or listens on, or a route it calls, written to the profile with who and when; with preview, the lines it would change",
      tag: "workspace",
      body: DeclareLinkRequest,
      ok: { status: 200, schema: "FileChangeResult", description: "OK" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/declared-links/undo": {
    post: {
      id: "undeclareLink",
      summary: "Remove exactly one declared topic or call from a system in the profile (ADR 0174)",
      tag: "workspace",
      body: UndeclareLinkRequest,
      ok: { status: 200, schema: "FileChangeResult", description: "OK" },
      errors: [400, 404, 409],
    },
  },
  "/api/boxes/addable": {
    get: {
      id: "getAddableBoxes",
      summary:
        "What can be added to the picture: the manifest's repos (read or not), the profiles' systems, the teams (ADR 0174, G3)",
      tag: "workspace",
      ok: { status: 200, schema: "AddableView", description: "OK" },
    },
  },
  "/api/boxes": {
    post: {
      id: "addBox",
      summary: "Add a new vendor or team system to the profile, for review (ADR 0174, G3)",
      tag: "workspace",
      body: AddSystemRequest,
      ok: { status: 200, schema: "FileChangeResult", description: "OK" },
      errors: [400, 409, 422],
    },
  },
  "/api/boxes/corrections": {
    get: {
      id: "getBoxCorrections",
      summary:
        "A repo's corrections, or a system's declarations, each with what undoes it (ADR 0174)",
      tag: "workspace",
      params: [
        q("repo", str, "A repo of the manifest"),
        q("system", str, "A system of the profiles"),
      ],
      ok: { status: 200, schema: "BoxCorrections", description: "OK" },
      errors: [400],
    },
  },
  "/api/graph/views": {
    get: {
      id: "listCanvasViews",
      summary: "The canvas views kept in the metarepo: named filters and layers (ADR 0175)",
      tag: "views",
      ok: { status: 200, schema: "SavedCanvasViews", description: "OK" },
    },
  },
  "/api/graph/views/{name}": {
    put: {
      id: "putCanvasView",
      summary: "Keep a canvas view by name in diagrams/views/<name>.yaml, for review (ADR 0175)",
      tag: "views",
      params: [p("name"), q("replace", str, "1 to replace a view of that name kept already")],
      body: SavedCanvasView,
      ok: { status: 200, schema: "SavedCanvasView", description: "Kept" },
      errors: [400, 409],
    },
  },
  "/api/code-link": {
    get: {
      id: "getCodeLink",
      summary:
        "A cited line's file in the repo's checkout, with links that open it in VS Code or IntelliJ (ADR 0175)",
      tag: "views",
      params: [q("repo", str, "The repo"), q("at", str, "file:line as the fact cites it")],
      ok: { status: 200, schema: "CodeLink", description: "OK" },
      errors: [400],
    },
  },
  "/api/reading-rules/from-pairing": {
    post: {
      id: "ruleFromPairing",
      summary:
        "Make a pairing a draft reading rule for every repo of the caller's type, in org-pack/reading-rules/types/<type>.yaml, for review (ADR 0176)",
      tag: "views",
      body: RuleFromPairingRequest,
      ok: { status: 200, schema: "RuleFromPairingResult", description: "Drafted" },
      errors: [400, 404, 409],
    },
  },
  "/api/copilot-runs": {
    post: {
      id: "startCopilotRun",
      summary:
        "Start an unattended Copilot run (atticus map --all through copilot-acp) after the person's yes (ADR 0173); 409 when copilot-acp isn't allowed or a run is under way",
      tag: "ai",
      body: StartCopilotRunRequest,
      ok: { status: 202, schema: "CopilotRunView", description: "Started" },
      errors: [400, 409],
    },
  },
  "/api/copilot-runs/current": {
    get: {
      id: "getCurrentCopilotRun",
      summary:
        "The Copilot run under way (or the last one), its progress and its Console tabs' last lines (tail, 200 by default), and whether copilot-acp is allowed (ADR 0173)",
      tag: "ai",
      params: [q("tail", str, "How many of each tab's last lines; 0 for all")],
      ok: { status: 200, schema: "CopilotRunCurrent", description: "OK" },
    },
  },
  "/api/copilot-runs/{runId}/tabs/{tab}": {
    get: {
      id: "getCopilotRunTab",
      summary: "A Copilot run's Console tab, its lines from a line on (ADR 0173)",
      tag: "ai",
      params: [p("runId"), p("tab"), q("from", str, "The number of the first line wanted")],
      ok: {
        status: 200,
        schema: { type: "object", required: ["id", "title", "from", "lines"] },
        description: "OK",
      },
      errors: [404],
    },
  },
  "/api/activity": {
    get: {
      id: "listActivity",
      summary:
        "Everything Atticus is doing or did lately on this metarepo, newest first: the app's jobs, a Copilot run, the commands run in a terminal, an editor or a Copilot session, and the hand-off runs that wait for an assistant (ADR 0187)",
      tag: "ai",
      ok: { status: 200, schema: "ActivityList", description: "OK" },
    },
  },
  "/api/activity/{id}/lines": {
    get: {
      id: "getActivityLines",
      summary:
        "One activity's printed lines from a line on (from), or its last ones; a Copilot run's are its tabs (ADR 0187)",
      tag: "ai",
      params: [p("id"), q("from", str, "The number of the first line wanted")],
      ok: { status: 200, schema: "ActivityLines", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/copilot-runs/{runId}/stop": {
    post: {
      id: "stopCopilotRun",
      summary:
        "Stop a Copilot run: the session under way is cancelled; the next run carries on (ADR 0173)",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "CopilotRunView", description: "Stopping" },
      errors: [404, 409],
    },
  },
  "/api/runs/{runId}/transcript": {
    get: {
      id: "getRunTranscript",
      summary: "What a run was asked and answered, and the problems handed back to it (ADR 0106)",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunTranscript", description: "OK" },
      errors: [404],
    },
  },
  "/api/history": {
    get: {
      id: "listPromptHistory",
      summary:
        "The prompts people sent their assistant and the responses they got, as turns, newest first, and whether recording is on (ADR 0110)",
      tag: "ai",
      params: [
        q("change", str, "Only the turns about this change"),
        q("session", str, "Only this session's turns"),
        q("q", str, "Only the turns whose text, command, change or session has every word"),
        q("limit", { type: "integer", minimum: 1 }, "At most this many turns (default 200)"),
      ],
      ok: { status: 200, schema: "HistoryList", description: "OK" },
      errors: [400],
    },
  },
  "/api/history/{historyId}": {
    get: {
      id: "getPromptHistoryRecord",
      summary: "One prompt or response, and its pair (ADR 0110)",
      tag: "ai",
      params: [p("historyId")],
      ok: { status: 200, schema: "HistoryEntry", description: "OK" },
      errors: [404],
    },
  },
  "/api/runs/{runId}/done": {
    post: {
      id: "markRunDone",
      summary:
        "Mark done: validate the hand-off output now. 2.67.0 (fourth UX walk): a step the app prepared then resumes, writing what the answer said; `lines` says what happened and `next` names the step's next run when it offers another prompt. 3.5.0 (ADR 0188): a read of a repo's last batch is put on the map (verify --write), named in `applied`. 3.9.0: with `job: true`, 202 JobAccepted at once; the job's result `answer` is this view, or `problem` when refused",
      tag: "ai",
      params: [p("runId")],
      body: RunDoneRequest,
      bodyOptional: true,
      ok: { status: 200, schema: "RunDoneView", description: "OK" },
      alsoOk: { status: 202, schema: "JobAccepted", description: "Started as a job (`job: true`)" },
      errors: [404, 409, 422],
    },
  },
  "/api/runs/{runId}/retry": {
    post: {
      id: "retryRun",
      summary: "Retry a failed run",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/runs/{runId}/cancel": {
    post: {
      id: "cancelRun",
      summary: "Cancel a run",
      tag: "ai",
      params: [p("runId")],
      ok: { status: 200, schema: "RunView", description: "OK" },
      errors: [404, 409],
    },
  },
  "/api/findings": {
    get: {
      id: "listFindings",
      summary: "Critic findings, filtered",
      tag: "findings",
      params: [
        q("change"),
        q("gate"),
        q("state"),
        q("lens", { type: "string", enum: Lens.options }),
        q("severity", { type: "string", enum: Severity.options }),
        q(
          "asks",
          { type: "string", enum: ["business", "design", "delivery"] },
          "3.6.0 (ADR 0191): only findings that ask at this level",
        ),
      ],
      ok: { status: 200, schema: arrayOf("FindingView"), description: "OK" },
    },
  },
  "/api/findings/{changeId}/{findingId}": {
    get: {
      id: "getFinding",
      summary: "One finding",
      tag: "findings",
      params: [p("changeId"), p("findingId")],
      ok: { status: 200, schema: "Finding", description: "OK" },
      errors: [404],
    },
  },
  "/api/findings/{changeId}/{findingId}/action": {
    post: {
      id: "actOnFinding",
      summary: "Apply, Edit and apply, Not relevant, Waive or Ask",
      tag: "findings",
      params: [p("changeId"), p("findingId")],
      body: FindingActionRequest,
      ok: { status: 200, schema: "Finding", description: "Recorded" },
      errors: [400, 403, 404, 409, 422],
    },
  },
  "/api/todo": {
    get: {
      id: "listSteps",
      summary: "Manual steps, where they come from, and procedures with their executors",
      tag: "release",
      params: [q("change"), q("all", { type: "boolean" })],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [422],
    },
  },
  "/api/todo/{stepId}/export": {
    get: {
      id: "exportStep",
      summary: "One step for copying: text, CSV or an import row",
      tag: "release",
      params: [p("stepId"), q("format", { type: "string", enum: ["text", "csv", "import"] })],
      ok: { status: 200, schema: { type: "object", properties: { text: str } }, description: "OK" },
      errors: [404],
    },
  },
  "/api/todo/{stepId}/done": {
    post: {
      id: "recordStep",
      summary:
        "Record a manual step's result, or skip it with a reason; 2.75.0: a Git host step of a change with a hand-off open syncs it (`synced`, read-only, never a merge)",
      tag: "release",
      params: [p("stepId")],
      body: StepDoneRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/todo/{stepId}/run": {
    get: {
      id: "previewStepRun",
      summary: "The exact inputs an executor would get, with their sha-256, before any run",
      tag: "release",
      params: [p("stepId"), q("with")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "runStep",
      summary:
        "Run a step with a team's own tool on the shown inputs (their sha-256). 3.0.0 (ADR 0186): needs the person's confirmation (`step-run`, the step), else 403",
      tag: "release",
      params: [p("stepId")],
      body: StepRunRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 403, 404, 422],
    },
  },
  "/api/release": {
    get: {
      id: "listReleases",
      summary: "Changes, those at go / no-go first",
      tag: "release",
      ok: { status: 200, schema: { type: "array", items: { type: "object" } }, description: "OK" },
    },
  },
  "/api/release/{changeId}": {
    get: {
      id: "getRelease",
      summary:
        "Release readiness: gates, approvers, requests, repos, rollout, conflicts and evidence",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404],
    },
  },
  "/api/release/{changeId}/archive": {
    post: {
      id: "archiveChange",
      summary: "Run the archive gate, then archive the released change",
      tag: "release",
      params: [p("changeId")],
      body: ArchiveRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/service-desk": {
    get: {
      id: "listServiceRequests",
      summary: "Service-request drafts matched to templates, with what is missing",
      tag: "release",
      params: [q("change")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/service-desk/{changeId}/draft": {
    post: {
      id: "draftServiceRequests",
      summary: "Draft the service requests a change needs",
      tag: "release",
      params: [p("changeId")],
      body: DraftRequestsRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/service-desk/{changeId}/submit": {
    post: {
      id: "submitServiceRequests",
      summary: "File the drafts through the manual desk: each becomes a step a person does",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/service-desk/{changeId}/fields": {
    put: {
      id: "fillServiceRequestFields",
      summary:
        "Round 36 (UX review): fill a draft's fields in the change's service-desk file, as a person editing it would (the value cells only; its comments and other lines stay); 409 when the file changed since it was read. Filing stays the person's File",
      tag: "release",
      params: [p("changeId")],
      body: FillRequestFieldsRequest,
      ok: { status: 200, schema: "FilledRequestFieldsView", description: "Filled" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/governance": {
    get: {
      id: "getGovernance",
      summary: "Org-pack conformance, rule layers, waivers and override rates",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/evals": {
    get: {
      id: "getEvals",
      summary: "AI quality: eval runs, pass rates and how people resolved critic findings",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/evals/run": {
    post: {
      id: "runEvals",
      summary: "Run evals in mock or replay mode (live stays in the terminal)",
      tag: "run",
      body: EvalRunRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/evals/defences": {
    get: {
      id: "getDefences",
      summary: "What the ingested-content defences found, and each change's quarantine",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/learning": {
    get: {
      id: "getLearning",
      summary: "Lessons by role, progress and the current step",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/learning/start": {
    post: {
      id: "startLesson",
      summary: "Start a lesson or a role's path",
      tag: "run",
      body: StartLessonRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/learning/check": {
    post: {
      id: "checkLesson",
      summary: "Check the current step; a miss is pass false with the hint",
      tag: "run",
      body: CheckLessonRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [400],
    },
  },
  "/api/learning/sandbox": {
    post: {
      id: "createSandbox",
      summary: "Create a throwaway practice metarepo",
      tag: "run",
      body: SandboxRequest,
      ok: { status: 201, schema: { type: "object" }, description: "OK" },
      errors: [400, 422],
    },
  },
  "/api/settings": {
    get: {
      id: "getSettings",
      summary: "Runtime settings, adapters, executors, org pack and gates (read-only)",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  // ADR 0121: the AI tab.
  "/api/settings/ai": {
    get: {
      id: "getAiSettings",
      summary:
        "How AI runs here: one line for what runs a step, on or off, the modes, the assistants by name, the providers and their settings, the configured model, and whether its key variable is set (by name)",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
    put: {
      id: "putAiSettings",
      summary:
        "Write the AI settings to runtime.yaml: checked against the Runtime schema, keeping what it doesn't change; refuses anything that looks like a key. 2.84.0: takes decide (ADR 0181: links, questions, minPrecision), lifting a version 3 file to 4. 3.0.0 (ADR 0186): keyEnv is a variable starting ATTICUS_, one of the model providers' own key names (the list is in the model-providers package) or a name kept in this machine's credential store (422 otherwise); a change of the provider, keyEnv or an address needs the person's confirmation (`ai-model`, `model`) as `confirmation`, else 403",
      tag: "run",
      body: z.record(z.string(), z.unknown()),
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [403, 409, 422],
    },
  },
  "/api/component-types": {
    get: {
      id: "listComponentTypes",
      summary:
        "The organisation's component types (ADR 0180): Atticus's built-ins with the org pack's own, reworded and switched-off ones applied; how the canvas draws each, its signals, what it must and must not do, its notes",
      tag: "catalog",
      ok: { status: 200, schema: "ComponentTypesView", description: "OK" },
    },
  },
  "/api/settings/ai/key": {
    post: {
      id: "putAiKey",
      summary:
        "Keep the model provider's key in this machine's credential store under keyEnv's name; never in a file, a log or an answer",
      tag: "run",
      body: z.object({ name: z.string(), value: z.string() }),
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [422],
    },
  },
  "/api/settings/ai/test": {
    post: {
      id: "testAiProvider",
      summary:
        "Ask the configured model provider one short question with nothing of the estate in it, and say whether it answered. 3.0.0 (ADR 0186): when runtime.yaml's model settings differ from the committed ones (HEAD), it needs the person's confirmation (`ai-test`, `model`), else 403. 3.1.0: also whenever they send the key to an address the person hasn't confirmed, committed or not; a confirmed Test makes it the confirmed address",
      tag: "run",
      body: ConfirmedRequest,
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [403, 409],
    },
  },
  "/api/settings/executors/check": {
    get: {
      id: "checkExecutors",
      summary: "Ping the executors set up here; nothing runs",
      tag: "run",
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
    },
  },
  "/api/release/{changeId}/plan": {
    get: {
      id: "getDeploymentPlan",
      summary:
        "The deployment plan: deploy order across repos with why, rollback, request waits, release sections and the forecast",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/forecast": {
    get: {
      id: "getReleaseForecast",
      summary:
        "Forecast ready-to-release day from lead times and the initiative's plan, with the target",
      tag: "release",
      params: [p("changeId")],
      ok: { status: 200, schema: { type: "object" }, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/evidence": {
    get: {
      id: "getEvidencePack",
      summary: "The evidence pack as one Markdown document, and every file with its sha-256",
      tag: "release",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: {
          type: "object",
          required: ["markdown", "files"],
          properties: {
            markdown: str,
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { path: str, sha256: str, bytes: { type: "integer" } },
              },
            },
          },
        },
        description: "OK",
      },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/notes": {
    get: {
      id: "getReleaseNotes",
      summary: "Release notes for business or technical readers, generated without AI",
      tag: "release",
      params: [p("changeId"), q("audience", { type: "string", enum: ["business", "technical"] })],
      ok: {
        status: 200,
        schema: { type: "object", properties: { markdown: str } },
        description: "OK",
      },
      errors: [400, 404, 422],
    },
  },
  "/api/release/{changeId}/security": {
    get: {
      id: "getSecurityReview",
      summary:
        "Security review draft: auth, classifications, data crossing boundaries, vendors, secrets, findings and sign-off",
      tag: "release",
      params: [p("changeId")],
      ok: {
        status: 200,
        schema: { type: "object", properties: { markdown: str } },
        description: "OK",
      },
      errors: [404, 422],
    },
  },
  "/api/release/{changeId}/outcomes": {
    post: {
      id: "recordOutcome",
      summary: "Record a measured outcome of a released change, as the signed-in person",
      tag: "release",
      params: [p("changeId")],
      body: RecordOutcomeRequest,
      ok: { status: 200, schema: { type: "object" }, description: "Recorded" },
      errors: [400, 404, 422],
    },
  },
  "/api/outcomes": {
    get: {
      id: "listOutcomes",
      summary: "The brief's success measures per change and the values recorded after release",
      tag: "release",
      params: [q("change")],
      ok: { status: 200, schema: {}, description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/questions": {
    get: {
      id: "listQuestions",
      summary:
        "The questions to people in questions/ (ADR 0078), in the order to ask them (ADR 0140): what a change in flight rests on first, then the answers that join the most calls",
      tag: "questions",
      params: [
        q(
          "state",
          { type: "string", enum: ["open", "answered", "retired"] },
          "Only questions in this state",
        ),
        q(
          "mine",
          { type: "string", enum: ["true"] },
          "Only the questions of the teams the person is on (roles.yaml, ADR 0140)",
        ),
        q(
          "change",
          { type: "string" },
          "Only a change's questions: filed under it, raised by its stages, or resting on it (ADR 0181)",
        ),
        q(
          "role",
          { type: "string", enum: ["product", "architecture", "analysis", "delivery"] },
          "Only the questions this role owns (ADR 0181 part 4)",
        ),
      ],
      ok: { status: 200, schema: "QuestionList", description: "OK" },
      errors: [400],
    },
  },
  "/api/questions/{id}": {
    get: {
      id: "getQuestion",
      summary: "One question: its options, evidence, proposed scope and answer",
      tag: "questions",
      params: [p("id")],
      ok: { status: 200, schema: "Question", description: "OK" },
      errors: [404, 422],
    },
  },
  "/api/questions/{id}/route": {
    post: {
      id: "routeQuestion",
      summary:
        "3.6.0 (ADR 0191): move a question to another role (product, architecture, analysis, delivery), as the signed-in person; the question keeps its answer, and `routed` says from which role, by whom and when",
      tag: "questions",
      params: [p("id")],
      body: RouteQuestionRequest,
      ok: { status: 200, schema: { type: "object" }, description: "The question, routed" },
      errors: [400, 404, 422],
    },
  },
  "/api/questions/{id}/answer": {
    post: {
      id: "answerQuestion",
      summary:
        "Write the signed-in person's answer to questions/<id>.yaml (and a repo type's skill file); returns the command to run next",
      tag: "questions",
      params: [p("id")],
      body: AnswerQuestionRequest,
      ok: { status: 200, schema: "AnsweredQuestion", description: "Answered" },
      errors: [400, 404, 422],
    },
  },
  "/api/orgpack": {
    get: {
      id: "getOrgPack",
      summary: "Org pack summary and every validation problem",
      tag: "orgpack",
      ok: { status: 200, schema: "OrgPackView", description: "OK" },
    },
  },
  // ADR 0102: knowledge managed in the metarepo (ADR 0101), in the app.
  "/api/knowledge/sources": {
    get: {
      id: "listKnowledgeSources",
      summary:
        "The wikis in sources.yaml with their tags, owner, git ref, path and checkout, and each one's newest snapshot",
      tag: "knowledge",
      ok: { status: 200, schema: "KnowledgeSourceList", description: "OK" },
    },
    post: {
      id: "addKnowledgeSource",
      summary:
        "atticus sources add: check a wiki and write its entry into sources.yaml (save), or return the entry to add",
      tag: "knowledge",
      body: AddSourceRequest,
      ok: { status: 200, schema: "CommandOutput", description: "Added, or the entry to add" },
      errors: [400, 422],
    },
  },
  "/api/knowledge/sources/{sourceId}/sync": {
    post: {
      id: "syncKnowledgeSource",
      summary:
        "atticus sources sync --source: read one wiki (a git wiki is cloned or fetched) into a dated snapshot",
      tag: "knowledge",
      params: [p("sourceId")],
      ok: { status: 200, schema: "CommandOutput", description: "Synced; code 1 has problems" },
      errors: [400, 404, 422],
    },
  },
  "/api/knowledge/scan": {
    get: {
      id: "getKnowledgeScan",
      summary:
        "What the last knowledge scan read and changed (scan.yaml), and the reviews to check again",
      tag: "knowledge",
      ok: { status: 200, schema: "KnowledgeScanView", description: "OK" },
    },
  },
  "/api/knowledge/documents": {
    get: {
      id: "listDocuments",
      summary:
        "The files in the metarepo's inputs/: what each is, the systems it names, whether the knowledge source read it (or why not), and the items that quote it (ADR 0122)",
      tag: "knowledge",
      ok: { status: 200, schema: "DocumentList", description: "OK" },
    },
    post: {
      id: "addDocument",
      summary:
        "Add a file to general knowledge (its bytes in base64): copied into inputs/inbox/ as it is; the same bytes already in inputs/ are refused (ADR 0122)",
      tag: "knowledge",
      body: AttachFileRequest,
      ok: { status: 201, schema: "AddDocumentResult", description: "Added, or refused with why" },
      errors: [400, 413, 422],
    },
  },
  "/api/knowledge/items": {
    get: {
      id: "listKnowledgeItems",
      summary:
        "The knowledge items as people reviewed them, rejected ones included and marked, with the fields each may have corrected",
      tag: "knowledge",
      params: [
        q("kind", { type: "string", enum: [...KNOWLEDGE_KINDS] }, "Only items of this kind"),
        q("tag", str, "Only items with this tag (a source kind, a framework or a page tag)"),
      ],
      ok: { status: 200, schema: "KnowledgeItemList", description: "OK" },
      errors: [400],
    },
  },
  "/api/knowledge/items/{itemId}/review": {
    post: {
      id: "reviewKnowledgeItem",
      summary:
        "Verify, correct or reject a knowledge item as the signed-in person: writes knowledge/reviews/<id>.yaml",
      tag: "knowledge",
      params: [p("itemId")],
      body: ReviewItemRequest,
      ok: { status: 200, schema: "ReviewedItem", description: "Reviewed" },
      errors: [400, 404, 422],
    },
  },
  "/api/knowledge/passage": {
    get: {
      id: "knowledgePassage",
      summary:
        "3.6.0 (ADR 0191): one section of a wiki snapshot page or an inputs/ file, by its id (<source>/<page>#<heading>), to open it in place",
      tag: "knowledge",
      params: [q("id", str, "The section's id, as a change's knowledge lists it")],
      ok: { status: 200, schema: "KnowledgePassageView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/knowledge/search": {
    get: {
      id: "searchWikis",
      summary:
        "The plain search of every snapshot page for a term or phrase (no AI), with the AI step to copy",
      tag: "knowledge",
      params: [q("q", str, "The term or phrase"), q("source", str, "Only this source's snapshot")],
      ok: { status: 200, schema: "WikiSearchResult", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/knowledge/finds": {
    get: {
      id: "listFinds",
      summary: "The saved searches of the wikis (knowledge/finds), newest first, with candidates",
      tag: "knowledge",
      ok: { status: 200, schema: "SavedFindList", description: "OK" },
    },
  },
  "/api/knowledge/finds/{slug}": {
    get: {
      id: "getFind",
      summary: "One saved search: the pages it matched and its candidates, new or already known",
      tag: "knowledge",
      params: [p("slug")],
      ok: { status: 200, schema: "SavedFindView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/knowledge/finds/{slug}/keep": {
    post: {
      id: "keepFound",
      summary:
        "Keep a candidate as a knowledge item of the kind chosen, verified (or corrected) by the signed-in person",
      tag: "knowledge",
      params: [p("slug")],
      body: KeepCandidateRequest,
      ok: { status: 200, schema: "KeptCandidate", description: "Kept" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/needs": {
    get: {
      id: "getChangeNeeds",
      summary:
        "What the change needs from the organisation (needs.yaml), each with its item's review, or the step to find them",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeNeedsView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/needs/{itemId}": {
    post: {
      id: "markChangeNeed",
      summary:
        "Mark a need done (with a note), not needed (with why) or open again, as the signed-in person",
      tag: "changes",
      params: [p("changeId"), p("itemId")],
      body: MarkNeedRequest,
      ok: { status: 200, schema: "MarkedNeed", description: "Marked" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/stages/{stage}": {
    get: {
      id: "getStageReview",
      summary:
        "A stage tab's critic findings (the latest round of its gate) with their options and comments, the stage's questions, and the command to run next (ADR 0087, ADR 0124)",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...STAGE_TABS] } })],
      ok: { status: 200, schema: "StageReviewView", description: "OK" },
      errors: [400, 404],
    },
  },
  "/api/changes/{changeId}/placement": {
    get: {
      id: "getPlacement",
      summary:
        "2.77.0 (eighth UX walk): the feature stage's placement, feature.md as the page shows it and feature.yaml as a person edits it, with who drafted it last",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "PlacementView", description: "OK" },
      errors: [400, 404],
    },
    put: {
      id: "savePlacement",
      summary:
        "2.77.0 (eighth UX walk): save feature.yaml as a person edited it (it must still read as a placement) and draw feature.md from it again; the stage's next run reads it",
      tag: "changes",
      params: [p("changeId")],
      body: SavePlacementRequest,
      ok: { status: 200, schema: "PlacementView", description: "Saved" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/drafts/{page}": {
    get: {
      id: "getStageDrafts",
      summary:
        "2.80.0 (ADR 0181): a page's stage drafts, each with who wrote it last (the AI with its stage and run, or a person's save) and the items a person can correct, with the corrections of them and the stage to run again",
      tag: "changes",
      params: [p("changeId"), p("page", { schema: { type: "string", enum: [...DRAFT_PAGES] } })],
      ok: { status: 200, schema: "StageDraftsView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/corrections": {
    get: {
      id: "listCorrections",
      summary:
        "2.80.0 (ADR 0181): a person's corrections of the change's AI-drafted items (stage/corrections.yaml), waiting, read or applied",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "CorrectionList", description: "OK" },
      errors: [400, 404, 422],
    },
    post: {
      id: "addCorrection",
      summary:
        "2.80.0 (ADR 0181): correct an AI-drafted item (or a whole draft) as the signed-in person, optionally for every similar item; the stage's next run reads it as the person's word. Returns the git command and the stage's command",
      tag: "changes",
      params: [p("changeId")],
      body: AddCorrectionRequest,
      ok: { status: 200, schema: "CorrectionResult", description: "Written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/corrections/{correctionId}/remove": {
    post: {
      id: "removeCorrection",
      summary:
        "2.80.0 (ADR 0181): take back a correction no run has read yet (one a run read stays on file; a later correction wins)",
      tag: "changes",
      params: [p("changeId"), p("correctionId")],
      ok: { status: 200, schema: "CorrectionList", description: "Removed" },
      errors: [400, 404, 409],
    },
  },
  "/api/changes/{changeId}/stages/{stage}/comments": {
    post: {
      id: "commentOnFinding",
      summary:
        "A person's comment on a finding: written as a question they answered (questions/), listed in the stage's loop file, so the stage's next run hands it to the drafter. Returns the git command and the stage's command",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...STAGE_TABS] } })],
      body: StageCommentRequest,
      ok: { status: 200, schema: "StageCommentResult", description: "Written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/stages/{stage}/thread": {
    get: {
      id: "getStageThread",
      summary:
        "3.5.0 (ADR 0189): a stage of the change as one conversation: the prompts, the assistant's answers and their checks, the critic's findings, the questions, the replies and corrections, and the questions that couldn't be kept, in order",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...THREAD_STAGES] } })],
      ok: { status: 200, schema: "StageThreadView", description: "OK" },
      errors: [400, 404],
    },
    post: {
      id: "postToStageThread",
      summary:
        "3.5.0 (ADR 0189): a person's reply to the stage's assistant (read by its next round as their answer), a comment on a finding, or keeping a dropped question anyway",
      tag: "changes",
      params: [p("changeId"), p("stage", { schema: { type: "string", enum: [...THREAD_STAGES] } })],
      body: StageThreadPost,
      ok: { status: 200, schema: "StageThreadPostResult", description: "Written" },
      errors: [400, 404, 409, 422],
    },
  },
  "/api/changes/{changeId}/knowledge": {
    get: {
      id: "getChangeKnowledge",
      summary:
        "The org knowledge that applies to the change (knowledge.yaml): each item with why its stages picked it and a person's status, and the near-misses (ADR 0124)",
      tag: "changes",
      params: [p("changeId")],
      ok: { status: 200, schema: "ChangeKnowledgeView", description: "OK" },
      errors: [400, 404, 422],
    },
  },
  "/api/changes/{changeId}/knowledge/{itemId}": {
    post: {
      id: "setChangeKnowledge",
      summary:
        "Confirm or exclude an item (or a near-miss) in the change's knowledge.yaml; an excluded item stays out of every later stage. Returns the git command that commits the file",
      tag: "changes",
      params: [p("changeId"), p("itemId")],
      body: SetChangeKnowledgeRequest,
      ok: { status: 200, schema: "SetChangeKnowledgeResult", description: "Set" },
      errors: [400, 404, 422],
    },
  },
  "/api/orgpack/draft": {
    get: {
      id: "getOrgPackDraft",
      summary:
        "The org pack drafted from the wikis: each platform's proposed systems (proposals/orgpack), verified or not",
      tag: "orgpack",
      ok: { status: 200, schema: "OrgPackDraftView", description: "OK" },
    },
    post: {
      id: "draftOrgPack",
      summary: "atticus orgpack draft: draft a platform profile's systems from the knowledge items",
      tag: "orgpack",
      body: DraftOrgPackRequest,
      ok: { status: 200, schema: "OrgPackDraftView", description: "Drafted" },
      errors: [400, 422],
    },
  },
  "/api/orgpack/draft/{platform}/accept": {
    post: {
      id: "acceptOrgPackDraft",
      summary:
        "atticus orgpack accept --only: put the picked systems into profile.yaml; what is taken leaves the draft",
      tag: "orgpack",
      params: [p("platform")],
      body: AcceptOrgPackRequest,
      ok: { status: 200, schema: "AcceptedOrgPack", description: "Accepted" },
      errors: [400, 404, 422],
    },
  },
};

const ERROR_TEXT: Record<number, string> = {
  400: "The request is invalid",
  401: "Missing or wrong session token",
  403: "You can't do this; the problem says who can",
  404: "Not found",
  409: "Conflict: the file changed since you read it, or the state doesn't allow this",
  413: "Too large: the upload is over the limit the problem names",
  422: "Atticus refused: the problem carries the command's own words (ADR 0043)",
  500: "Written only in part: the problem names exactly what was written",
};

/** Build the OpenAPI 3.1 document from the zod schemas. */
export function openApiDocument(): Record<string, unknown> {
  const reg = z.registry<{ id: string }>();
  const components: Record<string, z.ZodType> = {
    Problem,
    CatalogRecord,
    RecordPage,
    KindCount,
    Graph,
    HierNode,
    HierEdge,
    HierJoin,
    GraphNodeView,
    GraphFocusView,
    GraphEdgeCallsView,
    ViewLayoutResult,
    Impact,
    Coverage,
    Job,
    JobAccepted,
    ReadyTasks,
    RunReadyAccepted,
    RunReadyResult,
    ChangeSummary,
    ChangeTypeView,
    ProposePlanView,
    OwnerQuestionView,
    OwnerQuestionList,
    OwnerSuggestionList,
    WaitsOn,
    FindingView,
    WorkItemPlan,
    WorkItemSyncResult,
    SentOwnerAsk,
    KnowledgePassageView,
    KnowledgeAnswerView,
    StoryShapeView,
    OwnerAnswerRequest,
    OwnerAnswerResult,
    PreparedStepView,
    RunDoneView,
    ProposeRequest,
    ConfirmationView,
    LinesView,
    InitiativeSavedView,
    ChangeDetail,
    ArtifactContent,
    Task,
    RunView,
    RunList,
    RunTranscript,
    HistoryList,
    HistoryEntry,
    RepoView,
    OnboardingView,
    SpecList,
    SpecView,
    FlowView,
    CiteList,
    TargetFlowList,
    TargetFlowView,
    ChangeMap,
    ChangeEstimate,
    ChangeImpact,
    ChangeInput,
    ChangeInputList,
    AttachResult,
    ChangePrototypeList,
    ComparePrototypeView,
    FilledRequestFieldsView,
    DocumentList,
    AddDocumentResult,
    RepoBranchesList,
    BranchCompare,
    ChangeCockpit,
    SimilarChanges,
    AttachPastChangeResult,
    QuestionEvidenceList,
    TargetPickList,
    PromoteResult,
    ChangeConformance,
    OrgPackView,
    Health,
    Finding,
    ChangeRepos,
    LiveEvent,
    CopilotRunView,
    CopilotRunCurrent,
    ActivityList,
    ActivityLines,
    LinkCandidatesView,
    ConnectLinksResult,
    MatchLinksRequest,
    MatchProposal,
    MatchLinksView,
    DecisionsView,
    CorrectDecisionResult,
    UndoBatchResult,
    QuestionsProposeView,
    UpgradeView,
    TaskContextView,
    HistoryRecordingView,
    FileEditView,
    SetupMetarepoView,
    OpenFolderView,
    ReposPlanView,
    RepoTypeDetectView,
    AdaptersView,
    OrgPackFileView,
    RepoOwnerView,
    SetRepoOwnerResult,
    FileChangeResult,
    SketchStrokeRequest,
    SketchResult,
    AddableView,
    ComponentTypeView,
    ComponentTypesView,
    BoxCorrections,
    SavedCanvasView,
    SavedCanvasViews,
    CodeLink,
    RuleFromPairingResult,
    Question,
    QuestionList,
    AnsweredQuestion,
    KnowledgeSourceList,
    CommandOutput,
    KnowledgeScanView,
    KnowledgeItemList,
    ReviewedItem,
    WikiSearchResult,
    SavedFindList,
    SavedFindView,
    KeptCandidate,
    ChangeNeedsView,
    MarkedNeed,
    TrustView,
    AnswerBoxResult,
    FreshView,
    ChangeKnowledgeView,
    KnowledgeConflictView,
    SetChangeKnowledgeResult,
    RepoFactsView,
    FactCorrectionResult,
    LinkCorrectionsResult,
    VerifyPreviewView,
    AuditSampleView,
    AuditAnswerResult,
    OutsideView,
    ContractsView,
    StageReviewView,
    StageCommentResult,
    StageThreadView,
    StageThreadPostResult,
    PlacementView,
    StageDraftsView,
    CorrectionResult,
    CorrectionList,
    OrgPackDraftView,
    AcceptedOrgPack,
  };
  for (const k of RECORD_KINDS) reg.add(RECORD_SCHEMAS[k], { id: k });
  for (const [id, s] of Object.entries(components)) reg.add(s, { id });
  const generated = z.toJSONSchema(reg, {
    uri: (id) => `#/components/schemas/${id}`,
    io: "output",
    unrepresentable: "any",
  }) as { schemas: Record<string, Record<string, unknown>> };
  const schemas: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(generated.schemas)) {
    const { $schema: _s, $id: _i, ...rest } = s;
    schemas[id] = rest;
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(OPS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(ops)) {
      const content = (schema: string | object) => ({
        "application/json": { schema: typeof schema === "string" ? ref(schema) : schema },
      });
      const responses: Record<string, unknown> = {
        [op.ok.status]: op.ok.schema
          ? { description: op.ok.description, content: content(op.ok.schema) }
          : { description: op.ok.description },
        ...(op.alsoOk
          ? {
              [op.alsoOk.status]: op.alsoOk.schema
                ? { description: op.alsoOk.description, content: content(op.alsoOk.schema) }
                : { description: op.alsoOk.description },
            }
          : {}),
        401: {
          description: ERROR_TEXT[401],
          content: { "application/problem+json": { schema: ref("Problem") } },
        },
      };
      for (const e of op.errors ?? [])
        responses[e] = {
          description: ERROR_TEXT[e],
          content: { "application/problem+json": { schema: ref("Problem") } },
        };
      paths[path]![method] = {
        operationId: op.id,
        summary: op.summary,
        tags: [op.tag],
        ...(op.params
          ? {
              parameters: op.params.map((x) => ({
                ...x,
                required: x.in === "path" ? true : (x.required ?? false),
              })),
            }
          : {}),
        ...(op.body
          ? {
              requestBody: {
                required: !op.bodyOptional,
                content: {
                  "application/json": {
                    schema: stripMeta(
                      z.toJSONSchema(op.body, { io: "input", unrepresentable: "any" }),
                    ),
                  },
                },
              },
            }
          : {}),
        responses,
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Atticus local API",
      version: API_VERSION,
      description:
        "Served by `atticus ui` on 127.0.0.1. The UI only calls this API, and the API only reads and writes files in the metarepo.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: `http://127.0.0.1:${DEFAULT_PORT}` }],
    security: [{ sessionToken: [] }],
    tags: [
      "system",
      "catalog",
      "views",
      "workspace",
      "scans",
      "changes",
      "ai",
      "findings",
      "orgpack",
      "questions",
      "knowledge",
    ].map((name) => ({ name })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "X-Atticus-Token",
          description: "Printed by `atticus ui` at start-up; new every session.",
        },
      },
    },
    "x-websocket": {
      path: "/api/events",
      description: "Live updates. Pass the session token as ?token= on the upgrade request.",
      messages: ref("LiveEvent"),
    },
  };
}

function stripMeta(s: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = s;
  return rest;
}
