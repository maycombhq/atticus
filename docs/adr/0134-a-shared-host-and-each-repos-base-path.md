# 0134. A shared host, and each repo's base path

- Status: accepted (pending review by the product owner)
- Date: 2026-10-28
- Builds on: ADR 0009 (workspace and repos files), 0053 (hosts a repo answers on), 0057 (modules), 0124 (facts the assistant writes; addenda C-join, A-gateway, A-gateway2), 0128 (the manifest's version 2)

## Context

The estate join (ADR 0124, C-join) ties a call to the repo that serves it by the host the call uses, as `repos.manifest.yaml` lists it under `hosts:` (ADR 0053). That assumed a host is one repo's.

A first read of a bank's estate showed two common shapes where it isn't:

- **One API gateway host, many proxy repos.** Every internal Apigee proxy is a repo of its own, all deployed behind one host. The path's first segments (the proxy's base path) say which proxy a call reaches.
- **One platform host, many services.** Spring Boot services on OpenShift or GCP sit behind one ingress host, each under a common base path and its own module name (`/<base>/<module>/...`). Their code declares only the controller's path (`/limits/{id}`); the part in front is the platform's.

The join took the **first** repo that listed a host, so on a shared host every call was matched against one repo's routes and the rest were missed. And a path every service serves (`/ping`, `/retrieve`, `/actuator/health`) can't say on its own which service a call means.

What goes in front of a repo's routes differs between organisations (a gateway's base path, an ingress prefix and module name, or nothing), so it has to be configuration, not a rule in the code.

## Decision

### 1. Every repo that lists a host is a candidate

A call on a host several repos (or modules) list is matched against the routes of all of them. The route that serves the call's path picks the repo, as it already picked the entry within a repo. Two routes that both serve it are a question, as before. Nothing depends on the order repos are listed in.

### 2. A repo can give its base path

`repos.manifest.yaml` gains an optional `basePath` on a repo and on each module: the path its routes sit under on its hosts (`/cdp/limits`, `/qolo-onboarding/1.0`). Plain segments, a leading slash and no trailing one.

When repos that list a host give base paths, a call whose path starts with one of them goes only to those repos, the longest base path first. The call's path is the base URL's own path (a config value `https://host/cdp/limits`) followed by the call's. No base path starting it leaves every repo listing the host, as in 1.

A base path only narrows which repos are searched. Matching within them is unchanged: an entry still matches the end of a longer called path, so a controller's `/limits/{id}` serves `/cdp/limits/limits/{id}`.

### 3. The manifest's version 3

`WORKSPACE_SCHEMA_VERSION` goes to 3. As in ADR 0128, `schemaVersion` on the five workspace files is the union of 1, 2 and 3, overwritten to 3 in memory. A version-1 or version-2 manifest differs from version 3 only in the number, so it is read as it is; writers write 3.

`atticus upgrade` gains `manifest-schema-v3`, which rewrites each manifest below 3 at 3, keeping its comments and order. `manifest-schema-v2` now rewrites only to 2, so a version-1 manifest takes both steps in one run, as `sources.yaml` did (ADR 0132).

### 4. No fact changes

Hosts and base paths are read by the join at `atticus verify --write`. Nothing a reader wrote changes. Adding them and running `atticus verify --all --write` again re-joins every repo without a model call.

## Consequences

- An organisation with a shared gateway host lists it on every proxy repo. One with a platform ingress lists the host and each service's base path. One with a host per service changes nothing.
- A path every repo serves, with no base path to tell them apart, is still asked rather than guessed.
- C6 (the manifest is org-pack configuration) gains one optional field, behind a version bump with a migration.
