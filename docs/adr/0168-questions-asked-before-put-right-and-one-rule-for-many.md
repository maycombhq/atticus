# 0168. Questions asked before put right, and one rule for many

- Status: accepted (pending review by the product owner)
- Date: 2026-11-02
- Builds on: ADR 0078 (questions as files), 0117 (the same question asked once; V0 retired questions), 0124 addendum C-join, 0153 (Q1 groups, Q2 rules), 0162 (F8 ranked suggestions)

## Context

On a forty-repo estate (Spring services, Apigee proxies each in its own repo, OpenShift), a person reported that the target questions resolved nothing to the right repo and asked hundreds of near-identical things. The questions they saw were asked before beta.11: one per call, every read repo listed, each option worded "<repo>, built in <repo>, answers PUT /accounts/{id}", a claim no evidence made. Three things kept them that way:

1. `raiseQuestions` leaves a question on file by its id as it is, so beta.11's ranked suggestions (ADR 0162, F8), and any repo read since, never reached a question asked before.
2. The wording of an option said a candidate "answers" the call whatever the evidence, and one with no evidence said nothing about it.
3. Several open questions about calls under one path prefix (a proxy's routes, a client's calls through one config key) were answered one at a time; ADR 0153's rule (`--match`) was there, but nothing offered it.

## Decision

1. **Refresh in place.** `raiseQuestions(..., { refresh: true })` gives an open, unanswered question on file by the draft's id, asked by the same step, the draft's options and words: the same id; `askedBy`, `alsoAskedBy`, `related` and `reopened` kept. An answered or retired question is never touched. `verify --write` refreshes its targets questions and says which. Q1 grouping applies on the re-draft, and the existing retirement (ADR 0117 V0, J6) retires a per-call question its group now asks, or that an answer's rule covers, with why and what replaces it.
2. **A gateway proxy's routes, asked once per target and prefix.** A forwarding call of a repo with an Apigee proxy's deploy fact is grouped as before (its TargetServer or host, its path prefix) but asked as "Which repo serves the routes under /accounts/** that <proxy> forwards to <target>?". The words a group had before are still read for its answers and splits (`targetGroupWordings`).
3. **Options say why, not that it answers.** An option is `<label>, built in <repo> (not read yet): <why>`, at most three reasons: `serves <entry> (<line>)`, for a group `serves <entry> and N more under <prefix>`; `its basePath <p> matches: <where>`; `it lists <host> under hosts`; `named like the config key / client / host label / path`; `picked for N other calls of <repo>`; or `no evidence; listed so you can pick it`. Still the best five, then Another repo… and None of these. A proxy's flow matched with `ANY` serves any method; a TargetServer's or remote config's bare host gives its host label.
4. **One rule for many.** `targetRuleOffers`: an open targets question whose calls (the call facts its evidence cites) share a path prefix (Q1's, `/accounts/**`), or else a host, with another open targets question of its repo offers that rule. `questions show`, `list` and `show --json` (`rule`) say "Answer once for all N: ... --match '/accounts/**'"; the local API's GET /api/questions carries it as `about[id].rule` and the Questions page fills in the rule field with it.
5. **A gateway's host no proxy lists.** A hosts question whose calls' paths are under a repo's GatewayRoute base path puts that repo first ("serves GET /forge/core/v1/cards/{id}/pin, a path the calls to <host> make") and says once: list the host under `hosts:` on each proxy repo in `repos.manifest.yaml`; the path then picks the proxy.

## Consequences

- C4: the local API is 2.49.0, additive (`about[id].rule`). Question files keep schema 4; a refreshed file from schema 3 is written at 4, as any write does. C1, C3, C5, C6 and the facts file: unchanged.
- An open question's option numbers can change when it is refreshed; an answer already given is never renumbered.
- The fixture `fixtures/link-estate/gateway-questions` holds the proxy, its two services, a client and the old-shape questions.
