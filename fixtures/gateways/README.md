# Gateways fixture (invented)

Tidewater's cards service calls three services through three different gateway products, the
way a bank that grew by acquisition does: Apigee with target servers per environment, Kong's
declarative config, and Azure API Management kept as APIOps folders. No built-in extractor reads
the Kong or APIM layouts, or Apigee target servers: each gateway repo is read through a dialect
in `metarepo/org-pack/dialects/` (ADR 0058). `packages/scanner/test/gateways.test.ts` checks
every call joins end to end.
