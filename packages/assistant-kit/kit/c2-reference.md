# Dialect file reference (contract C2)

Everything a dialect file can say and exactly what the engine does with it. `dialect.schema.json` is the same schema in machine-readable form.

A dialect lives at `org-pack/dialects/<name>.yaml`, one dialect per file, and `name` must equal the file name without `.yaml`.

## Top-level fields

| Field                         | Required | Meaning                                                                                                                                                                                                         |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`               | yes      | Always `1`.                                                                                                                                                                                                     |
| `name`                        | yes      | Lowercase slug (`a-z`, `0-9`, `.`, `_`, `-`; starts with a letter or digit). Repo manifests and `extends` refer to the dialect by it.                                                                           |
| `version`                     | yes      | Semver, `MAJOR.MINOR.PATCH`. Bump it when you change rules: the scan cache is keyed by it, and every record's evidence carries `name@version`.                                                                  |
| `description`                 | no       | One sentence: which framework, and how its apps declare things.                                                                                                                                                 |
| `extends`                     | no       | Names of other dialects in the same org pack whose rules this one inherits (see [extends](#extends)). Default `[]`.                                                                                             |
| `appliesTo.repoTypes`         | no       | Repo types (from the repo manifest) the dialect applies to. Empty (the default) means: only repos whose manifest entry lists the dialect by name.                                                               |
| `appliesTo.marker`            | no       | A glob; the dialect does nothing in a repo where no file matches it. `forge.yaml` means a file at the repo root; `**/forge.yaml` means anywhere.                                                                |
| `layout.sourceRoots`          | no       | Where the source lives, for readers. The engine does not use it: each rule's `files` decides what is read.                                                                                                      |
| `layout.configFiles`          | no       | Globs of the config files `${config:key}` reads (YAML, JSON or `.properties`). When several files set the same key, the file whose path sorts first wins. With no config files, `${config:...}` is never known. |
| `normalize.stripPathPrefixes` | no       | Prefixes (each starting with `/`) removed from the rendered `normalizedPath` and `pathOrTopic` fields of any record, e.g. a context path `/api`.                                                                |
| `lookups`                     | no       | Named tables rules read values from, built from other files of the repo (see [Lookups](#lookups)).                                                                                                              |
| `plugin`                      | no       | A code module for what rules can't express. Leave it out: a dialect written from this kit uses rules only.                                                                                                      |
| `rules`                       | yes      | The rules (at least one).                                                                                                                                                                                       |
| `tests`                       | yes      | The dialect's own tests (at least one). A dialect whose tests fail is not used.                                                                                                                                 |

**When a dialect runs.** In a scan, for a repo whose manifest type is in `repoTypes` or whose manifest entry lists the dialect, and only if the marker matches a file. In `atticus dialect test` and `atticus dialect run`, `repoTypes` is ignored; the marker still applies.

**Globs** are repo-relative with forward slashes: `**` spans any number of folders (including none), `*` stays within one folder name, `?` is one character. No leading `/`, no `..`. Folders `.git`, `node_modules`, `target`, `build`, `dist`, `out`, `.gradle`, `.idea`, `.vscode`, `__pycache__` and `.venv` are never read.

## Rules

```yaml
- id: forge-endpoint # lowercase slug, unique in the dialect
  description: A method annotated @ForgeEndpoint serves a REST endpoint.
  match: { annotation: ForgeEndpoint, target: method, files: ["src/main/java/**/*.java"] }
  emit:
    kind: Endpoint # a kind from c1-kinds.md
    id: "${yaml:forge.yaml#service}.${attr.method | lower}-${member.name | slug}"
    fields:
      component: "${yaml:forge.yaml#service}"
      endpointType: rest
      pathOrTopic: "${attr.path}"
    evidence: { source: code, side: callee } # optional
  confidence: verified # verified or inferred
```

Each place the `match` finds becomes one record, rendered from the templates with the values that place supplies.

### `where`

```yaml
where:
  - { value: "${attr.source}", matches: "tide-kafka-topic" }
