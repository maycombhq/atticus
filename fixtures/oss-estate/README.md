# A public estate, its facts stored (v31, WP-12)

Two public repos read at pinned commits, so the estate join can be scored in CI on real shapes,
offline, with no source checked out
(`packages/cli/test/oss-estate-join.test.ts`):

| Repo                       | Commit                                     |
| -------------------------- | ------------------------------------------ |
| `spring-petclinic-rest`    | `afc8fc1d3b8ec8de69414482b3bd70a1da78cb95` |
| `spring-petclinic-angular` | `7c9f1ab259f0dbc8a987c4e21d97dc616607b362` |

Licences, as each repo states them at its pinned commit:

- `spring-petclinic-rest` has a `LICENSE.txt` with the Apache License 2.0, and its source files
  carry Apache-2.0 headers: "Copyright 2002-2013 the original author or authors."
- `spring-petclinic-angular` has no LICENSE file. Its `package.json` says `"license": "MIT"`,
  while its source files carry Apache-2.0 headers: "Copyright 2016-2017 the original author or
  authors."

The Apache License 2.0 text: <https://www.apache.org/licenses/LICENSE-2.0>.

Both are at `https://github.com/spring-petclinic/`. Only verified facts are stored here: each
cites a file and line of its repo with a short quote of that one line (120 characters at most;
the test checks it). No source file of either repo is copied into this folder.

- `facts/<repo>.jsonl`: the facts the reading assistant wrote at v31 gate 0
  (`docs/plan/v31-gate0-log.md`) and `atticus verify` accepted: 84 for the REST API (37 entries
  from its `openapi.yml`, stores, settings, dependencies) and 52 for the Angular app (31 calls to
  the REST API, 19 screens). One call, `addVisit`'s `POST owners/{ownerId}/pets/{petId}/visits`
  (`src/app/visits/visit.service.ts:65`), was missed at gate 0 and added here when the reference
  was checked against the source; it was verified against the pinned commit like the others.
- `facts/<repo>.reviewed.jsonl`: the files the reader marked as read and holding no boundary.
- `facts/spring-petclinic-rest.contracts.yaml`: the OpenAPI operations the built-in reader found
  (file, line, method and path only), stored in the facts slot as Apply stores it.
- `org-pack/`: the smallest org pack the build needs, the profile and the manifest.
- `reference-links.yaml`: the true arrows, written by hand from the source: every HTTP call the
  Angular services make, each with the REST entry it reaches (in `note`). The format is the one
  `atticus measure links` reads.

To read these repos again at a new commit, follow `docs/plan/v31-gate0-log.md`, then replace the
facts files and check every arrow of the reference against the new source.
