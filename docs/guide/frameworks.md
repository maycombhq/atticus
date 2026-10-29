# Teaching Atticus your house frameworks

Teams rarely call Spring, Express or `fetch` directly. They use a house layer: a starter whose `@InternalApi` stands for `@RestController`, a `bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")` wrapper, a React hook `useApi({ service, path, method })`, a BFF's `defineRoute({ method, path })`. Until Atticus knows what those mean, the catalog misses the endpoints and calls behind them. A **framework model**, `org-pack/frameworks/<name>.yaml`, tells it (ADR 0054, 0055). One model covers every repo that uses the framework, in any language.

Pick the way in that matches what you have. They combine: each keeps what the others added.

| You have                                 | Do                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The framework's source                   | `atticus frameworks learn <name> --from <its repo>`, Java or JavaScript/TypeScript. Entries are read from code and make verified facts.                         |
| Only its JAR                             | `atticus frameworks learn <name> --from <starter.jar>`, or `atticus frameworks discover --group <your.group> --learn` to find the JARs your repos use.          |
| Only its npm package (JS or TS)          | `atticus frameworks learn <name> --from <package.tgz>` reads its typings, or `atticus frameworks discover --group @your-scope --jars <folder of .tgz> --learn`. |
| Documents, a wiki, or people who know it | Write the model by hand, or have an assistant draft it with the kit (below). Entries cite their source and make inferred facts.                                 |
| The source, and repos that use it        | `atticus onboard framework <name> --from <source, JAR or package> --users <repos>`: learned first, your assistant drafts the rest, checks decide (below).       |
| Nothing yet                              | `atticus frameworks survey --package <your prefixes>` shows which house modules the repos import and how they call them. Start with the most used.              |

## What each repo is built on

A read records the frameworks a repo is built on, one fact each, cited on the line of the build file that declares it (ADR 0124 addendum A-framework). `spring-boot 3.3.4` on the parent pom's `<artifactId>`, `asp.net net8.0` on a csproj's `Sdk=`, `express 4.19.2` on a `package.json` line, `rails 7.1.4` on a Gemfile's `gem`, `django 5.1.1` on a requirement. Where the version isn't on that line — a `<properties>` entry, a parent pom, a `<TargetFramework>` — the line that writes it is cited beside it, and the verifier checks both. A module that declares its own framework (ADR 0057) records it against that module.

You see it in three places: `map.md` says **Built on** above the trust line, each framework linking to the line that declares it; the Map's Trust tab says it for every repo in the estate; and `atticus verify <repo>` prints it with the report. Nothing is guessed: a repo nobody has read yet says nothing at all.

Three things follow from it.

- **The reading prompts carry the rules of your frameworks, and not of the others.** A batch's prompt already carried only the rules its kinds of file need; now it carries only the frameworks the repo declares too. A Spring repo gets JPA's table naming and Spring Data REST's paths; it no longer carries Django's `app_label`, Rails' pluralisation, ASP.NET's MVC route or TypeORM's join tables. A front end gets its own router's rules and nothing of the back end's frameworks. Before the first read, when no fact says yet, the repo's `type` in `repos.manifest.yaml` is the hint; once a framework fact is on file, the facts say and the manifest doesn't.
- **A framework whose patterns are nowhere in the facts is a question for a person.** A Spring Boot repo with no REST entry, a React app with no screen, a Sidekiq dependency with no `batch-job`: `atticus verify` says so (under `frameworkGaps` in the report), the map puts it in the open and the Trust tab marks it. It usually means the real entry points were missed. It is never a rejection and never a fact about the repo: the facts can't say which it is, so a person does.
- **A house framework becomes a prompt to learn it.** A framework fact whose artifact is neither one Atticus knows nor one your org pack's framework files cover is offered to you as `atticus frameworks learn <name> --from <repo>` — the paths above. Until then the reading prompts tell the assistant that one of its annotations, base classes or wrapper clients may serve a route or read a table with nothing in the repo's own code to show it, and to write a question naming the annotation rather than a guess.