```

Optional. Conditions that must all hold for a place to emit: each `value` template is rendered and tested against the `matches` regular expression (unanchored; use `^` and `$` to anchor). A value that can't be filled fails its condition. Use it to narrow a rule to what you mean (a module from one source, an annotation with one attribute value) instead of a file glob.

## Matches

A rule has exactly one kind of match, and every match has `files`: a list of globs to look in.

### `annotation`

```yaml
match: { annotation: ForgeEndpoint, target: method, files: ["src/main/java/**/*.java"] }
```

- `annotation`: the annotation's name, simple (`ForgeEndpoint`) or qualified (`forge.framework.ForgeEndpoint`); either way it is matched by its simple name, however the source writes it.
- `target`: what the annotation sits on: `method`, `field`, `class` (a class, interface, enum, record or annotation type) or `any` (the default). `parameter` is accepted but parameter annotations are not read, so it never matches.
- Supplies `${attr.<name>}` (the annotation's attributes), `${member.name}` (the method or field; not for class targets), `${class.name}` (the enclosing type, or the annotated type itself), `${annotation.<Name>.<attr>}` (an annotation on the enclosing type, or on the type itself for class targets), `${file.path}`, `${file.line}` (the annotation's line).
- Attribute values: a single unnamed value is `value` (`@Topic("orders")` gives `${attr.value}`); concatenated string literals are joined (`"a" + "b"` gives `ab`); a list (`{"a", "b"}`) gives `a,b`; a constant gives its name as written (`Topics.ORDERS`), because constants are not resolved. An empty string `""` is known but empty. An attribute the annotation doesn't have is unknown.

### `baseClass`

```yaml
match: { baseClass: BaseHandler, files: ["src/main/java/**/*.java"] }
```

Types whose `extends` or `implements` list names the type (matched by simple name). Supplies `${class.name}`, `${annotation.<Name>.<attr>}` (annotations on that type), `${file.path}`, `${file.line}`.

### `methodCall`

```yaml
match: { methodCall: bus.publish, files: ["src/main/java/**/*.java"] }
```

- `methodCall`: a method name (`publish`, any receiver) or `receiver.name`, where the receiver is the identifier written before the dot (usually a variable or field name, such as `kafkaTemplate.send`), not its type. `receiverType` (a simple or qualified type name) narrows it to calls whose receiver is a field, parameter or variable declared with that type in the same file (generics allowed), or the type itself for a static call.
- Supplies `${attr.arg0}`, `${attr.arg1}`, ... for arguments that are string literals (or concatenations of literals); other arguments are unknown. Also `${member.name}` (the method the call sits in), `${class.name}`, `${annotation.<Name>.<attr>}` (on the enclosing type), `${file.path}`, `${file.line}`.

### `configKey`

```yaml
match: { configKey: clients.*.timeout, files: [src/main/resources/application.yml] }
```

- A dotted key; `*` matches exactly one segment (no dots). Files ending `.properties` are read as properties, anything else as YAML or JSON, flattened to dotted keys; list items become `key[0]`, `key[1]`.
- Supplies `${match.0}` (the value) and `${match.1}`, `${match.2}`, ... : **the segments of the matched key, counted from 1, not the wildcard's groups**. For `clients.*.timeout` matching `clients.ledger.timeout`: `match.1` = `clients`, `match.2` = `ledger`, `match.3` = `timeout`. `${file.line}` is the key's line.

### `xpath`

```yaml
match: { xpath: "//route[@type='http']", files: ["src/main/resources/routes.xml"] }
```

- A subset of XPath: `/a/b` (from the root element), `//b` (anywhere), `*`, one attribute filter per step (`[@type='http']`), and an optional last step `/@attr` (the attribute's value) or `/text()`. Namespace prefixes are ignored (`//ns:route` finds `<x:route>`).
- Supplies `${attr.<name>}` (the element's attributes) and `${match.0}` (the element's own text, trimmed, or the attribute's value for `/@attr`).

### `jsonPath`

```yaml
match: { jsonPath: "$.jobs[*]", files: [jobs.yaml] }
```

- Over YAML or JSON files: `$.a.b`, `$.a.*`, `$.a[*]`, `$.a[0]`, `$['a']`. Recursive descent (`$..a`) is not supported.
- Supplies `${match.0}` (the matched value when it is a plain value, else empty) and, when the match is an object, `${attr.<field>}` for each of its plain fields.

### `hclBlock`

```yaml
match: { hclBlock: module, files: ["**/*.tf"] }
```

- Terraform (HCL) blocks of a type: `module`, `resource`, `data`... `resource.aws_sqs_queue` also requires the first label. Nested blocks are searched too.
- Supplies `${attr.<name>}` for each plain attribute, resolved the way Terraform would from the folder: variable defaults, then `terraform.tfvars` and `*.auto.tfvars`, locals, and other resources' plain attributes. An attribute of a nested block is `${attr.<block>.<name>}`. A value that still holds `${...}` after resolving is not set.
- Supplies `${match.0}` (the block's last label, its name) and `${match.1}`, ... (its labels in order).

### `syntax`

```yaml
match:
  syntax: |
    (method_invocation
      name: (identifier) @m (#eq? @m "exchange")
      arguments: (argument_list . (_) @service . (string_literal) @verb . (string_literal) @path))
  files: ["**/src/main/java/**/*.java"]
```

- A [tree-sitter query](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/) over the file's syntax tree. **Use it for all code.** It sees code as code: a call in a comment or inside a string is not a call, line breaks and spacing don't matter, and a renamed variable still matches.
- Grammars ship with Atticus: `java`, `kotlin`, `typescript`, `tsx`, `javascript` (JSX too), `c_sharp`, `python`, `go`, `scala`, `ruby`, `php`, `rust`. The file's extension picks one; `language:` sets it.
- Node names come from the grammar. **Look, don't guess**: `atticus dialect tree <file>` prints a file's tree with the names a query uses (`method_invocation`, `argument_list`, `string_literal`). In `atticus onboard`, the sample files come with their trees.
- Each match is a place. `${capture.<name>}` is a capture's text; a string literal's capture is its value without the quotes. The place's line is the first capture's.
- Predicates: `(#eq? @m "exchange")`, `(#match? @m "^(get|post)$")` (on a captured name, not the file's text). `.` anchors a child as first, last or next to another.
- Use a `lookups` table over another query for values defined elsewhere: the repo's constants, a client's base URL. See `examples/house-http-client.yaml`.
- A query that doesn't compile fails the dialect's tests: the dialect never loads.

### `regex`

```yaml
match: { regex: 'QUEUE\s*=\s*"([^"]+)"', files: ["**/*.java"] }
```

- **Deprecated (ADR 0060); never in a drafted dialect, which `atticus onboard` refuses.** For code use `syntax`; for structured files `jsonPath`, `xpath`, `configKey` or `hclBlock`. A JavaScript regular expression over each file's whole text, applied with flags `g` and `m` (`^` and `$` match at line breaks). Use it only when nothing else fits: it can't tell code from comments.
- Supplies `${match.0}` (the whole match), `${match.1}`, ... (groups; a group that didn't take part is empty) and `${file.line}` (where the match starts).

### What each match supplies

`${capture.<name>}` is for `syntax` matches only (rejected for others).

| Template value                             | annotation | baseClass | methodCall | configKey | xpath | jsonPath | hclBlock | regex |
| ------------------------------------------ | ---------- | --------- | ---------- | --------- | ----- | -------- | -------- | ----- |
| `${attr.x}`                                | yes        | no\*      | yes        | no\*      | yes   | yes      | yes      | no\*  |
| `${match.N}`                               | no\*       | no\*      | no\*       | yes       | yes   | yes      | yes      | yes   |
| `${member.name}`                           | yes        | -         | yes        | -         | -     | -        | -        | -     |
| `${class.name}`                            | yes        | yes       | yes        | -         | -     | -        | -        | -     |
| `${annotation.Name.x}`                     | yes        | yes       | yes        | -         | -     | -        | -        | -     |
| `${file.path}` `${file.line}`              | yes        | yes       | yes        | yes       | yes   | yes      | yes      | yes   |
| `${repo.name}` `${config:k}` `${yaml:f#k}` | yes        | yes       | yes        | yes       | yes   | yes      | yes      | yes   |

\* rejected when the file is checked. `-` is accepted but never known, so it leaves its field unset.

## Emit

`emit` is one record, or a list of them: each is rendered, checked and skipped on its own, so one match can give an Endpoint and the GatewayRoute in front of it.

- `kind`: a record kind from `c1-kinds.md`.
- `id`: a template for the record id. Required for every kind except `Interface`, which must leave it out (see [Interfaces](#interfaces)). It must render a valid id (a lowercase slug, at most 120 characters, see [Ids](#ids)); use `lower` or `slug` on anything that may contain capitals or spaces. An id that can't be filled (an unknown value without a default, or empty) means no record, with a warning.
- `fields`: the record's fields. Only fields `c1-kinds.md` lists for the kind are allowed. A value is a template (text), a literal number or `true`/`false`, or a list of templates (items that render unknown or empty are dropped). A field whose template can't be filled is left unset; if that field is required, the record is skipped with a warning naming the rule and the field (`atticus dialect run` prints it). A template that renders the empty string sets the field to `""`, which required text fields reject.
- `evidence` (optional): `source` (default `code`; use `config` for config files, `spec` for descriptors that are specs, or another evidence source: `code`, `config`, `spec`, `gateway`, `event-config`, `infrastructure`, `pipeline`, `migration`) and `side`: `callee` (it serves), `caller` (it calls or publishes), `gateway` or `definition`. The engine adds the repo, file, line and `dialect: <name>@<version>`.

A record that fails contract C1 (a missing required field, a value outside an enum, an invalid id) is reported and never kept.

## Templates

A template is literal text with `${...}` expressions: `"${yaml:forge.yaml#service}.${attr.method | lower}-${member.name | slug}"`. Expressions can't be nested. Filters follow a `|` and apply left to right.

| Value                      | What it is                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${attr.<name>}`           | An attribute of the matched annotation, a call's literal argument (`arg0`, `arg1`...), an XML element's attribute or a JSON/YAML object's field.                                                                                        |
| `${annotation.<Name>.<x>}` | Attribute `x` of annotation `Name` (simple name) on the enclosing type: the class or interface around a matched method or field, or the matched type itself.                                                                            |
| `${member.name}`           | The matched method or field; for a call, the method it sits in.                                                                                                                                                                         |
| `${class.name}`            | The enclosing (or matched) type's simple name.                                                                                                                                                                                          |
| `${config:<key>}`          | A key from `layout.configFiles`. Exact key first, then a relaxed match that ignores case, `-` and `_` (`read-timeout` = `readTimeout` = `read_timeout`).                                                                                |
| `${yaml:<file>#<key>}`     | A dotted key (`a.b`, `items[0]`) from a named repo-relative file, read as YAML or JSON. Works with every match kind. Unknown if the file or key is missing.                                                                             |
| `${file.path}`             | The repo-relative path of the file with the match.                                                                                                                                                                                      |
| `${file.line}`             | The line of the match.                                                                                                                                                                                                                  |
| `${repo.name}`             | The repo's id (in tests: `dialect-test` for inline files, the folder name for a fixture).                                                                                                                                               |
| `${match.<N>}`             | For `regex`: the whole match (0) and groups. For `configKey`: the value (0) and key segments. For `xpath` and `jsonPath`: the value (0).                                                                                                |
| `${capture.<name>}`        | For `syntax`: a capture of the query, a string literal without its quotes.                                                                                                                                                              |
| `${node.key}`              | For `jsonPath`, `xpath` and `hclBlock`: the matched node's key (its field name or array index, element name, or block label).                                                                                                           |
| `${node.up.<field>}`       | A plain field of the nearest object above the match (an XML parent's attribute or leaf child, an enclosing HCL block's attribute). `node.up.up` is the one above that; arrays are stepped over. `node.up.key` is that object's own key. |
| `${lookup:<t>(<key>).<v>}` | Value `v` of the row of lookup table `t` whose key is `<key>`, any template value with filters: `${lookup:servers(attr.name).host}`. Unknown when no row has that key, or two rows give it different values.                            |

| Filter          | Effect                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lower`         | Lower case.                                                                                                                                                                                                                                          |
| `upper`         | Upper case.                                                                                                                                                                                                                                          |
| `slug`          | Lower case; every run of characters other than `a-z`, `0-9`, `.`, `_`, `-` becomes `-`; leading and trailing `-` removed. `Order Placed!` gives `order-placed`.                                                                                      |
| `normalizePath` | Path parameters in any style (`{id}`, `:id`, `<id>`, `${id}`) become `{}`; query and fragment dropped; repeated and trailing `/` removed; leading `/` added. A value with no `/` (a topic name) is returned trimmed. `/a/:id/b?x=1` gives `/a/{}/b`. |
| `trimSlash`     | Leading and trailing `/` removed.                                                                                                                                                                                                                    |
| `default('x')`  | Use `x` when the value is unknown or empty. Without a default, an unknown value leaves the whole field unset.                                                                                                                                        |
| `parent`        | A path without its last segment: `a/b/c.xml` gives `a/b`. Chain it to climb folders.                                                                                                                                                                 |
| `basename`      | A path's last segment: `a/b/c.xml` gives `c.xml`.                                                                                                                                                                                                    |

After rendering, the engine also applies `normalize.stripPathPrefixes` to `normalizedPath` and `pathOrTopic`, and `normalizePath` once more to an Interface's `normalizedPath`.

## Lookups

What a rule needs is often in another file: a proxy names a target server whose host is in an environment file; a route sits inside a service whose URL it needs. A lookup turns places in other files into a table, and a rule reads it.

```yaml
lookups:
  basepaths:
    match: { xpath: "//HTTPProxyConnection/BasePath", files: ["**/apiproxy/proxies/*.xml"] }
    key: "${file.path | parent | parent}" # the bundle folder
    values: { path: "${match.0}" }
  targetServers:
    match: { jsonPath: "$[*]", files: ["**/environments/prod/targetservers.json"] }
    key: "${attr.name}"
    values: { host: "${attr.host}", port: "${attr.port}" }
rules:
  - id: target-server-route
    description: A proxy whose target is a target server routes its base path to that server's host.
    match:
      { xpath: "//HTTPTargetConnection/LoadBalancer/Server", files: ["**/apiproxy/targets/*.xml"] }
    emit:
      kind: GatewayRoute
      id: "gw-${file.path | parent | parent | parent | basename | slug}"
      fields:
        proxy: "${file.path | parent | parent | parent | basename}"
        basepath: "${lookup:basepaths(file.path | parent | parent).path}"
        target: "https://${lookup:targetServers(attr.name).host}:${lookup:targetServers(attr.name).port}"
```

- A lookup has a `match` (any kind), a `key` template and named `values` templates, rendered at each place the match finds. A place whose key can't be filled adds no row.
- Rows with the same key merge; where they give a value different values, it is unknown. When environments differ (dev and prod hosts), read one: the catalog describes production.
- A lookup's templates can't use another lookup. Lookups read the same repo only.
- Lookup values add no evidence: the record's evidence is the rule's match.

## Interfaces

An `Interface` record is one edge: `from` calls `to`. Its id is never written: the engine derives it as `if-` plus the first 16 hex digits of the SHA-256 of `from|to|METHOD|normalizedPath` (method in upper case, empty when unset), so the same edge seen by several extractors becomes one record. Read the derived id from `atticus dialect run` and paste it into your tests.

- `from`, `to` and `normalizedPath` must be filled, or the place is skipped with a warning; `via` and `sync` are required by C1. Use `${annotation.<Client>.<attr>}` to take `to` from the client interface around a method.
- Emit an Interface only when the code names the other service (a client that targets `northwind-pay`). When it doesn't (a URL from config, a topic, a table), emit a loose end instead.

## Loose ends

A call, publish, subscribe or database access whose other end isn't in the repo is an `Unresolved` record. A later merge step resolves it into an interface, or leaves it as a known gap with an owner. Follow the grammar exactly, because merge parses it:

| `unresolvedKind`  | `raw`                         | Example                            |
| ----------------- | ----------------------------- | ---------------------------------- |
| `http-call`       | `METHOD URL`                  | `POST ${payments.url}/v2/payments` |
| `event-publish`   | the topic or channel          | `transfers.completed`              |
| `event-subscribe` | the topic or channel          | `payments.initiated`               |
| `db-access`       | `read TABLE` or `write TABLE` | `read entry`                       |
| `db-connection`   | the connection URL            | `jdbc:postgresql://db:5432/ledger` |

`owner` is the component that holds the loose end (usually the app's name from its descriptor). Ids follow `<component>.<verb>.<what>`, for example `ledger-api.publish.transfers.completed` and `ledger-api.subscribe.payments.initiated`; use `slug` on the topic. Confidence is `inferred`.

## Ids

Ids are lowercase slugs: `a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit, at most 120 characters. They must be stable (the same source gives the same id on every scan) and unique per kind. Prefix them with the component so two apps never collide. Conventions the built-in extractors use, to follow where they fit:

| Kind        | Id                                                                         |
| ----------- | -------------------------------------------------------------------------- |
| Endpoint    | `<component>.<method lower>-<operation>` (Forge: `ledger-api.get-balance`) |
| Unresolved  | `<component>.<verb>.<what>`                                                |
| Setting     | `<component>.<key, or the meaningful part of it>`                          |
| Table       | `<store>.<table>`; Column `<table>.<column>`                               |
| Deployment  | `<component>.<env>`                                                        |
| Alert asset | `<component>.alert.<name>`                                                 |
| Topic       | `topic.<topic>`                                                            |
| Interface   | derived; never written                                                     |

## Confidence

- `verified`: this code or config alone proves the record: an endpoint the service serves, a setting it sets, a queue it consumes.
- `inferred`: one side only (a call whose callee isn't seen), or a loose end.
- `asserted` is not allowed in a dialect: it is reserved for facts a person confirmed.

## extends

`extends: [base]` inherits the rules of dialect `base` from the same org pack: parents' rules first, then this dialect's; a rule with the same `id` replaces the parent's. A missing parent or a cycle is an error, and the dialect can't run. A dialect can't extend itself.

## Tests

```yaml
tests:
  - name: endpoints in a real repo
    fixture: ../../repos/forge-ledger # a folder, relative to the dialect file
    expect:
      - kind: Endpoint
        id: ledger-api.get-balance
        method: GET
    absent: [ledger-api.get-accounts]
  - name: no marker, no records
    files: # inline files: path -> content
      src/main/java/x/A.java: |
        public class A { @ForgeEndpoint(method = "GET", path = "/a") public void a() {} }
    expect: []
```

- Each test has a `name` and exactly one of `files` (inline files) or `fixture` (a folder, relative to the dialect file).
- `expect`: records that must be produced. Each lists `kind` and `id` and any fields to check; every listed field is compared exactly (text is case-sensitive, lists in order). Unlisted fields are not checked. Records are found by `id`.
- `absent`: ids that must not be produced.
- A test with inline `files` and `expect: []` (or no `expect`) passes only if nothing at all is produced: that is how you test that a repo without the marker gives nothing. A `fixture` test with an empty `expect` checks nothing.
- A record that is invalid under C1 fails the test.
- Kong-style nesting is one match per leaf: `$.services[*].routes[*].paths[*]` gives one place per path, `${match.0}` the path, `${node.up.name}` the route's name and `${node.up.up.url}` the service's URL.
- Every rule of the dialect's own (not ones it inherits through `extends`) must produce at least one record in at least one test, or the dialect fails with `rule <id> produces nothing in any test`. A dialect whose tests fail is never used by a scan.
- Tests ignore `repoTypes`; the marker still applies, so inline tests must include the marker file.
- Failure messages: `expected Endpoint x.y, got a, b` (not produced; lists what was), `x.y.method: expected "GET", got "get"`, `x.y should not be produced`, `expected no records, got ...`, `produced an invalid record: ...`, `rule r produces nothing in any test`.

## Limits worth knowing

- The Java reader is lexical: it sees annotations, declarations and calls as written, skips comments, and does not resolve imports, types or constants.
- If two places produce the same kind and id, the first is kept and a warning is printed.
- Rules run in order of rule id; the order of records doesn't matter.
