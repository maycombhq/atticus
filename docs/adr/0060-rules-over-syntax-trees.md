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

- `language` is optional; by default it follows the file's extension: Java, Kotlin, TypeScript, TSX, JavaScript (and JSX), C#, Python, Go, Scala, Ruby, PHP, Rust, and Groovy (`.groovy`, `.gradle`, `Jenkinsfile`).
- Each match is a place; `${capture.<name>}` is a capture's text. A capture that is a string literal gives its value without the quotes. The place's line is the first capture's.
- Captures work in `where`, `emit` and `lookups`: a lookup over `(variable_declarator name: (identifier) @name value: (string_literal) @value)` is a table of the repo's string constants, so `${lookup:constants(capture.service).value}` fills a constant used as an argument.
- A query that doesn't compile fails the rule, which fails the dialect's tests: it never loads.

**Parsers ship with Atticus**, offline: `web-tree-sitter` (MIT) and prebuilt grammars from `tree-sitter-wasms` (Unlicense; each grammar under its own permissive licence), pinned together (runtime 0.22.6, grammars 0.1.13; newer runtimes don't load these builds). Groovy's prebuilt grammar (tree-sitter-groovy 0.1.2, MIT) is vendored in `packages/extractors/grammars/` with its licence, because its package also installs a native build Atticus doesn't use. Nothing is downloaded or compiled at run time. Structured files keep their own parsers (`jsonPath`, `xpath`, `configKey`, `hclBlock`).

**Drafted dialects read trees and structured files only.** `atticus onboard` refuses a draft with a `regex` match. The survey gives the assistant the syntax tree of sample code files, so it writes queries against the node names the grammar really uses, and `atticus dialect tree <file>` prints the same tree for a person.

**`regex` stays for now** in hand-written dialects, for compatibility (ADR 0041), and is deprecated: documented as the last resort, not used in examples.

## Consequences

- One rule language reads code in a dozen languages and the configs around it, and an assistant can draft it for anything with a grammar.
- Every built-in extractor reads code from the same trees (Java and Kotlin through one reader shared by Spring, dialects and the learners; the JS, C#, Python and Go call layer; the ORM and vocabulary readers), checked against the golden tests and fixtures.
- **Built-in extractors for mainstream frameworks stay code, reading trees; they don't become rule files.** Spring's reading needs placeholder resolution from layered config, constants from the whole repo, confidence from where a framework model was learned, and path joining; a rule language that expressed those would be a programming language, harder for an assistant to draft and a person to review. Public frameworks are stable; what an organisation customises (house annotations, wrapper clients, gateways, infra modules) is what rules and framework models describe, and what onboarding drafts.
- The offline bundle grows by the grammars it carries (about 18 MB for the twelve languages above); the bundle can carry fewer.
- Languages without a prebuilt grammar (COBOL, PL/I, Swift, SQL dialects) keep their existing readers until a grammar can be built for the bundle (it needs a tree-sitter toolchain with Emscripten, which the build doesn't have yet).
