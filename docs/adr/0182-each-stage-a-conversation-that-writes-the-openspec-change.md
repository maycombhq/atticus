# 0182. Each stage is a conversation that writes the OpenSpec change

- Status: proposed (for 2.0.0-beta.22; pending review by the product owner)
- Date: 2026-11-08
- Builds on: ADR 0030 (one framework over OpenSpec), ADR 0087 (target flows), ADR 0132 (where a new component runs), ADR 0173 (Copilot runs from the app), ADR 0176 (ingested content fenced as data), ADR 0179 (drawing a change on the canvas), ADR 0181 (AI decides first; a change ends at the tech lead)
- Contracts: to be settled in the implementation PRs, each with its version bump. Expected: C4 gains the conversation routes (start, say, draft, write) and a `retire` stroke (minor bumps). A change gains `conversation/<stage>.jsonl`, the record of each stage's conversation (additive). C1 is unchanged. Today's map is never changed by a conversation (rule 6).

## Context

The product owner's direction (2026-11-08): once the architecture and repos are mapped, each stage of a change should be a conversation. The role starts it, the agent asks what it needs to know and answers the role's questions from the estate, and it records the answers. Together they form the full picture, written as the stage's OpenSpec documents. The roles are product owner, architect, business analyst and tech lead. The map can be refreshed from the app when repos have moved on. The architect can have every spec written at once, and can draw future components (added, modified, retired) on the canvas before any repo exists for them.

Today each stage is a set of screens: the brief form, AI drafts (`plan stories`, the feature stage), critic findings and questions. Each is useful on its own, but the person has to know which screen comes next. Nothing joins them into one place where the picture forms.

## Decision

### 1. One conversation per stage, beside the live OpenSpec change

Each stage of a change has a **Conversation** panel. The chat is on one side, and on the other is the stage's OpenSpec document as it stands, updating as the conversation goes:

| Stage          | Who              | What the conversation writes (OpenSpec)                                                           |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| Define         | product owner    | `proposal.md`: why, what changes, who it is for, how we know it worked                            |
| Design         | architect        | `design.md`, the target flows, and every affected capability's `specs/<capability>/spec.md` delta |
| Plan (stories) | business analyst | the stories and their acceptance criteria as scenarios in the spec deltas                         |
| Plan (tasks)   | tech lead        | `tasks.md` by repo, in cross-repo order, each task linked to its scenarios                        |

- **The agent asks, grounded in the map.** Its questions come from the change's open questions and the critic's rules for that stage (each finding becomes a question, not a red list). They also come from what the map says the change touches. For example: "This changes forge-ledger's limits API; forge-gateway and forge-payments call it. Do both need the new field?" Each question cites the facts it rests on.
- **The agent answers from the estate.** The role can ask "who calls ledger-api?" or "what does forge-payments do on a timeout?" and gets an answer from the catalog with its citations (the `ask` path, ADR 0124), never from memory.
- **Every answer is recorded with where it came from.** What the person typed is theirs, recorded as theirs. What the agent drafted is the agent's, marked "Drafted by AI" until the person accepts it into the document. Every line of the OpenSpec document keeps which turn produced it. The record is `conversation/<stage>.jsonl` in the change, reviewed in the hand-off pull request with everything else.
- **The person owns the document.** They can edit it directly at any time. The conversation reads the edit and carries on from it. The stage ends as today: the hand-off pull request that the next role's approval moves on.
- **Safety.** Ingested content in the agent's brief is fenced as data (ADR 0176). The session writes nothing itself. Atticus writes the document from the conversation, and only the person's "Accept into the spec" turns a draft line into the document. The person-only list (ADR 0171 addendum) still holds: the agent never answers, accepts or approves as the person. A document never overrides a fact verified from code. Where the person's answer contradicts the map, the agent says so and cites the code.

### 2. The map is kept fresh from the app

When the conversation needs a repo whose clone has moved past its facts, the panel says so ("forge-ledger moved 14 commits since it was read") and offers **Re-read now**. That is the existing Map › Trust re-read (the read route of ADR 0173) for just those repos. The conversation waits on it and carries on with the new facts. No terminal is needed.

### 3. The architect writes all specs at once

In Design, **Write all specs** drafts every affected capability's spec delta in one run, from the design and target flows: added, modified and removed requirements, each with scenarios. Each draft is checked against the template and the code (`spec check`), and each comes back as "Drafted by AI" for the architect to accept in one go or one by one.

### 4. Future components on the canvas: add, modify, retire

ADR 0179 already lets the architect draw a **new component** (a new box, as a new flow with where it runs, ADR 0132) and **modify** today's (calls, topics, tables, removing or re-targeting a step), before any repo exists for it. This ADR adds **retire**: a `retire` stroke marks a component, an API or a topic as going away. It writes the removal into the target flows and the spec deltas ("REMOVED Requirements"). It lists every caller the map knows of, each as a question for the change ("forge-payments still calls it: move it to what?"). Like every stroke, it is a plan, never a change to today's map.

When the new component's repo is created later, the first read joins it to the box drawn for it, and the drawn flows are checked against the code (`change conform`).

## Consequences

- A role opens a stage and talks it through. The panel asks the next question, and the person never needs to know the screen order. The stage's OpenSpec document is the outcome, with every line traceable to a turn and every claim about the estate to its code.
- The critic's findings become questions in the flow of work rather than a list to clear afterwards.
- A conversation costs model runs. Each turn goes through the AI runtime, on the person's own Copilot seat under copilot-acp or the organisation's configured provider. With AI off, the stage is today's screens.
- Work items, in `docs/build-status.md` under beta.22: the Conversation panel per stage, the conversation record, grounded questions from findings and the map, Accept into the spec, Re-read now, Write all specs, and the retire stroke.
