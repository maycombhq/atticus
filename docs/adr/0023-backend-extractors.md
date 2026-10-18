# 0023. Backend extractors for .NET, Python, Go and Node

- Status: accepted
- Date: 2026-10-18

## Decision

Atticus adds a generic tier of backend extractors (`dotnet`, `python`, `go`, `node`, each 0.1.0). The plan named tree-sitter; we use a small tolerant lexer written in TypeScript plus token-level readers per language instead, because scans must run unchanged on Linux and Windows with no native modules (ADR 0002, 0007). The lexer reads comments and every string form (verbatim, raw, interpolated, triple-quoted, template), so routes in comments or strings never match. The readers find calls, decorators, attributes and simple assignments, and follow route prefixes through routers, groups, blueprints, mounts and function parameters: ASP.NET Core controllers and minimal APIs, FastAPI, Flask, Django, net/http, gin, chi, echo, gorilla, Express, Fastify, NestJS, koa and hapi.

Outgoing HTTP calls, topic publish and subscribe, and database connections become loose ends (ADR 0016). Values come from constants, `appsettings.json` (base file first), `.env` and code defaults; unknown environment variables and config keys stay visible as `${NAME}`, and database URLs lose credentials and query strings. A backend extractor adds a Component only where the generic component extractor finds none, and `node` leaves literal fetch/axios calls to the frontend extractor, so nothing is reported twice.

## Consequences

Cheaper and more portable than a real parser, but heuristic: no type resolution, limited cross-file resolution, and dynamic routes are missed rather than guessed. New patterns come with golden fixtures; house frameworks are still covered by dialects.
