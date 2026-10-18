# 0027. Stub servers and diagram export

- Status: accepted
- Date: 2026-10-18

## Decision

Atticus generates stubs and diagrams from specs and the catalog and never edits them back. `@maycombhq/stubs` builds deterministic stubs from OpenAPI 3.x or Swagger 2.0 (or from catalog endpoints when there is no spec): the answer is the spec's example, else a value built from the schema, with the first 2xx status; requests are checked against a JSON Schema subset; errors are RFC 9457 problems; scenarios (`X-Stub-Status`, `Prefer: code=`) return documented responses only. The server binds 127.0.0.1 and is started only from the CLI (`atticus stub serve`); tests call the handler in memory.

`@maycombhq/diagrams` builds a neutral view model (context, container, data, event, sequence) rendered as Mermaid or draw.io (`atticus diagram render`), sorted and stable so diffs show real changes. The draw.io export labels boxes and edges in the grammar reconcile reads, so an exported diagram reconciles with no disagreements, and `atticus diagram library` writes a shape library with legend styles. Reconcile now accepts an edge drawn with a data-access pattern between a table's reader and its owner as a match.

## Consequences

Teams can start a design from the catalog. Views have no layout intelligence (draw.io gets a simple grid). A diagram is never a source of facts until reconcile and a person say so.
