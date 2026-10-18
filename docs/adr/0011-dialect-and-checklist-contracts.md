# 0011. Contracts C2 (dialect rules) and C3 (checklist rules and findings)

- Status: accepted
- Date: 2026-10-18

## C2: dialect rule file

`org-pack/dialects/<name>.yaml` teaches the scanner a house framework without code. Header: `name`, `version`, `extends`, `appliesTo` (repo types and an optional marker file), `layout` (source roots, config files), `normalize` (path prefixes to strip) and an optional `plugin` module for what rules can't express.

Each rule has an `id`, a `description`, exactly one `match` (annotation, base class, method call, config key, XPath, JSONPath or regex, each with the files it looks in), an `emit` (a C1 record kind, an id template and field templates) and a `confidence` (verified or inferred; never asserted, which is reserved for people).

- **Templates** are one small grammar shared with C3: `${attr.x}`, `${annotation.Name.x}`, `${config:key}`, `${yaml:file#key}`, `${member.name}`, `${class.name}`, `${file.path}`, `${file.line}`, `${repo.name}`, `${match.N}`, with filters `lower`, `upper`, `slug`, `normalizePath`, `trimSlash` and `default('x')`. A value that can't be resolved and has no default leaves the field unset; a rule never emits a half-filled value.
- **Checked at load:** emitted fields must exist on the kind in C1; the engine's own fields (kind, id, evidence, confidence) can't be set by a rule; a template may only use values its match can supply; Interface ids are always derived (`if-<hash>`), never written.
- **Tests are mandatory.** Every dialect ships `tests[]` (inline files or a fixture folder, with expected and absent records). A dialect whose tests fail does not load.

## C3: checklist rules and findings

A **checklist pack** (`org-pack/checklists/*.yaml`) holds rules. Each rule has `id`, `title`, `layer` (constitution, org or team), `lens` (one of the seven), `appliesTo` (artifacts and change types), `severity` (blocking, risk or idea), `check` (deterministic with parameters, or AI with a prompt), `evidenceRequired`, `extends` or `tightens`, `waivable`, `source`, `status` and `needs`.

- Constitution rules are never waivable and can only be tightened. Only blocking rules can be waivable.
- **`needs`** lists the C1 facts a rule depends on, with a scope, an optional freshness window and an owner question. When a needed fact is missing or stale for a system the change touches, the critic raises a knowledge gap instead of passing silently.

A **finding** is one file at `review/<gate>/<round>/<id>.yaml` in the change folder, with `kind` (issue or knowledge-gap), `rule`, `layer`, `lens`, `severity` (blocking, gap, risk or idea), `artifact`, `locator`, a one-sentence `summary`, `why`, `fix` (text and optional patch), `evidence[]`, `state` and `resolution`.

- A finding without evidence is rejected.
- Severity `gap` belongs to knowledge gaps only, and a knowledge gap carries an owner question.
- States and actions are tied: open (no resolution), applied (Apply or Edit and apply), dismissed (Not relevant, with a reason), waived (Waive, with a reason; blocking and waivable findings only), asked (Ask, with who it went to). Knowledge gaps are resolved only by Ask or Edit and apply.

## Consequences

Org packs can be validated in CI before they reach anyone, and the rule engine (M1) and the critic (M3) build against fixed formats. JSON Schema for all three files comes from `atticus schema export`.
