# 0163. Org notes per repo type: what terms mean and what must hold

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0077 (repo types), 0078 (questions), 0124 (facts the assistant writes; addenda A-callers, A-gateway2, A-lean), 0147 (the house conventions), C3 (checklist rules)

## Context

Every organisation's repos write identifiers of its own that no framework explains: an access-list file on each gateway proxy naming the applications let in by their CMDB ids, a service's own application id in a descriptor, a cost centre. They carry real links (who is let in to which API, which repo is which system), and real rules hang off them ("every call to a vendor uses mTLS"). Atticus cannot know what they mean, and must not try: a parser for one organisation's access-list shape, or a JSON path per file, is organisation-specific code (CLAUDE.md rule 7) and breaks on the next shape.

What people can do cheaply is say it in their own words, once per kind of repo. The reader already reads every line; it needs only to be told what the words mean, and then every claim can be checked on its line like any other.

## Decision

### 1. Notes, in plain text (C6)

A repo type (`org-pack/repo-types/<id>/type.yaml`) gains optional `notes: [string]`, and `conventions.yaml` optional org-wide `notes`. A note is plain text in the organisation's own words, at most 1,000 characters, at most 50 per file. Atticus never parses one.

Each read of a repo is handed its repo type's notes, then the org-wide ones, numbered from 1 in that order (`notesFor`), inside the batch prompt (`mapBatchInstructions`' `notes`) and on `atticus map <repo> --estimate` (text and `--json` `notes`) for `/atticus-map`, as data, never instructions. The repo's type is the manifest's when it names a repo type of the pack, else the one its fingerprint matches clearly or in part (`atticus repo-type detect`'s match); a tie or no match gives only the org-wide notes. With no notes at all nothing is added and every read goes as before.

`atticus repo-type note <type> [--add "..."]` (or `--org-wide`) lists or adds notes, keeping the rest of the file as written.

### 2. The `term` fact kind (facts file)

```
term: term: text, value: text, role: owner|consumer|none|unknown, note?: number or text, meaning?: {file, line, value}
```

`cite` is the value's line; `meaning` is the line that gives it its role (the `"consumers": [` line, an owner block's key). `note` is the number of the note the role rests on, or its words quoted. An `owner` or `consumer` needs `meaning`. A term whose key and value look like a secret is refused by the schema, as a config fact's is (`looksLikeSecret`, shared).

The verifier checks: the value on its cited line (or the line either side, as every claim); `meaning` in the same file, at or above the value's line, writing what it says (`term-meaning` when it is in another file or below; `claim-not-on-line` when the line doesn't write it); and `note` against the notes the read was handed (`VerifyOptions.notes`; a number out of range, or words in none of them, is `term-meaning`). Nothing checks what a note means: the check is on the lines.

With no note that says, the reader records the identifiers it meets that look like the organisation's own (keys with id-like values, entries of a list of apps or teams) with `role: unknown`.

A kind of its own, not a field on `config`: a term's subject is an identifier the joins compare across repos, it often sits in a file that is not configuration (an access list, a descriptor), and it has a second line (its meaning) that no config fact has.

The reading rule is tagged for config, deploy, gateway and data files (A-lean), so code-only batches don't carry it; the facts reference gains the `term` line. Both cost about 250 tokens a prompt; three CLI tests' fixed model limits were raised by 500 tokens, as earlier additions did.

### 3. A call's `auth` and `tls`

A call fact gains optional `auth` (the C1 `Auth` enum), `authCite`, `tls` (`mtls`, `tls`, `none`) and `tlsCite`. Each claim goes with its line, checked as an entry's `authCite` is; an `auth` or `tls` without one is rejected (`security-uncited`) unless a person made the fact. They feed only the rule check below; C1 is unchanged.

### 4. Joins (pure, in `core/src/facts-terms.ts`)

`joinTerms` compares values word for word, never guessing a meaning:

- an **owner** value ties its repo to its system: `projectFacts` flags the repo's Component `term:<term>=<value>` (C1's existing optional `flags`), cited;
- a **consumer** value points to the repo whose owner value is the same (when exactly one repo claims it);
- the **same value in two repos** that no owner and its consumers explain (an `unknown` role, two owners) is a **possible link**, `inferred`, flagged `linked-by-term-value`, shown at `verify --write` and on map.md, never written as an Interface;
- a gateway repo's consumers become **AccessGrants** on each of its routes (`termGrantRecords`): subject the value as written, resource the route's GatewayRoute, evidence the value's line and its meaning line, flags `caller:<term>` and `term:<term>`. No new `CALLER_KINDS` member: the grant is C1's AccessGrant as A-callers writes it, and `caller:<term>` is a flag the critic already reads, so a change to a route names every listed consumer as affected (`constitution.breaking-delta-consumers`), with no critic change;
- **access against calls**: a repo whose call the estate join lands on the routes, and none of whose own values is listed, is a finding (`caller-not-listed`, for its owner); a listed consumer whose repo is known and makes no call into them is a note (`listed-no-call`).

