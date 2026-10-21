# 0071. A system's domain profile, filled from the catalog

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

Teams that run AI-assisted delivery keep a domain profile per business domain: a document of its capabilities, systems and repos, interfaces, data, controls, related domains, open questions and an evidence register. Today a person, or an assistant reading the code on request, fills it in by hand, and it goes stale as the code changes. Most of it is what the catalog already knows, with evidence.

## Decision

`atticus domain profile <system> [--out <file>]` writes a system's profile from the catalog, without AI:

- Filled from code, each with its evidence: the components and the repos they are built in (and what each builds on), the endpoints the system serves with the components that call them, the calls it makes outside itself, the tables of its stores with who reads and writes them, the domains on the other end of its interfaces, and the features found in code that touch it.
- Left Unknown and asked as open questions: the business owner, the controls and obligations that apply, each store's classification and retention, and what the system's unresolved calls and data accesses reach.
- An evidence register lists every claim with its source (repo, path and line), the scan date and its confidence (confirmed for verified or asserted facts, inferred otherwise).

The layout is a template with placeholders (`{{name}}`, `{{profile}}`, `{{capabilities}}`, `{{systems}}`, `{{interfaces}}`, `{{data}}`, `{{related}}`, `{{questions}}`, `{{evidence}}`). An organisation puts its own at `org-pack/templates/domain-profile.md`; its words are kept and the placeholders filled. Atticus ships a default.

The .NET extractor (0.1.1) also drops an action's Async suffix in `[action]` route tokens, as ASP.NET Core does by default.

## Consequences

- A domain profile is regenerated on every scan instead of written by hand; what only people know stays theirs to fill, and is asked for.
- Not yet: purpose, scope, lifecycle and operations stay prose a person writes; classification is not read from column names or annotations; contracts list only specs the catalog links to an endpoint.
