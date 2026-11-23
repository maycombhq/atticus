# 0209. Many people on one change: what is decided now, before any of it is built

- Status: accepted (2026-11-22, by the owner, as part of "complete v31": multiplayer gets an ADR
  and no code in beta.31, [the v31 plan](../plan/v31.md#deferred))
- Date: 2026-11-22
- Release: 2.0.0-beta.31 records the decisions; nothing in this ADR is built in beta.31
- Extends: ADR 0015 (the local server), ADR 0073 (the person is the Git user; approving is the
  pull request), ADR 0078 (a person's answer), ADR 0186 (a write to a shared system needs a
  person's confirmation), ADR 0189 (a stage is one conversation), ADR 0191 (a question goes to a
  role)
- Contracts: none changed in beta.31. Each decision names the contract its build will change, and
  each of those builds gets its own ADR: decision 2 changes C6 (the question file) and C1 where a
  record names who did it, with a version bump and migration; decision 3 changes C4; decision 4
  adds a file kind; decision 5 changes C4 and amends ADR 0015.

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
- **Who did it.** A re-route and a person's answer carry `by` as a free string
  (`packages/core/src/schema/question.ts:83`, `:211`); an answer may instead be an AI's, a
  separate shape (`AiBy`, `:108`); a proposal's `by` names the assistant that proposed it
  (`:223-228`). The person is the Git user (ADR 0073). There is no stable id for a person, and
  none for an agent beyond its run. These schemas are strict (`z.strictObject`, e.g. `:81`,
  `:205`): an unknown field is refused, not dropped.
- **Locks.** A lock is a file under `.atticus/locks/`, on this machine only and git-ignored
  (`packages/core/src/fs.ts:451-453`), alive while its pid is (`process.kill(pid, 0)`, `:457`).
- **Threads.** A stage's thread is assembled from the files that already hold its prompt, answers,
  checks, critic and questions (`packages/planner/src/stages/thread.ts:25-37`); a reply is stored
  as an answered question. There is no thread record to subscribe to.
- **Live events.** `type LiveEvent = { type: string } & Record<string, unknown>`
  (`packages/server/src/server.ts:50`): an event has no schema, id, actor or time.
- **Decisions on file.** AI decision batches live under the metarepo's `decisions/` (or
  `.atticus/decisions/` for a repo adopted in place; `packages/core/src/decision-batches.ts:11`); a person's decisions are spread over answers,
  corrections, pairings, waivers and hand-off approvals, each in its own file kind, all in git.
- **Concurrent edits.** Records are one file each, in canonical YAML (CLAUDE.md conventions), so
  two people rarely edit the same file. Overlaps between open changes are found per repo only;
  gate 0 found that too coarse to name the real clash ([the log](../plan/v31-gate0-log.md), step
  17).
- **Approvals.** There are none in the app: a gate is approved when its hand-off pull request
  merges on the Git host (ADR 0073), and a write to a shared system from the app needs the
  person's confirmation, which the session token alone can't give (ADR 0186).

## Decision

### 1. Git stays the store of record

Every record, answer, correction, rule and approval stays a file in the metarepo, in git. A team
server (decision 5) holds a clone and commits for the people using it; it adds no database of
record. Anything live (presence, typing, a job's progress) is held in memory or in git-ignored
files and is never the only copy of a decision.

### 2. One actor for people and agents

Every record that says who did something says it as an actor: `{ kind: "person" | "agent", id,
name, role? }`. A person's `id` is stable across machines (the Git user's email by default, as
ADR 0073 makes the person the Git user; an SSO subject on a team server); an agent's `id` names
the persona and its run. Existing records read as: a `by` string, a person with that name and no
id; an `AiBy`, an agent with its runtime and run; a proposal's `by`, an agent. The question file
is strict, so building this is a C6 version bump with a migration, not a silent field.

### 3. Events have a schema

A live event is `{ id, type, actor, subject, at, data }`, with `type` from a closed list per
release and `subject` the record or change it is about, as a zod union in the local API. Building
this changes C4 additively: today's events become members of the union, unchanged on the wire.

### 4. One decision log, one file per entry

Every decision by a person or an agent (an answer, a correction, a rule made active, a waiver, an
approval, a re-route) is also written to the decision log in the metarepo, with its actor,
subject, time and the record it changed: one file per entry, so many people on many clones never
append to the same file and git never conflicts on it. The log is derived: if it is lost, it is
rebuilt from the records and git history. It is the audit trail and what notifications read.

### 5. A team server is the local server with people

Inside an organisation's network, a team server is the same server process, serving one product's
metarepo clone, with three changes and nothing else: an authentication interface (SSO by the
organisation's choice) that turns a session into an actor; locks held as leases with an owner and
an expiry instead of a pid; and each person's confirmation of a write to a shared system kept per
person (ADR 0186), so a signed-in session alone never confirms one.

It adds no approvals and no rights of its own. Approving stays the Git host's: a gate is approved
when its hand-off pull request merges (ADR 0073), and who may merge is the host's branch
protection. The server commits to its own clone for the people using it, and pushes or opens a
pull request only with that person's confirmation; it never pushes to a protected branch (CLAUDE.md
rule 6). `roles.yaml` stays words, not permissions (ADR 0191).

Loopback stays the default and, in beta.31, the only mode that ships. Building a team server
amends ADR 0015, in its own ADR.

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

## Tests that prove it (written first, failing, when each part is built)

None in beta.31: nothing is built. When decision 2 is built, the first test reads a beta.30
metarepo and finds each `by` string as a person actor with no id, each `AiBy` as an agent actor
with its run, and each proposal's `by` as an agent.

## Migration

None in beta.31. Decision 2's build migrates the question file and every record that names who
did something; decision 4's build writes the log from the records already on file.

## Rough size

Nothing in beta.31. Each later ADR sizes its own part.

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
