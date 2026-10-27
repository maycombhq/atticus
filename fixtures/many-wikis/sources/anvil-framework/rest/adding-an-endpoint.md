---
title: Adding a REST endpoint with Anvil
owner: Anvil maintainers
updated: 2026-06-30
---
# Adding a REST endpoint with Anvil

## Steps

1. Add a controller method annotated with @AnvilEndpoint and the path.
2. Declare the request and response as records in the api package.
3. Map errors with the AnvilProblemMapper so the error body follows the standard.
