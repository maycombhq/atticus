# 0209. Many people on one change: what is decided now, before any of it is built

- Status: accepted (2026-11-22, by the owner, as part of "complete v31": multiplayer gets an ADR
  and no code in beta.31, [the v31 plan](../plan/v31.md#deferred))
- Date: 2026-11-22
- Release: 2.0.0-beta.31 records the decisions; nothing in this ADR is built in beta.31
- Extends: ADR 0015 (the local server), ADR 0078 (a person's answer), ADR 0189 (a stage is one
  conversation), ADR 0191 (a question goes to a role)
- Contracts: none changed in beta.31. Each decision below names the contract its build will change
  (C1 or C4) and says the change is additive.

## Context

The owner's future vision: Atticus as a workspace where several people and several agents work on
the same change together, the product owner, architects, analysts and tech leads each in their
own thread, and persona agents that speak without being asked. Today Atticus is one person on one
machine, and the only shared medium is git.

Rewriting storage, identity and events later, after more of the product is built on the
single-person shape, costs far more than deciding them now. Building them now, while the owner is
also weighing an AI-first product, may build code that is thrown away. So this ADR decides the
shapes that are cheap to decide and expensive to change, and builds none of them.

## How it is today

Read in the code on `main` at `134bc15`. No code was run.

- **The server.** It binds 127.0.0.1 only and refuses any other host with an error
  (`packages/server/src/server.ts:299-301`); every call carries one session token.
- **Who did it.** A person's answer, a re-route and similar records carry `by` as a free string
  (`packages/core/src/schema/question.ts:83`, `:211`, `:228`); an AI answer is a separate shape
  (`AiBy`, `:118`). There is no stable id for a person, and none for an agent that is not a run.
- **Locks.** A lock is a file under `.atticus/locks/`, on this machine only and git-ignored
  (`packages/core/src/fs.ts:451-453`), alive while its pid is (`process.kill(pid, 0)`, `:457`).
- **Threads.** A stage's thread is assembled from the files that already hold its prompt, answers,
  checks, critic and questions (`packages/planner/src/stages/thread.ts:25-37`); a reply is stored
  as an answered question. There is no thread record to subscribe to.
- **Live events.** `type LiveEvent = { type: string } & Record<string, unknown>`
  (`packages/server/src/server.ts:50`): an event has no schema, id, actor or time.
- **Decisions on file.** AI decision batches live under `decisions/`
  (`packages/core/src/decision-batches.ts`); a person's decisions are spread over answers,
  corrections, pairings, waivers and hand-off approvals, each in its own file kind, all in git.
- **Concurrent edits.** One file per record in canonical YAML merges well in git, and conflicts
  between open changes are found per repo (gate 0, [the log](../plan/v31-gate0-log.md), step 17).

## Decision

### 1. Git stays the store of record

Every record, answer, correction, rule and approval stays a file in the metarepo, in git. A team
server (decision 5) holds a clone and commits for the people using it; it adds no database of
record. Anything live (presence, typing, a job's progress) is held in memory or in git-ignored
files and is never the only copy of a decision.

### 2. One actor for people and agents

Every record that says who did something says it as an actor: `{ kind: "person" | "agent", id,
name, role? }`. A person's `id` is stable across machines (the git author email by default, an
SSO subject on a team server); an agent's `id` names the persona and its run. The existing `by`
strings stay readable as a person with that name and no id. Building this changes C1 additively:
a new optional field beside each `by`, read by old readers as unknown and dropped.

### 3. Events have a schema

A live event is `{ id, type, actor, subject, at, data }`, with `type` from a closed list per
release and `subject` the record or change it is about, as a zod union in the local API. Building
this changes C4 additively: today's events become members of the union, unchanged on the wire.

### 4. One append-only decision log

Every decision by a person or an agent (an answer, a correction, a rule made active, a waiver, an
approval, a re-route) is also appended as one line to a decision log in the metarepo, with its
actor, subject, time and the record it changed. The log is derived: if it is lost, it is rebuilt
from the records and git history. It is the audit trail and what notifications read.

### 5. A team server is the local server with people

Inside an organisation's network, a team server is the same server process, serving one product's
metarepo clone, with three changes and nothing else: an authentication interface (SSO by the
organisation's choice) that turns a session into an actor; per-actor rights read from
`roles.yaml` (who may confirm an arrow, make a rule active, approve a hand-off); and locks held as
leases with an owner and an expiry instead of a pid. Loopback stays the default and, in beta.31,
the only mode that ships (ADR 0015 is unchanged until the build).

### 6. Models are reached only through the AI runtime

On a team server, as on a laptop, every model call goes through the AI runtime's configured
provider (C5). An air-gapped or self-hosted model is a provider, not a mode. No data leaves the
organisation's network except to the provider it configured.

### 7. No CRDT

Two people typing in the same text at the same moment is the only case a CRDT would serve, and in
Atticus that is a thread's reply box and the sketch canvas. Both are handled by short operations
on the server that end in an ordinary file write. Whether a CRDT is ever needed is decided on use.

## What waits

Presence and cursors; standing persona agents that speak unasked (they need decision 5 and a
scheduler); impact notifications (they read decision 4); federation across teams' metarepos beyond
today's read-only shared maps; tenancy and a hosted option. None is planned for beta.31 or beta.32.

## Contracts and version bumps

None in beta.31. When built: decision 2 is an additive C1 change (an optional actor beside each
`by`), decision 3 an additive C4 change (the event union), decision 4 a new file kind with its own
version. Each gets its own ADR then, and this one is the decision they implement.

## Tests that prove it

None in beta.31: nothing is built. When decision 2 is built, the first test reads a beta.30
metarepo and finds every `by` as a person actor with no id.

## What it does NOT do

It builds nothing. It doesn't change who can approve today, what the server listens on, or any
file's shape.

## Risks

Deciding too early: if the AI-first product replaces this codebase, these decisions still carry
over, because they are about records, actors and events, not this code. Deciding too late is the
larger risk, and the reason for this ADR.

## Questions for the owner

None open. The owner may revisit decision 7 (no CRDT) when the canvas is used by more than one
person at a time.
