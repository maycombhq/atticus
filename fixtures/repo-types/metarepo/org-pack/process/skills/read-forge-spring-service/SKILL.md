---
id: read-forge-spring-service
name: Read a Forge Spring service
description: What to look for when surveying a Forge service built on Spring Boot or the Forge framework.
appliesTo:
  repoTypes: [forge-spring-service]
owner: team-platform
source: process/skills/read-forge-spring-service/SKILL.md
status: active
reviewedAt: 2026-10-21
---

1. Entry points are classes annotated `@RestController` or `@ForgeService`. A `@ForgeEndpoint(method, path)` is one HTTP endpoint; its path is relative to the service.
2. The context path is `server.servlet.context-path` in `src/main/resources/application.properties` or `application.yml`. It goes in front of every endpoint in `src/main/java`.
3. A `docs/` folder in a Forge service is a generated API playground, not the product.
4. Outbound calls go through classes named `*Client`; their base URL is a `*.url` key in `application.yml`.
