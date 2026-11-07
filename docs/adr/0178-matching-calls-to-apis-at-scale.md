# 0178. Matching calls to APIs at scale: more shapes, three likely APIs, confident pairs, and a Copilot match

- Status: accepted (pending review by the product owner)
- Date: 2026-11-07
- Builds on: ADR 0174 (G1, connecting two boxes call by call), ADR 0173 (Copilot runs from the app), ADR 0176 (reading rules)
- Contracts: C4 (local API 2.57.0) adds `suggestions`, `confident`, `words`, `forwards` to the link candidates, and `GET`/`POST /api/links/match` (2.59.0, part 2); all additive. No fact or catalog record changes.

## Context

Connect to… (ADR 0174) listed a repo's loose calls and the other box's APIs, with one suggestion per call from four string shapes (same path, prefix, parameter, names alike). On a gateway or platform component with hundreds of routes, or a client whose paths are built from settings and constants, most calls got nothing or a wrong guess, and a person paired them one at a time. The plan `docs/plan/canvas-for-changes.md` sets out the fix.

## Decision

### Part 1: more shapes, three likely APIs, confident pairs (2.57.0)

`linkCandidates` scores each call against each API as the best of:

- the paths as written (the four shapes of ADR 0174), with a leading version prefix (`/v1`, `/v2`) ignored on both sides;
- the call's path with its **settings filled in**: every `${key}` the repo's config facts give a value for (a URL's host dropped, its path kept) — `why: setting`;
- the path the API's **gateway route forwards to**, from the forwarding call made `from` the route — `why: forwarded-path`;
- the **words** of the call site's constant or path against the operation's `operationId` (an outside system's spec) — `why: operation-words`.

Each call carries its three likeliest APIs (`suggestions`, best first, the first also as `suggestion` for older clients) and `confident: true` when the best scores at least 0.85 and leads the next by 0.2 or more. The panel lists the likely three first in each call's select, counts confident / suggested / unsuggested, starts with only the confident ticked, and offers **Tick the N confident**, **Tick all suggested** and **Untick all**; a search box narrows a long API list. Everything still goes through Preview and the person's yes, as one write (ADR 0174's `link` lines).

### Part 2: Match with Copilot (2.59.0)

When the shapes aren't enough, **Match with Copilot** in the panel starts a copilot-acp session (the run route of ADR 0173, same guard rails: allowed by runtime.yaml, one at a time) with a brief: the repo's loose calls, each with its cited lines as the facts hold them; the other box's APIs with their spec words; and the instruction to pair each call with one API or say none, naming the lines that made the match. Every piece of file content in the brief is fenced as data (`dataBlock`, ADR 0176). The session **writes nothing**: its answer is checked (every call named is one of the repo's, every API one of the box's) and comes back as proposed pairings with reasons, which the person ticks and writes as ordinary `link` corrections. Where copilot-acp isn't allowed, the same brief is a hand-off prompt (`atticus connect match <repo> --to <box> | --system <id> --mode hand-off`), the brief and the answer live under `proposals/matching/`, and the answer file is read back the same way (**Read the answer** in the panel, or the command again).

### What doesn't change

A pairing is still a person's word (inferred, flagged `joined-by-person`, with their evidence) and never a fact; Copilot proposes, a person decides; the next read is where a shape learned here becomes a reading rule (ADR 0176, "Make this a rule").

## Consequences

- On a 40-repo estate most same-service calls pair in one click; the rest get a short list rather than a long one.
- A confident pair can still be wrong (two services with the same route shape): the person sees it in the preview, and Undo removes exactly its line.
- The Copilot match costs one session per Connect; it is asked for, never run on its own.
