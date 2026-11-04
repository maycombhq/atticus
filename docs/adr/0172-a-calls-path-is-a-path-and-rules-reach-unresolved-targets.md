# 0172. A call's path is a path, and a rule reaches the calls whose URL can't say where they go

- Status: accepted (pending review by the product owner)
- Date: 2026-11-04
- Builds on: ADR 0124 (facts and the verifier), its addendum J0 (config placeholders), 0153 (answers by rule, Q2), 0167 (the rules top-up), 0168 (old questions refreshed)
- Contracts: C1's verifier codes gain one (`call-path-is-a-name`), additive; the facts file is unchanged

## Context

On a real estate, after beta.13, two things kept hundreds of target questions open.

1. A gateway proxy answered with `--match "/**"` still had its forwarding calls asked one by one. A rule named the target only of a call with no URL; these calls do have one, but its host is still a deploy token (`https://@targetUrl@`), or their base has a different host per environment, or the reader wrote the token as `to`. The join asks about each of them, and no rule could answer it.
2. Service repos calling the same system through a client helper had calls whose `path` was not a path: the setting's placeholder (`${forge-remote.uris.download-report}`), which the join resolved only for hosts and topics, or the name of the field that holds it (`requestRefundPath`, `cancelPaymentPath`). With no real path nothing matched the system's routes; each call became a question, its options "named like the path requestRefundPath".

## Decision

1. **A rule names the target of every call a target question can be asked about.** Besides a call with no target and no URL: a call whose URL's host is still a placeholder (`@x@`, `${x}`, `{x}`), whose `to` is a placeholder, or whose base has values with different hosts. A call whose URL names a real host, or whose target a person set, is still never read from a rule. Its open question retires on the next `verify --write`, naming the rule.
2. **J0 for a call's path.** A path written as a placeholder is resolved through the config facts that set it, as a host is: one value gives the path; a whole URL gives the host too, in place of the base. Several values, or none, leave the call as written, asked as before.
3. **A path is not a name.** The reading rules say so: follow the variable, field or helper to the literal path, or to the setting's placeholder with its whole key, citing the line that sets it, and record the setting as a config fact. The verifier rejects a REST or SOAP call whose path is only an identifier in camelCase or with an underscore (`call-path-is-a-name`), with how to read it; a lower-case word (`ping`) is left alone. The reading rules' hash changes, so `atticus map --all --stale` tops up the repos read before (ADR 0167).

## Consequences

- One `/**` answer on a proxy closes its forwarding-call questions; one `atticus map --all --stale` and `atticus verify --all --write` re-read the calls written as names and join those whose setting the repo's properties give.
- A path a setting holds outside the repo (a config server) stays unresolved and is asked, as before.
