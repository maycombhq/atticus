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

**A built-in house-framework extractor** applies `calls` and `routes` to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, through the call layer those extractors share: it evaluates each argument as they do (literals, concatenation, interpolation, constants in the file), fills names from the model's constants and service ids, and shows what it can't know as `${name}`. It runs only on files that import one of a model's packages. As with ADR 0054, an entry learned from code or bytecode makes verified endpoints; one a person or document wrote makes inferred ones. Java and Kotlin stay with the Spring extractor and the model's `annotations` and `clients`.

## Consequences

- One model describes a house framework whatever it is written in; every repo using it is read through it.
- Learning these entries automatically (from a framework's source or its published package, and with an assistant during onboarding) is a later ticket; a person can write them now.
- Not yet: declarations in structured files for infra and pipeline repos (custom Terraform modules, Helm charts), which come next.