`catalogWithFacts` carries the whole result as `terms`; `atticus verify <repo> --write` writes the grants with the catalog and says the findings, notes and possible links about the repo (`termsWrite`).

### 5. A note that reads as a rule

A note that says all, every or must is offered as a C3 checklist rule draft (`noteRuleDrafts`, `status: draft`, `layer: org`, question `safe`, `waivable: false`, `source` the note's file and index). `atticus repo-type rules [--save]` lists them and, with `--save`, adds the new ones to `org-pack/checklists/org-notes.yaml`, keeping every rule a person already edited. A note about calls and mTLS, TLS or auth is drafted as the deterministic check `call-security` with its params filled from the words it uses (`to: vendor|any`, `tls: mtls|tls`, `auth: true`); any other as an AI check quoting the note. The words only fill a draft for a person to review: the accepted rule's params are what is checked, and the check reads facts, never the note.

Once a person makes it `active`, each `verify --write` runs it (`checkCallSecurity`): every call the join leaves to an outside system (or every call, for `to: any`), with, when it is a gateway's forwarding call, the chain of each call that lands on the route it forwards from. It passes when the call or a hop in its chain shows the TLS asked for (a cited `tls`, or a route's cited `mtls` auth) and, if asked, an auth other than none (a call's cited `auth`, or a route's cited auth); otherwise it is a finding for the first call's repo's owner. A person's word that it is done outside the repos goes in the rule's `params.declared` (`repo`, optional `call`, `why`, `by`) and is shown as declared, their word, never verified. The critic skips `call-security` as an unknown check, as it does every check id it doesn't have: it is an estate check, and runs where the estate join is.

### 6. Questions

A term with role `unknown` becomes a question, one per term, file name and repo type (`termQuestionDrafts`, step `term-meaning`, scope `repo-type`): "What does `cmdb` mean in userAccess.json across 2 forge-apigee-proxy repos? It holds APP000123, APP000456." Options owner, consumer, none. It is raised for the group's first repo by id, and retires when the facts give every value a role, or is replaced when the group changes. Answering it prints the note to save (`termNoteOffer`): `atticus repo-type note <type> --add "..."`, so the next read of every repo of the type records the role, cited. A repo with no type is asked on its own.

### 7. Shown

map.md gains a Terms section when the facts hold any: each value, its role, its line and its meaning line, a consumer's owner component, an owner's listing gateways, an unknown's possible link. The Map's Trust tab lists each repo's terms (`terms` on a repo of GET /api/trust, local API 2.48.0, additive), words from `copy.ts`.

### 8. The contracts and the migration

- Facts file: `FACTS_SCHEMA_VERSION` 3 (the `term` kind and the call fields). No line carries a number; a file written before reads unchanged, every addition being a new kind or an optional field.
- Repo type (C6): `REPO_TYPE_SCHEMA_VERSION` 2. A version-1 file reads as it is and comes back as version 2 in memory (as Question version 3 does); writers write 2.
- Conventions (C6): `CONVENTIONS_SCHEMA_VERSION` 2, the same way.
- C1, C3, C4's plugin SDK: unchanged. The local API (C4) is 2.48.0, additive (2.45.0 is ADR 0162's, 2.47.0 ADR 0164's).
- No `atticus upgrade` step: nothing on disk must change. The JSON Schemas (`factsJsonSchemas`, `orgPackJsonSchemas`) are generated from zod; `docs/spec` and `docs/api/openapi.json` were regenerated.

## Consequences

- An organisation explains its own identifiers once per repo type, in words, and every read after cites them; no Atticus code knows any organisation's file shape. Fixtures: `fixtures/term-notes/` (an access list as a JSON array, a nested JSON object and YAML; owner ids in descriptors) and an inline second stack (a .NET `appsettings.json` and a Node client) in `packages/verify/test/terms.test.ts`.
- Who may call an API is now read from the gateway's own list and checked against the calls the code makes, both ways.
- A rule written as a sentence becomes a deterministic check only after a person sets it; until then it is a draft nobody runs.
- Not yet: a term's role read from the file's own words without a note (a key literally named `consumers`) is the reader's call, cited like any other, but nothing ranks it below a note; the access check counts calls by the estate join only, so a caller the join leaves asked is not counted; `call-security` runs at `verify --write`, not in the critic.
