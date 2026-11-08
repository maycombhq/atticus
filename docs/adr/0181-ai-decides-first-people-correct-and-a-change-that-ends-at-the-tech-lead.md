# 0181. AI decides first, people correct, and a correction spreads; a change ends at the tech lead

- Status: proposed (for 2.0.0-beta.22; pending review by the product owner)
- Date: 2026-11-08
- Builds on: ADR 0074 and 0124 (the assistant reads, every fact cites its code), ADR 0144 (proposed answers), ADR 0148 (the sample audit), ADR 0153 (answers by rule, in one sitting), ADR 0171 and its round-32 addendum (Copilot unattended; a session acts as no one), ADR 0173 (Copilot runs from the app), ADR 0176 (reading rules), ADR 0178 (matching calls to APIs at scale), ADR 0036 (task runs)
- Contracts: to be settled in the implementation PRs, each with its schema version bump and migration. Expected: C1 gains the link flag `joined-by-ai` beside `joined-by-person` (additive). The question file's answer gains `by: { kind: ai, runtime, run }` beside a person's `by` (additive; old files read unchanged). C4 gains the AI-decided lists, Undo and the "Run all ready tasks" route (minor bumps). C6 `runtime.yaml` gains `decide` (below). C3 is unchanged.

## Context

On a 40-repo estate a read leaves hundreds of loose calls to pair and hundreds of questions to answer. Today the AI proposes and a person accepts each item. Copilot proposes answers (`questions propose`, ADR 0144) and pairings (Match with Copilot, ADR 0178). "Answer once for many" (`--match`, ADR 0153) helps, but the person has to write the rule. The result is that a developer or architect meets 200 ticks. That is the cost that decides whether teams keep using Atticus.

The product owner's direction (2026-11-08): the AI should decide what it can, shown as decided by AI. A person corrects what is wrong, and the AI applies that correction to everything like it, so people take as few steps as possible. Separately, a change should flow product owner → architect → business analyst → tech lead. Each role answers its own questions at its level of detail, and the work ends with the tech lead or architect running each task on its repos with a button.

The safety rules hold throughout (CLAUDE.md rule 6). A human approves every write to shared systems. Every fact keeps its provenance. A document never overrides a fact verified from code. Ingested content is data. Since round 32, a session can never act as the person.

## Decision

### 1. AI decides, as itself

An AI decision is a third kind of answer, beside a fact verified from code and a person's word. It is never written as the person's answer.

- **What may be decided.** A loose call's pairing to an API (ADR 0178), and an open question whose options are things on file: a target, a host or a topic. Not a free-text question, a scope wider than the repo, an org-pack change, a gate, or anything in the person-only list (`personOnlyWhy`).
- **When it is applied.** A decision is applied automatically only when the AI's citation check passes: every line it names exists and says what it claims. It must also meet one of two bars. Either it is confident (ADR 0178's 0.85 score and 0.2 lead, or an AI answer that agrees with the shapes), or it agrees with a person's rule (part 2). Anything else stays a proposal for a person, as today.
- **How it is recorded.** A pairing is a `link` line flagged `joined-by-ai`, with the run that made it. An answer has `by: { kind: ai, runtime: copilot-acp, run: <id> }`. Atticus writes both, not the session (the session writes nothing, ADR 0178 part 2). So the round-32 rule stands: AI decides as AI, through Atticus, never as you.
- **How it is shown.** Everywhere a decision is shown it carries a "Detected by AI" chip. That covers the canvas, Connect, Questions, Contracts, Impact, a change's knowledge and the brief's context. Plans and checks can tell an AI decision from a person's. Counts split the three kinds: from code, by a person, by AI.
- **Configuration.** `runtime.yaml` `decide: { links: auto | propose, questions: auto | propose }`, default `propose` until the organisation turns it on in a pull request. Turning it on is the organisation's choice. The safety rules are not configurable and are not affected.

### 2. A person corrects one, and the correction spreads

- **Correct one.** On any "Detected by AI" item, the person picks the right answer (or "none"). A person's word overrides an AI decision, always, and is recorded as theirs.
- **Spread it.** The correction offers "Apply to similar", on by default. Atticus derives a rule from the correction: the host pattern, path prefix or topic pattern that the corrected item and its siblings share (ADR 0153's `--match`, written for the person, shown before saving). It then re-checks every AI decision and open item that matches. Each one now agrees with a person's rule, so it is applied as the person's rule (recorded as by rule, from that person's correction). Each AI decision that the rule contradicts is reverted to open, or re-decided by the AI with the rule in its brief.
- **Make it last.** A shape that keeps being corrected becomes a reading rule proposal (ADR 0176, "Make this a rule"), so the next read gets it right at the source.
- **Undo.** Every applied batch, by AI or by rule, is one Undo away, and Undo removes exactly its lines.

### 3. What a person still sees

