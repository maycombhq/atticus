# 0054. Framework models: what a house framework means, wherever it is learned from

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

No organisation uses Spring, or any framework, the way its documentation does. Teams build on house starters: `@InternalApi` meta-annotated with `@RestController`, `@Op(verb, path)` instead of `@GetMapping`, a platform wrapper `bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")` instead of `RestTemplate`, service ids and paths in constants classes. The built-in extractors know the framework's own annotations and types only, so a house-built service yields no endpoints and no calls (the messy-estate gate's two gaps). C2 dialects can describe some of this, but only with literal values, one regex-heavy rule per annotation and per verb, and nothing they can learn from.

What a house framework means can be known in several ways: its source repo, its JARs (often all a consuming team has), the dependencies that point to them, its wiki pages, or a person who knows it. Each should give the same thing.

## Decision

**Contract C6: `org-pack/frameworks/<name>.yaml`, a framework model.** It says, in terms the built-in extractors already understand, what a framework means:

- `packages`: import prefixes that mark a file as using the framework (`tide.platform`).
- `annotations`: a house annotation (simple name) and what it `means`: one or more annotations an extractor already reads, by simple name, with `attributes` mapping its attribute names onto theirs (`basePath: path`, `verb: method`). The contract names no framework's annotations (ADR 0035); the Spring extractor reads Spring's (`RestController`, `RequestMapping` and the mappings, `FeignClient`, the listeners), an extractor for another framework reads its own.
- `clients`: a wrapper type and method that is an HTTP call, with the positions of its `service`, `method` and `path` (or `url`) arguments, or fixed values for them.
- `services`: a service id (`Services.AUDIT`) and the base URL it stands for.
- `constants`: a constant (`Topics.CARD_ISSUED`) and its value.
- `source` on every entry: where it was learned (`code`, `bytecode`, `document` or `person`) and a reference (a repo path, artifact coordinates with a checksum, a page). Entries from code or bytecode can make verified facts; entries from a document or a person make inferred ones.

The file is data, written by a person or by `atticus frameworks learn` (later tickets: from a source repo, from JARs found through dependencies, from documents through the AI hand-off, from a usage survey), and reviewed like any org-pack change. Scans only read it: no scan fetches a JAR or reads a wiki.

**Contract C4: `ScanContext.frameworks`** (optional, ADR 0041's rule): the models that apply, given to every extractor. Extractors that don't use it are unchanged; the scan cache key includes the models.

**The Spring extractor** applies a model as soon as it has parsed a file: each house annotation gets the built-in annotations it means beside it, with mapped attributes, so the rest of the extractor reads a house controller like a Spring one. A wrapper call becomes an `http-call` loose end (`POST https://audit.tide.internal/audit/events`). Model constants fill names in paths, topics, queues and call arguments; a served path is a verified endpoint only when every name in it was filled from code or bytecode.

## Consequences

- One model per house framework, not per team or per repo: every repo that uses the starter is read through it. A starter upgrade changes one file.
- The messy estate's house controller and wrapper call are read with a hand-written model; the gaps close.
- `ScanContext` grows an optional field: plugins written against the first C4 still conform.
- Not yet (later phase 3 tickets): learning models from source, JARs, dependencies, documents and surveys; constants from every repo; Kotlin-only annotation arguments; models for frameworks other than Spring-style ones.
