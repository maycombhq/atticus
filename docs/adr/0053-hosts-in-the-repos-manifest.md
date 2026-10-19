# 0053. Hosts in the repos manifest: how calls find their component and their gateway

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

Merge joined an HTTP call to its callee by guesswork that is wrong on a real estate:

- A call to any host it didn't know went through a gateway route whenever the path started with that route's basepath. With hundreds of proxies on `/v1`-style basepaths, an unrelated call (`http://cards-svc/v1/cards/1`) became an interface to whatever service the route targets, and a partner's own API on the same basepath became a call through our gateway.
- A host named its component only through its first DNS label (`ledger-api.forge.internal` → `ledger-api`). Bank hosts rarely look like that: `pay-api-uat.apps.bank.internal`, `svc0423.corp`.
- An endpoint of another method was matched when the caller's method had none (`GET /transfers` "verified" against `POST /transfers`).
- A relative call joined the one same-system component serving that path, including `/health`, which every service serves.

## Decision

**Contract C6 (`repos.manifest.yaml`, specified with the workspace files on the C4 page): an optional `hosts` list per repo.** Each entry is a host name as calls write it, lower case, with `*` for any part of a label (`pay-api-*.apps.bank.internal`); a port is ignored. It defaults to empty, so every existing manifest stays valid. Following ADR 0041, an optional addition that older files satisfy does not bump the schema version; an older Atticus refuses a manifest that uses it (the schema is strict), which `atticus upgrade`'s version stamp already covers.

**Merge (C1 facts, no record change):**

1. A call to a host listed for a repo with gateway routes (or of type `gateway`) goes through that gateway, and only through its own routes. No other host goes through a gateway.
2. A call to a host listed for any other repo joins that repo's component, whatever the host's labels say. A component that lists hosts is reached only through them, not by a host's first label.
3. A host nobody listed still resolves by its first label, as before, when that label names a component that lists no hosts.
4. An endpoint is matched only with the call's method (or any method when the call's is unknown).
5. A relative call to a generic path (`/health`, `/ready`, `/live`, `/ping`, `/status`, `/info`, `/metrics`, `/prometheus`, `/actuator/...`) joins nothing.
6. A call to an undeclared host whose path starts with a gateway basepath stays a loose end, and the scan says so in a note naming the host, so a platform lead can declare it.

`MergeInput.gatewayByBasepath` keeps the old rule 1 for one caller: the drift check on a fetched copy of the catalog, which has no manifest and so no declared hosts. A full scan never sets it.

## Consequences

- No more interfaces invented from a basepath; a gateway is joined only on hosts someone declared. An estate that hasn't declared its gateway host sees its gateway calls as loose ends, with a note per host, until it does. The Forge and synthetic fixtures declare theirs; the expected catalog doesn't change.
- Platform leads list their components' hosts (from DNS, ingress or service-mesh config) once in the manifest; `atticus repos discover` doesn't propose them yet.
- Drift on a fetched catalog copy can still join a call through a gateway on basepath alone; given the metarepo, it is exact.
- Not yet: hosts from environment-specific config (Spring profiles, Helm values), service-registry names (Eureka ids), and proposing hosts from the scan's own loose ends.