The person's list is what is left. That means items below the bar, contradictions, free-text questions, and a small random sample of AI decisions to audit (ADR 0148's sample audit, extended to the AI kind). The audit's precision for AI decisions is shown on Map › Trust. If it drops below the organisation's bar (`runtime.yaml` `decide.minPrecision`, default 0.95), automatic deciding pauses back to `propose` and Home says why.

### 4. A change ends at the tech lead or architect

- **Roles in order.** The product owner writes the brief (Define). The architect places it on the estate and decides the design (Design). The business analyst writes stories (Plan). The tech lead breaks them into tasks by repo (Plan, Build). Each phase still ends with a hand-off pull request a person approves (unchanged).
- **Each role answers its own questions.** Every question a phase raises carries the role that owns it (product, architecture, analysis, delivery), and Home and Questions show each person only their role's questions for the change, at their level of detail.
- **Run all ready tasks.** The change's Task board gets **Run all ready tasks**, beside each task's _Run with AI_. It runs every task whose dependencies are done, on its repos, in the cross-repo order, one task run per task (ADR 0036, with its lock, dry run and preview). Each run ends as a pull request on its own `task/<change-id>/<task-id>` branch. Nothing is merged or pushed to a protected branch. A person reviews and approves each pull request on the Git host. Copy speaks of "the tech lead or architect runs the tasks", not the developer.

## Consequences

- On a mapped estate most pairings and option questions are decided without a person, shown as AI's. A person's minutes go to the few that need judgement, and one correction fixes a family of mistakes.
- An AI decision can be wrong and stand for a while. It is labelled wherever it shows, audited by sample, paused if precision drops, and undone in one click. Plans never treat it as a person's word.
- The person-only list (ADR 0171 addendum) is unchanged: AI decides through Atticus as AI, and never answers, accepts or audits as a person.
- Teams that don't want it keep `propose` and today's flow.
- Work items: in `docs/build-status.md` under beta.22. They are: AI decisions and their provenance (C1 flag, question `by`), the decide setting, "Detected by AI" across screens, correct-and-spread with derived rules, the AI kind in the sample audit and the precision pause, role-owned questions, and Run all ready tasks.

## Addendum (2026-11-08): stage drafts are AI's, and a correction is carried and spread

Accepted for 2.0.0-beta.21 by the product owner. Part 1's "shown as decided by AI" and part 2's "correct one, spread it" also hold for a change's stage drafts: the proposal, the design, the target flows, the stories and specs, and tasks.md. The eighth UX walk found that these carried no AI label, and that the only way to correct one was a comment on a critic finding and a rerun, so a draft with no finding couldn't be corrected at all.

- **Who wrote it.** The stage loop records each file a draft wrote, with the stage, the run, the draft's number and the file's sha-256, in one per-change file, `stage/drafted.yaml` (Atticus writes it). A person's save in the app (the artifact and placement routes) records who and when. A file whose text no longer has its recorded hash was edited outside the app, which makes it a person's edit with no name. Pages show "Drafted by AI" (with the run, linked) or "Edited by <who> on <date>". A change drafted before this falls back to the loop files' `written` hashes.
- **Correct one.** Any draft, or any item in it (a target flow's step, a Markdown section, a task), takes a correction in the person's words, kept per change in `stage/corrections.yaml` with the stage that reads it, the item, who and when. The stage must have run, otherwise nothing would read the correction. A correction waiting for a run can be taken back. One a run has read stays on file, and a later correction wins.
- **Carried as the person's word.** The stage's brief lists every correction of its drafts in the hand-backs data block, beside the answered questions. They are data, screened by the defences, never instructions (rule 6). One trusted Atticus line says to follow each correction, says a later one wins, and says a correction never overrides a fact verified from code: keep the code's fact and ask a question naming the correction (rule 4). A correction waiting makes a done stage draft again, starting from its current drafts (and from a person's edited files, as answers do).
- **Spread it.** "Apply to similar" is on by default. It records `scope: similar` and what the similar items share (prefilled with the step's component, entry or table; the person can change it). The brief asks the run to make the same correction to every item naming it. These are model-applied drafts, not part 2's derived rules for links and questions, so the draft goes through the stage's checks and the critic as any draft does.
- **Applied, and what it touched.** After a draft that had the corrections, each correction whose item the draft changed is marked `applied` with its run. One whose item didn't change is marked `read` and says so on the page. A similar-scope correction lists the other items the draft changed that name what it is like (`touched`). All stay on file.
- **Replays.** A stage with no corrections builds exactly the prompt it built before (tested by its hash), so recorded replays keyed by the prompt's hash still match.
- **Contracts.** C4 local API 2.79.0, additive: `GET /api/changes/{changeId}/drafts/{page}`, `GET`/`POST /api/changes/{changeId}/corrections`, `POST .../corrections/{correctionId}/remove`. Both files are new and per change, at their own version 1. They live under the change's `stage/` folder (Atticus's state, like the loop files) and travel with the hand-off. No C1 to C3, C5 or C6 file changes, so no migration.
