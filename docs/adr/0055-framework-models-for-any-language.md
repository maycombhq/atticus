# 0055. Framework models for any language: calls and routes

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

ADR 0054's framework model reads house frameworks built on Java annotations and typed wrapper clients. House frameworks come in every language and kind of repo: a React SPA framework whose components call `useApi({ service: Services.PAYMENTS, path: "/v2/payments", method: "POST" })`, a Node BFF framework whose routes are `defineRoute({ method: "GET", path: "/statements/:id" })`, a .NET or Python platform client, a Go service kit. None of them has an annotation to stand for anything, and the model's `clients` names Java types.

## Decision

**Contract C6, additions to the framework model** (optional, ADR 0041's rule; older models stay valid):

- `calls`: a call that reaches another system. `function` (the called name), optionally `receiver` (what it is called on, `lantern` in `lantern.call(...)`), `from` (the module or package it is imported from) and `language` (`js` for JavaScript and TypeScript, `csharp`, `python`, `go`; any when left out). `kind` says what the call is (`http-call` by default, or `event-publish`, `event-subscribe`, `mq-publish`, `mq-subscribe`); `httpMethod`, `service` and `path` say which argument holds each: a position (`{ arg: 1 }`), a property of an object argument (`{ arg: 0, key: path }`), or a fixed value.
- `routes`: a call that registers a route the code serves, with the same parts. It makes an Endpoint.
- `services` keys may be a plain service id (`payments`) as well as a qualified constant.
- `tests`: the model's own examples, like a dialect's. Each names sample `files` and the records reading them must `expect`, one line each: `http-call POST https://x/y`, `event-publish cards.issued`, `endpoint GET /x/{id} inferred` (an endpoint line may leave out its confidence, so learning the entry from code later doesn't break it). A test passes when it gives exactly those lines.

**A model with tests is used only while they pass.** A scan runs them first; a failing test, or an annotation, client, call or route written by a person or a document that no test exercises (taking it out changes nothing any test gives), leaves the whole model out with a problem saying why. Entries read from code or bytecode are readings, not drafts, and need no test. A model with no tests is used as written, as before. `atticus frameworks check [name]` runs the tests on demand. This is what makes a model drafted by an assistant during onboarding safe: the draft ships its examples, a person reviews them, and a wrong entry can't quietly shape the catalog.

**Drafting with an assistant.** `atticus frameworks survey [--package <prefixes>]` lists, deterministically, the house modules the estate's repos import (JavaScript and TypeScript, C#, Python, Go, Java and Kotlin), which model covers each, and how each imported name is called or annotated, with a sample line. `atticus frameworks kit` exports what an assistant needs to draft a model from that: a guide, two worked examples with tests, the schema, a checklist and a task prompt. The assistant authors data, never scan code; scans stay deterministic.

**A built-in house-framework extractor** applies `calls` and `routes` to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, through the call layer those extractors share: it evaluates each argument as they do (literals, concatenation, interpolation, constants in the file), fills names from the model's constants and service ids, and shows what it can't know as `${name}`. It runs only on files that import one of a model's packages. As with ADR 0054, an entry learned from code or bytecode makes verified endpoints; one a person or document wrote makes inferred ones. Java and Kotlin stay with the Spring extractor and the model's `annotations` and `clients`.

## Consequences

- One model describes a house framework whatever it is written in; every repo using it is read through it.
- `atticus frameworks learn` learns `calls`, `routes` and constants from a JavaScript or TypeScript framework's source, or from its published package (`.tgz`, read by a bounded tar reader in core; its typings, else its JavaScript). Exported functions, and the methods of exported client and router instances, are classified by parameter names, positional or properties of an object parameter (inline, destructured, or a named interface or type alias): a path and a method (or a verb as the name) make a call, with a handler a route; a topic with a publishing or subscribing name makes an event or queue. Entries are `code`, citing the file (and the tarball and its sha-256). `atticus frameworks discover --group @scope` finds house npm packages in the repos' package.json files and looks for them, offline, as .tgz files in given folders or installed in a clone's node_modules.
- Learning these entries from C#, Python and Go frameworks is not done yet; a person, or an assistant whose draft ships passing tests, writes them.
- Not yet: declarations in structured files for infra and pipeline repos (custom Terraform modules, Helm charts), which come next.