A repo's type in the manifest follows the facts too: a framework a repo's own facts declare settles the type (`spring-boot`, `dotnet`, `frontend`, `node`, `python`) ahead of anything guessed from the files, because it was read from a build file's line and that line was checked.

## Cloud resources in Terraform

Atticus reads common AWS, Azure and Google Cloud resources from Terraform in any repo with a `.tf` file, through three dialects it ships: `terraform-aws`, `terraform-azure` and `terraform-gcp` (ADR 0063). Each file's header in `packages/extractors/dialects/` lists the resource types it reads and the records they give: topics, queues, databases and other stores, functions, deployments and gateway routes. Names are resolved from variables, `terraform.tfvars`, `*.auto.tfvars` and locals, and through your local modules: `module "orders_queue" { source = "../modules/queue" name = "orders" }` gives the module's resources named with `orders`, once per instantiation.

To change what a resource type gives, copy the shipped file into `org-pack/dialects/` under the same name and edit it: the org pack's replaces the shipped one. A house module from a registry or a git URL is a `module` block a dialect of your own matches (`hclBlock: module` with a `where` on its `source`).

## Apigee gateways

You don't need a model or a dialect for an Apigee gateway: `/atticus-map` (and each `atticus map` batch holding a bundle's files) tells the assistant how to read one (ADR 0124 addenda A-gateway and A-gateway2). Type the gateway's repo `gateway` in `repos.manifest.yaml` and list the host callers use under `hosts:`. When each proxy is a repo of its own on one shared gateway host, list that host on every proxy repo: the path a call uses picks the repo. A gateway that faces partners or the internet can be typed `gateway-external` (and one that stays inside `gateway-internal`), so every hop through it is marked.

- **Routes.** Each conditional `<Flow>` of a proxy is an entry of the gateway: the method from `request.verb`, the path the `<BasePath>` and the `proxy.pathsuffix` pattern joined (`/forge/v1/accounts/{id}`), cited on the `<Condition>` with the `<BasePath>` line beside it.
- **Auth.** The strongest check that runs before the target, in the flow, the PreFlow or a shared flow a FlowCallout calls: OAuthV2 or VerifyJWT is `oauth2`, VerifyAPIKey `api-key`, BasicAuthentication `basic`, cited on the `<Step>` that attaches it. SpikeArrest and Quota are rate-limit settings. The verifier opens the policy the citation names and refuses an auth it cannot set: a `VerifyAPIKey` never makes `oauth2`, and a `SpikeArrest` authenticates nobody.
- **Scopes.** The scopes a route demands are read with it: an OAuthV2's `<Scope>` (a space-separated list is one scope each, all citing that line), a VerifyJWT or VerifyAccessToken scope claim, a scope a `Condition` asserts on the token's claims, or the scopes a shared flow it calls checks. Each is cited on the line that names it, each is checked like any other claim, and each ends up on the GatewayRoute. A route that demands none says so by leaving them out. A proxy's `<VirtualHost>` is recorded too, so a hop can be called internal or external without guessing.
- **Where it goes.** Each route's forwarding call has the path the service receives: the base path dropped, or the path an AssignMessage or JavaScript policy sets when `target.copy.pathsuffix` is false. Its host comes from the TargetServer (`targetservers.json`) or KVM entry it names.

Once the gateway, its callers and the services behind it are read and verified, `atticus join` links a UI back end's call to the service the route forwards to, at the rewritten path, `via: gateway` with the route's auth and its scopes.

**Chains.** A route that forwards into another gateway is followed too, so a call reads
`caller → internal gateway → partner gateway → the vendor's service`, with each hop in order: its
own auth, the scopes it demands, and whether it faces inside or out. `map.md`'s call lines and the
app's Interface page print the whole path, and each hop is a GatewayRoute of its own whose target
is the next hop. The walk is bounded: a ring of routes that forward back into a gateway already in
the path is a question, never a loop, and so is a chain longer than four gateways. When a
TargetServer's hosts differ by environment and point at different repos, you're asked which one is
meant and the call stops at the last gateway the facts settle.

