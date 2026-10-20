# 0060. Rules read syntax trees, not text patterns

- Status: accepted (direction from the product owner, 2026-10-20; pending review)
- Date: 2026-10-20

## Context

Atticus adapts to an organisation's ecosystem through rules its assistant drafts (ADR 0059). What a rule can match decides how well that works. Today a dialect reads structured files through real parsers (YAML, JSON, XML, HCL), but code only through a lexical Java reader (annotations, base classes, method calls) or a `regex` over the text. A regular expression can't tell code from a comment or a string, breaks on a line break or a renamed variable, and has to be rewritten for every language. An assistant drafting rules over text patterns writes fragile rules, and the product owner's direction is plain: no regex.

## Decision

**A `syntax` match (C2, an addition):** a [tree-sitter](https://tree-sitter.github.io) query over the file's syntax tree.

```yaml
match:
  syntax: |
    (method_invocation
      object: (identifier) @client
      name: (identifier) @method (#eq? @method "exchange")
      arguments: (argument_list . (_) @service . (string_literal) @verb . (string_literal) @path))
  files: ["**/*.java"]
```

- `language` is optional; by default it follows the file's extension: Java, Kotlin, TypeScript, TSX, JavaScript (and JSX), C#, Python, Go, Scala, Ruby, PHP, Rust.
- Each match is a place; `${capture.<name>}` is a capture's text. A capture that is a string literal gives its value without the quotes. The place's line is the first capture's.
- Captures work in `where`, `emit` and `lookups`: a lookup over `(variable_declarator name: (identifier) @name value: (string_literal) @value)` is a table of the repo's string constants, so `${lookup:constants(capture.service).value}` fills a constant used as an argument.
- A query that doesn't compile fails the rule, which fails the dialect's tests: it never loads.

**Parsers ship with Atticus**, offline: `web-tree-sitter` (MIT) and prebuilt grammars from `tree-sitter-wasms` (Unlicense; each grammar under its own permissive licence), pinned together (runtime 0.22.6, grammars 0.1.13; newer runtimes don't load these builds). Nothing is downloaded or compiled at run time. Structured files keep their own parsers (`jsonPath`, `xpath`, `configKey`, `hclBlock`).

**Drafted dialects read trees and structured files only.** `atticus onboard` refuses a draft with a `regex` match. The survey gives the assistant the syntax tree of sample code files, so it writes queries against the node names the grammar really uses, and `atticus dialect tree <file>` prints the same tree for a person.

**`regex` stays for now** in hand-written dialects, for compatibility (ADR 0041), and is deprecated: documented as the last resort, not used in examples.

## Consequences

- One rule language reads code in a dozen languages and the configs around it, and an assistant can draft it for anything with a grammar.
- The built-in extractors' lexical readers (Java, the JS/C#/Python/Go call layer) can become rules on the same engine, shipped as dialects; that migration is staged, behind golden tests that must give the same records.
- The offline bundle grows by the grammars it carries (about 18 MB for the twelve languages above); the bundle can carry fewer.
- Languages without a prebuilt grammar here (Groovy, COBOL, PL/I) need one added to the bundle before rules can read them.
