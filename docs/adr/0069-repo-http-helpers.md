# 0069. HTTP helpers a repo writes for itself are followed

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

A single-page app rarely calls `fetch` with a written URL. It has a thin client: `http(path, init)` around `fetch(BASE + path, init)`, `post(path, body)` around `http(\`/api/${path}\`, { method: "POST" })`, and calls `post("reports", r)`. The frontend reader read only written URLs, so such an app gave no calls, its API's endpoints were never called from a UI, and feature detection (ADR 0031) found no entry points. A framework model (ADR 0054) can't describe it: models apply to files that import a house package, and the helper lives in the same repo. Every module of a repo also took the repo's type, so a React module in a Maven repo wasn't a UI.

## Decision

The frontend extractor (1.1.0) follows the repo's own helpers, from the syntax tree, without AI: a function whose parameter flows into the URL of `fetch`, `axios.<verb>` or `http.<verb>`, directly or through another helper found the same way, is a helper; its method comes from a written `method` in the `init` object or the verb, or from the parameter that carries it. A call to a helper whose arguments make the URL whole is a request, at the line of the call, with `${x}` as `{x}`. A leading base the build sets (`BASE`, `import.meta.env.X`) is dropped when the rest is a path. Helpers are followed across files through relative imports (named and namespace). A helper nothing in the repo calls (an API module's exported function) is the request it makes, its parameters the path's. Calls straight to fetch or axios with a written URL stay the existing reader's, so nothing is reported twice.

A module's component takes its type from its own build file (component 1.2.0): a package.json with a UI library is `frontend`, another `node`; a pom or Gradle build `spring-boot` when it uses Spring Boot, else `java`; then `python`, `go`, `dotnet`.

## Consequences

- An app's own client reads as the requests it makes, verified from code, and its API's endpoints become entry points for features.
- Not yet: paths built from an expression the reader can't follow (a value from an object, a function result) give `{value}`; helpers in Node backends (the node extractor) and in other languages; helpers imported from a package without source (a framework model's job).