**The critic** reads the auth and the scopes: a route through the gateway that demands no scope is
a finding, a scope a story's criteria name that no route demands is a finding, and a caller whose
own callers' tokens hold none of the scopes a hop downstream demands is a question. Nothing from
the old gateway reader is needed.

### Apigee: naming your consumers

A proxy usually says who it lets in, and Atticus reads that from the gateway repo's own files
(ADR 0124 addendum A-callers). Each route records the consumers it can name, each cited on the
line that names it, with the line tying it to the route beside it:

- **`product`**: the API product whose `proxies` list holds the route's proxy
  (`resources/edge/org/apiProducts.json`).
- **`app`**: a developer app subscribed to that product (`resources/edge/org/developerApps.json`),
  or one a `Condition` on `developer.app.name` lets in.
- **`client-id`**: a client id a `Condition` on `verifyapikey.<policy>.client_id` or `client_id`
  admits, or one a KVM or allowlist file in the repo lists.
- **`subject`**: a certificate subject an mTLS check admits.

The verifier checks each like any other claim, so a consumer no line names never reaches the
catalog. In the catalog each one is an `AccessGrant` on the route's GatewayRoute (its `flags` say
which kind), and the route's API product fills the GatewayRoute's `product`. `map.md` prints the
callers on each route's line: `callers app forge-ops-console, product forge-refunds`, the
components whose calls go through it (`callers shop-bff`), or `callers unknown`.

Keep the product and app definitions in the gateway repo if you can. Apps that live only in the
Apigee console can't be read; declare their systems instead (below).

### Declaring a caller you can't scan

When a flow starts in another team's product whose repo you will never scan, say so in the org
pack's profile, where every system a person declares already lives. Add the product under
`systems:` with its boundary (`internal` or `product`) and its owner, and say what it calls as
the gateway knows it:

```yaml
# org-pack/profiles/<platform>/profile.yaml
systems:
  - id: harbor-desk
    name: Harbor Desk
    boundary: internal
    owner: team-harbor
    calls:
      - { as: app, name: harbor-desk-portal } # the developer app the proxy names
      # or a route itself: { route: forge-refunds-v1/CreateRefund } or { route: POST /forge/refunds/v1/refunds }
```

When the route's files name that app, the declaration is linked to it ("app `harbor-desk-portal`
on the route's API product is Harbor Desk"). It stays your word wherever it shows (`declared`,
an `asserted` Interface with your profile as its evidence) and never replaces anything read from
code: an app you name that the files don't is shown as yours alone, and a declaration no route
can be placed on is reported, not guessed. The join then reads the whole chain from it:

`Harbor Desk (declared; app harbor-desk-portal) → edge-gateway forge-refunds-v1 (oauth2; scopes refunds.write; internal) → refunds-api POST /refunds → partner-gateway northwind-refunds-v1 (oauth2; scopes northwind.refunds.write; external) → northwind-pay-api POST /v2/refunds`

