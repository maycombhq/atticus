# Before you submit a dialect

Go through every line. Each one is a mistake that has made a dialect fail.

## It runs

- [ ] `atticus dialect test <name>` passes: the file is valid C2 and every test passes.
- [ ] `atticus dialect run <name> <repo>` over each repo you were given prints the records you expect and no `warning:` or `invalid:` lines you can't explain.
- [ ] The file is `org-pack/dialects/<name>.yaml` and its `name` is `<name>`.

## Rules

- [ ] One rule per framework construct; every rule has a one-sentence `description` saying what the construct means.
- [ ] No rule contains a value from a particular repo: app names, service names, topics, queues, paths, hosts, config values. They all come from templates (`${attr...}`, `${yaml:...}`, `${annotation...}`, `${match...}`, `${config:...}`).
- [ ] `files` globs read production code only (for example `src/main/java/**/*.java`, not `**/*.java`, when tests live in `src/test`).
- [ ] Every `annotation` match has the right `target` (`method`, `class`, `field`).
- [ ] `configKey` templates use the key's segments: `${match.N}` counts the matched key's segments from 1, and `${match.0}` is the value.
- [ ] The `marker` is a file every repo on the framework has, and the dialect produces nothing without it.

## Records

- [ ] Each `emit.kind` is the right kind: served → `Endpoint`; a call to a service the code names → `Interface`; a publish, subscribe or call whose other end isn't named → `Unresolved`; a configured value → `Setting`.
- [ ] Every field is one `c1-kinds.md` lists for the kind, every required field is filled, and enum fields use exactly the listed values (`rest`, `event-publish`, `retry`...).
- [ ] Ids are lowercase slugs: `lower` or `slug` on anything that could contain capitals or spaces. Ids start with the component, so two apps never collide.
- [ ] Interfaces have no `id`, and `from`, `to`, `via`, `normalizedPath` and `sync` are all filled; `method` is upper case (`| upper`) and paths go through `| normalizePath`.
- [ ] Loose ends follow the grammar: `unresolvedKind` from `http-call`, `event-publish`, `event-subscribe`, `db-access`, `db-connection`; `raw` as the reference says (`METHOD URL`, the topic, `read TABLE`...); `owner` is the component.
- [ ] Confidence: `verified` only when this repo alone proves the record; `inferred` for one side of an edge and for loose ends.
- [ ] Values that may vary in case or format in the source are normalised (`upper` for HTTP methods, `normalizePath` for paths), and values that must stay as written (`pathOrTopic`, `raw`) are not.

## Tests

- [ ] At least one `fixture` test over a real repo, expecting a record of every kind the dialect emits, with the fields that matter (not just `kind` and `id`).
- [ ] Interface ids in tests were copied from `atticus dialect run`, not invented.
- [ ] An inline test without the marker file and with `expect: []`.
- [ ] An inline test for each edge case seen while surveying: attributes in a different order, lower-case values, other path parameter styles, keys that look similar but must not match. Inline tests include the marker file.
- [ ] `absent` lists ids that must never appear (commented-out code, test code, near-miss config keys).
