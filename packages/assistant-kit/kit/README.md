# Writing an Atticus dialect

This kit is everything you need to write a **dialect**: a YAML file that teaches the Atticus scanner an organisation's in-house framework. You will not need anything else, and you can't ask the people who built Atticus.

## What Atticus does with a dialect

Atticus scans every repository in an estate and writes a **catalog**: one small YAML record per fact it can prove from code and config, such as an endpoint a service serves, a call from one service to another, a setting, a table. Every record has a `kind` (contract C1, listed in `c1-kinds.md`), a stable `id`, field values and evidence (repo, file, line).

Built-in extractors already understand common technology: Spring (controllers, Feign, RestTemplate, WebClient, Kafka, JDBC), OpenAPI and Swagger files, Apigee-style gateway proxies, frontend `fetch`/axios/HttpClient calls, topic configs, SQL migrations, Kubernetes and Terraform. Anything home-grown is invisible to them: a company's own `@Endpoint` annotation, its service descriptor file, its client interfaces, its config conventions, its house Terraform modules, Helm values and pipeline templates. A dialect closes that gap **without code**: each rule says "where you find this in the source, emit that record".

Write a dialect when an organisation has repos built on a house framework (annotations, base classes, descriptor files, XML or YAML config) whose meaning the built-in extractors can't know.

## What is in the kit

| File                       | Read it                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `README.md`                | First: what a dialect is and the workflow.                                                              |
| `c2-reference.md`          | While writing: every field of the dialect file and exactly how the engine behaves. The source of truth. |
| `worked-example.md`        | Before your first rule: a complete real dialect (Forge), explained rule by rule.                        |
| `examples/*.yaml`          | Three gateway dialects (Apigee target servers, Kong, Azure APIM): lookups, `${node.up...}`, tests.      |
| `c1-kinds.md`              | When choosing a record kind: every kind and the fields a rule may set (generated from the schema).      |
| `cli.md`                   | The commands you may run.                                                                               |
| `checklist.md`             | Before you say you are done.                                                                            |
| `prompts/write-dialect.md` | A ready task prompt, if you were handed this kit without one.                                           |
| `dialect.schema.json`      | The dialect file's JSON Schema (generated from the schema), for editors and validators.                 |

## The workflow

1. **Survey the repos.** Run `atticus dialect new <name> --from <repo> <repo> ...` over a few repos that use the framework. It writes `org-pack/dialects/<name>.yaml` with the marker file every repo shares, the layout, every annotation with counts, attributes and a sample line, the descriptor's keys and the config keys, plus one commented candidate rule per framework annotation. It never overwrites a file.
2. **Read the source.** Open the files the survey points at. For each framework construct, decide what it means: does the app _serve_ something (an `Endpoint`), _call_ a named service (an `Interface`), _publish, consume or call_ something whose other end isn't in the repo (an `Unresolved` loose end), or _configure_ something (a `Setting`)? `c1-kinds.md` lists every kind.
3. **Pick the marker.** A file every repo on the framework has and other repos don't (usually a descriptor at the root, such as `forge.yaml`). It makes the dialect apply only where it should, and it is usually where the app's own name comes from: `${yaml:forge.yaml#service}`.
4. **Write the rules.** One rule per construct: a `match` (where to look), an `emit` (the record kind, an id template and field templates) and a `confidence`. Take every value from the source with templates; never write a repo's own names, paths or values into a rule, because the dialect must work on repos you haven't seen.
5. **Look at the output.** `atticus dialect run <name> <repo>` prints the records your rules produce from one repo, ready to paste into a test, with warnings for templates that could not be filled and the reason any record is invalid. Interface ids are derived (`if-<hash>`): copy them from this output.
6. **Write tests.** At least one test over a real repo (a `fixture` folder) that checks a record of every kind the dialect emits, small inline tests (`files`) for each edge case you noticed (attribute order, lower-case values, path parameters), and one inline test with no marker file and `expect: []` showing that nothing is produced.
7. **Run the tests.** `atticus dialect test <name>` until it passes. It also fails when a rule produces nothing in any test. A dialect whose tests fail is never used by the scanner.
8. **Self-review** with `checklist.md`.

## Ground rules

- **Deterministic.** A dialect reads repo files only. Same files, same records.
- **Generic.** Rules describe the framework, not the repos you looked at. Test with values from the repos; never put them in rules.
- **Honest confidence.** `verified` when this code or config alone proves the record (an endpoint a service serves, a setting it sets); `inferred` when it shows only one side (a call whose callee isn't seen, a loose end). Never `asserted`: that is reserved for people.
- **The engine owns some fields.** A rule never sets `kind`, `id` (it uses `emit.id`), `schemaVersion`, `status`, `confidence` or `evidence` inside `fields`.
- **No half-filled values.** When a template refers to something that isn't there, the field is left unset rather than filled with a fragment; an id that can't be filled means no record (a warning in `dialect run`).

## A minimal dialect

```yaml
schemaVersion: 1
name: acme
version: 0.1.0
description: Acme services name themselves in acme.yaml and serve endpoints with @AcmeRoute.
appliesTo:
  marker: acme.yaml
layout:
  configFiles: [src/main/resources/application.yml]
rules:
  - id: acme-route
    description: A method annotated @AcmeRoute serves a REST endpoint.
    match:
      annotation: AcmeRoute
      target: method
      files: ["src/main/java/**/*.java"]
    emit:
      kind: Endpoint
      id: "${yaml:acme.yaml#name}.${attr.method | lower}-${member.name | slug}"
      fields:
        component: "${yaml:acme.yaml#name}"
        endpointType: rest
        method: "${attr.method | upper}"
        pathOrTopic: "${attr.path}"
        normalizedPath: "${attr.path | normalizePath}"
      evidence: { source: code, side: callee }
    confidence: verified
tests:
  - name: a route
    files:
      acme.yaml: "name: quotes\n"
      src/main/java/q/Quotes.java: |
        public class Quotes {
          @AcmeRoute(method = "get", path = "/quotes/{id}")
          public Quote one(String id) { return null; }
        }
    expect:
      - kind: Endpoint
        id: quotes.get-one
        method: GET
        normalizedPath: /quotes/{}
  - name: no acme.yaml, no records
    files:
      src/main/java/q/Quotes.java: |
        public class Quotes {
          @AcmeRoute(method = "get", path = "/quotes")
          public Quote all() { return null; }
        }
    expect: []
```
