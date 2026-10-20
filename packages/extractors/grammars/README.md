# Vendored grammars

Prebuilt tree-sitter grammars that aren't in `tree-sitter-wasms` (ADR 0060). Each is the `.wasm`
file from the grammar's published npm package, unchanged, with its licence beside it.

| File                      | From                                                              | Licence |
| ------------------------- | ----------------------------------------------------------------- | ------- |
| `tree-sitter-groovy.wasm` | `tree-sitter-groovy@0.1.2` (github.com/amaanq/tree-sitter-groovy) | MIT     |

Vendored rather than depended on: the package also brings a native build (`node-gyp-build`,
`node-addon-api`, `tree-sitter-java`) with install scripts that Atticus doesn't need.