**The critic** lists every caller a route names or you declared as affected when a change alters
what the route carries (its path, method, a required field or a scope), beside the catalog's
other consumers. A route with **callers unknown** — no consumer in its files, nobody declared,
no call the catalog holds — becomes a question for the change that touches it ("Who calls … through
…?"), asked of the owner. Answer it by declaring the caller here, or by adding the app to the
gateway's files.

## Repos Atticus can't read yet: onboard them

`atticus scan` names the repos it read nothing from though they have config files no reader knows (a gateway's routes, a house Terraform module, a pipeline template). For each:

1. `atticus onboard <repo>` has your organisation's assistant draft a dialect. Atticus checks every draft (valid, its own tests pass on samples from the repo, it reads the repo) and hands back what failed, up to three attempts.
2. A draft that passes is a proposal in `proposals/dialects/`. Nothing scans with it yet.
3. Review the rules and their tests, then `atticus onboard accept <name>`, and commit the org pack.

The assistant is whatever `runtime.yaml` allows. With `hand-off`, your own assistant writes the draft; save it in `proposals/dialects/` and run `atticus onboard check <name> --repo <repo>`.

## House frameworks with no model: onboard them

`atticus scan` names the house frameworks several of your repos import that no model covers: modules in your organisation's own namespace (the roots of the packages, namespaces and npm scopes your repos declare, such as `tide` or `@tide`) that two or more repos import without declaring them. It prints the command for each:

```text
House framework harbor.kit is imported by 2 repos and no framework model covers it: harbor-billing, harbor-orders. Onboard it: atticus onboard framework harbor-kit --from <its source, JAR or package> --users harbor-billing,harbor-orders
```

1. `atticus onboard framework <name> --from <its source folder, JAR or .tgz> --users <repos that use it>` (ADR 0066). Leave out `--users` and the cloned repos that import its packages are used.
2. Atticus's learner reads the framework first. What it reads from code or bytecode is a verified fact, and no draft may change it.
3. Your organisation's assistant drafts only what the learner couldn't read: the base URLs behind service ids (often in a properties file or a registry), wrapper methods whose parameter names don't say which argument is the method or the path, and what pipeline templates or Jenkins shared-library steps do (give the template repo or the library as `--from`, with `--package` for the prefix its users import, if any). Every drafted entry cites the file or person it came from.
4. Atticus checks every draft (valid, its own tests pass, nothing learned is changed, drafted entries cite a document or person, and the repos that use it give something with it that they don't without it, with no invalid record) and hands back what failed, up to three attempts (`--attempts`).
5. A draft that passes is a proposal in `proposals/frameworks/`. The command lists what it reads in each repo, marks what came from drafted entries, lists entries that change nothing there, and names the drafted entries to review first. Nothing scans with it yet.
6. Review it, then `atticus onboard accept framework <name>` (`--replace` over an existing model), and commit the org pack.

With `hand-off`, the learned model is left in `proposals/frameworks/<name>.yaml` for your assistant to add to; then `atticus onboard check framework <name> --from <source> --users <repos>`. With AI off (or `--no-ai`), the learned model alone is checked and proposed.

**When a model stops reading.** If a model reads nothing in a repo that imports its packages (the framework renamed an annotation or changed its client), `atticus scan` says so and gives the command to re-draft it; accept the new one with `--replace`. The current model is given to the assistant as data, so entries a person added can be carried over; check the proposal keeps the ones you still want.

What this doesn't do: the learner doesn't read pipeline templates or Jenkins libraries (the assistant drafts those entries from their files); a framework used only through configuration or a build plugin, with no imports, isn't named by the scan; and a value no file holds (a URL only a person knows) can't be drafted: add it by hand, citing the person.

## Drafting a model with an assistant

1. `atticus frameworks kit` writes the framework-model kit: the guide, two worked examples (a Java starter and a React/Node framework), the schema, a checklist and a task prompt.
2. Give the kit, the survey and whatever documents you have to your organisation's assistant. It writes the model **with tests**: sample files copied from real uses and the records they must give.
3. `atticus frameworks check <name>` runs the tests. It fails when a test gives the wrong records, or when an entry the assistant wrote is exercised by no test.
4. A person reviews the file and commits it to the org pack. A draft is used only once it is in the org pack, and only while its tests pass.

**`/atticus-map` reads with what you've taught.** When a repo's build file (pom.xml, build.gradle, package.json, a .csproj, requirements.txt, pyproject.toml or go.mod) names one of a model's `artifacts`, `atticus map --estimate` lists that framework and what it stands for, and each batch's instructions carry it: its wrapper methods and which argument is the method, path and service, its routes, what its annotations stand for, its service ids and its path-like constants. The reader then writes a call through a wrapper as a `call` fact on the line that makes it, and marks `conf: inferred` a value that comes only from the model. This holds for every model in `org-pack/frameworks/`, however it was made.

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
