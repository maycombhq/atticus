# Teaching Atticus your house frameworks

Teams rarely call Spring, Express or `fetch` directly. They use a house layer: a starter whose `@InternalApi` stands for `@RestController`, a `bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")` wrapper, a React hook `useApi({ service, path, method })`, a BFF's `defineRoute({ method, path })`. Until Atticus knows what those mean, the catalog misses the endpoints and calls behind them. A **framework model**, `org-pack/frameworks/<name>.yaml`, tells it (ADR 0054, 0055). One model covers every repo that uses the framework, in any language.

Pick the way in that matches what you have. They combine: each keeps what the others added.

| You have                                 | Do                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The framework's source                   | `atticus frameworks learn <name> --from <its repo>`, Java or JavaScript/TypeScript. Entries are read from code and make verified facts.                         |
| Only its JAR                             | `atticus frameworks learn <name> --from <starter.jar>`, or `atticus frameworks discover --group <your.group> --learn` to find the JARs your repos use.          |
| Only its npm package (JS or TS)          | `atticus frameworks learn <name> --from <package.tgz>` reads its typings, or `atticus frameworks discover --group @your-scope --jars <folder of .tgz> --learn`. |
| Documents, a wiki, or people who know it | Write the model by hand, or have an assistant draft it with the kit (below). Entries cite their source and make inferred facts.                                 |
| Nothing yet                              | `atticus frameworks survey --package <your prefixes>` shows which house modules the repos import and how they call them. Start with the most used.              |

## Repos Atticus can't read yet: onboard them

`atticus scan` names the repos it read nothing from though they have config files no reader knows (a gateway's routes, a house Terraform module, a pipeline template). For each:

1. `atticus onboard <repo>` has your organisation's assistant draft a dialect. Atticus checks every draft (valid, its own tests pass on samples from the repo, it reads the repo) and hands back what failed, up to three attempts.
2. A draft that passes is a proposal in `proposals/dialects/`. Nothing scans with it yet.
3. Review the rules and their tests, then `atticus onboard accept <name>`, and commit the org pack.

The assistant is whatever `runtime.yaml` allows. With `hand-off`, your own assistant writes the draft; save it in `proposals/dialects/` and run `atticus onboard check <name> --repo <repo>`.

## Drafting a model with an assistant

1. `atticus frameworks kit` writes the framework-model kit: the guide, two worked examples (a Java starter and a React/Node framework), the schema, a checklist and a task prompt.
2. Give the kit, the survey and whatever documents you have to your organisation's assistant. It writes the model **with tests**: sample files copied from real uses and the records they must give.
3. `atticus frameworks check <name>` runs the tests. It fails when a test gives the wrong records, or when an entry the assistant wrote is exercised by no test.
4. A person reviews the file and commits it to the org pack. A draft is used only once it is in the org pack, and only while its tests pass.

**A scan uses a model only while its tests pass.** A failing model is left out, and the scan's problems say which test failed. A model with no tests is used as written, so hand-written models keep working; add tests so a wrong entry can't go unnoticed.

## What a model can say

- `annotations` (Java, Kotlin): a house annotation and the Spring annotations it stands for, with its attribute mapping.
- `clients` (Java, Kotlin): a wrapper type's method that makes an HTTP call.
- `calls` (JavaScript and TypeScript, C#, Python, Go): a function that makes an HTTP call or publishes or reads an event or queue.
- `routes` (same languages): a function that registers a route the code serves.
- `services` and `constants`: what service ids and the framework's constants stand for.
- `pipeline` (ADR 0062): what a platform team's pipeline template or Jenkins shared-library step does. Name a template with `uses` (a Harness `templateRef`, `deploy.yml@templates`, a GitHub action or reusable workflow) or a library step with `step` (with `environmentFrom` for the argument that names the environment), and list what it adds: `stages`, `environments`, `deployTargets`, `testSteps`. A pipeline that uses it gains these, and its `details.modelled` names the entry and its source.

```yaml
pipeline:
  - uses: org.tide_release
    stages: [Release notes, Change record]
    source: { kind: person, ref: "@tide-platform" }
  - step: deployToProd
    environmentFrom: env
    deployTargets: [helm]
    source: { kind: code, ref: tide-pipelines/vars/deployToProd.groovy }
```

Every entry records where its meaning came from (`code`, `bytecode`, `document` or `person`); only code and bytecode make verified facts.
