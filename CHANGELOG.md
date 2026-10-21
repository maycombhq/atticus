# Changelog

All notable changes to Atticus. Versions follow [Semantic Versioning](https://semver.org); contracts C1 to C6 change only with an ADR, a schema version and a migration (`atticus upgrade`).

## Unreleased

### Repo specs made of flows

- A new C1 kind, `Flow` (ADR 0079), with its own schema version 1: a trigger, ordered steps (entry, lookup, read, write, call-out, publish, transform, validate, branch, log, respond, loop, retry) with the data at each step by field, the table and columns a step reads or writes, where a call-out goes, error paths, a family of near-identical triggers, and a citation and `confirmedBy` (check, AI pass or person) on every step. Flows live in the metarepo at `specs/<repo>/<id>.yaml` with a header in `specs/<repo>/spec.yaml`.
- A repo type can carry a spec template, `repo-types/<id>/spec-template.yaml` (C6): which triggers a repo of the type has and where the catalog lists them, what each step kind must record, and how flows group into families. A built-in default template is used otherwise.
- `atticus spec draft <repo>` has your assistant write one flow per trigger from the catalog, the template, the repo type's skills and the answered questions. Each flow is checked (schema, every cited line, every catalog id, call-out targets, writes) before it is written; what fails goes back. It asks a person what the code doesn't settle. Later runs draft only what changed or failed.
- `atticus spec check <repo> [--json]`: the deterministic critic. Every trigger has a flow, every cited line exists, a call-out's target and a write's table and columns are in the catalog, a field doesn't appear from nowhere, and a step's claim is on its cited line (which marks the step confirmed by the check). A finding that comes back unchanged after a redraft becomes a question.
- `atticus bench run --specs` also scores drafted specs against the bench's reference flows (`bench/flows/`): triggers covered, steps matched in order, tables and fields named, citations correct.

### Repo types, matched by fingerprint

- A new org-pack folder, `repo-types/<id>/type.yaml` (ADR 0077, C6). It holds what a kind of repo looks like (build files, dependencies, framework markers and folders, each with a weight), the scan settings every repo of the kind gets (written as patterns), and the skills for reading it.
- `atticus repo-type detect <repo> [--json]` scores the repo against every type and cites the file or line behind each signal. It says whether the match is clear, partial, none or a tie.
- `atticus repo-type new <id> --from <repo>` drafts a type from a repo, with no AI, for a person to edit.
- `atticus scan survey` gives your assistant the matched type's settings (resolved on the repo and checked) and its skills.

### The estate as one graph, opened a level at a time

- Local API (ADR 0081): `GET /api/graph/node/{id}` gives one node of the estate (estate, system, repo, component, endpoint, topic, client, store, table, deployment) with its children, its breadcrumbs and its edges, merged with a count and each with its evidence as `path:line` and its gaps; `?lens=` picks architecture, repo, data, integration or infrastructure; "uses" edges are the transitive reduction unless `?all=1`. `GET /api/graph/focus/{id}` gives a node and its neighbours. `GET` and `PUT /api/graph/layout/{view-key}` read and keep a view's arrangement in `diagrams/layouts/<view-key>.yaml` (C6, a new metarepo file).
- The app's new Architecture screen opens the estate through it: a lens switcher, breadcrumbs, the picture of the open node, an outline for the keyboard and screen readers (Tab, Enter to open, Escape to close), and a details panel with the evidence and the command for the next step. The picture is today's read-only canvas: dragging, zoom, the minimap and "keep this arrangement" come with the new canvas.
- `scoreLayout` and `LAYOUT_LIMITS` in `@maycombhq/diagrams` measure a laid-out view against the diagram spike's limits.

### Client base URLs in scan settings

- Scan settings (`org-pack/scan/<repo>.yaml`) take `clients` (ADR 0076): a base URL in front of the HTTP calls in the files an entry covers, for calls built from a name the entry lists (`environment.REST_API_URL`) and for paths with no host (an interceptor puts the base in front). Each entry cites the line the base is written on; the scan refuses one whose line doesn't say it, whose base isn't that value, or whose names aren't in its files. A resolved call cites both its own line and the base's.
- The frontend reader now records calls built from a configured base, with the base's expression: `GET ${environment.REST_API_URL}owners/{id}`, following class fields such as `this.entityUrl`; Angular `HttpClient` calls with type arguments (`this.http.get<T>(...)`); requests through an axios instance the repo makes (`api.get("/comments")` with `api = axios.create({ baseURL })`), also when imported by an alias such as `@/lib/api-client`; and `"/profiles/" + name` as `/profiles/{name}` (before, only `/profiles/`). msw mock handlers are no longer read as calls.
- `atticus scan survey` asks your assistant for client bases too, shows it the calls whose base the readers couldn't know, and checks its answer.
- Without settings, such calls are recorded but don't join anything; on the bench that shows as wrong calls until the repo is surveyed.

### Scanner plugins, pinned and sandboxed

- When a rule file can't say how to read an organisation's code, a scanner plugin can (ADR 0080): `org-pack/plugins/<id>/` holds `plugin.yaml` (what it emits, the repo types or dialects it applies to, its time and memory limits, the sha256 of its entry file), the plain JavaScript code, and golden tests in `test/<case>/`.
- The scan uses a plugin only when its code matches the pin and its tests pass, and runs it after the built-ins, in a worker thread with its own limits. It reads files only through the scan, and can't import anything, use Node, reach the network, start a process, compile code from strings, or read the clock. A plugin that tries, runs too long or uses too much memory is stopped and reported as a scan problem; the scan goes on.
- `atticus plugin test <id>` runs a plugin against its golden files; `atticus plugin pin <id>` writes its entry file's sha256 into `plugin.yaml`.
- Node's `vm` is not a hard security boundary; ADR 0080 lists what is enforced and what an OS-level boundary would add.

### You are your Git user; approving is the pull request

- Atticus knows you by the metarepo's Git user (`git config user.name` and `user.email`, ADR 0073). The app shows it in the top bar and every command records it; `--by <handle>` is now an optional override everywhere it was required (`change new`, `change handoff`, `finding`, `baseline`, `todo done`, `task run`, `glossary`, `initiative`, `outcome record` and the rest), and `digest --as` likewise. With no Git user, the OS user name stands in with a warning that says how to set it.
- No roles in the app: one sidebar and one Home for everyone, one tour. The view picker, role homes, role navigation and tours, and Settings' group-to-role mapping are gone, and so is "Groups are mapped to roles" in the setup checklist. `.atticus/me.yaml` keeps only your digest settings.
- No in-app approvals: a gate is approved when its hand-off PR merges, and the Git host's rules decide who may approve. `atticus change status` names the PR to merge instead of "Approvals needed"; `change handoff`, `change sync` and `change return` are a dry run until you add `--approve`. Approve buttons, "approvals waiting on you" and the role checks on waivers and on accepting the baseline are gone; a waiver, the baseline and release go / no-go are files recorded with your name that reach main through a pull request, and each command says so.
- Every write to the Git host, work tracker, service desk or notifications still needs your explicit `--approve` (or a button that says what it sends).
- Local API 2.0.0: `PUT /api/me` and `GET /api/me/approvals` are removed; `GET /api/me` returns your Git user (`user`, `name`, `email`, `source`, `warning`).
- `roles.yaml` is deprecated (C6): it still loads and validates, nothing reads it, and `atticus init` no longer writes it; nor are gate `approvers`, change-type `approvals` or the change policy's `privacy.role`, `risk.approvals` and `selfApproval` read. Move those rules to branch protection and CODEOWNERS.

### Scan review

- `atticus scan review <repo>` (ADR 0072): the gaps the last scan left (files no rule reads, unresolved calls and data access, modules where it found nothing) go to your assistant, which gives each a verdict (a rule can read it, an Atticus reader misreads it, a vendor, ignore, or a person must say) and writes a dialect for the readable ones. Every verdict and the dialect are checked against the repo before anything is written; a person accepts the dialect and the next scan reads with it. `--gaps` lists the gaps alone.
- The SQL reader no longer takes `IS DISTINCT FROM`, a CTE's name or `information_schema` tables as tables (found by the first scan review).

### Domain profiles from the catalog

- `atticus domain profile <system> [--out file]` (ADR 0071): a system's domain profile filled from the catalog: components and repos, interfaces with their consumers, data with who reads and writes it, related domains, features, and an evidence register of every claim. What code can't tell (owners, controls, retention) is Unknown and asked as an open question. An organisation's own layout goes in `org-pack/templates/domain-profile.md`.
- ASP.NET Core actions named `GetUserAsync` route as `getuser`, as ASP.NET Core does by default.

### Draft a change from its brief and the map

- `atticus change draft <change>` (ADR 0070): your assistant drafts the OpenSpec proposal, spec delta and interfaces from the brief and the part of the catalog the change is about, picked without AI. Atticus checks the draft (every system, call and interface is in the catalog or marked new, every requirement has a scenario) and sends problems back before anything is written.
- `atticus plan stories --draft` writes draft stories before the design is approved.
- In the app, calls inside one box are counted on it instead of drawn as a loop, and every graph draws on the layered canvas.

### A repo's own HTTP helpers are followed

- The frontend reader follows the helpers a repo writes around fetch and axios (ADR 0069): `post("reports")` through `post(path)` → `http(\`/api/${path}\`, { method: "POST" })`→`fetch(BASE + path)`reads as`POST /api/reports`, verified from code, across files through relative imports. An app with its own thin client now gives its calls, so its API's endpoints are entry points and features are found.
- Each module's component takes its type from its own build file: a React module in a Maven repo is `frontend`.
- The command center's system map draws the estate's context view, or the one system's components and links, on the same canvas as Diagrams.

### Diagrams draw the view; modules show what they build on

- The Diagrams screen draws the chosen view itself (ADR 0068): Data shows each component's reads and writes to the tables inside their store, Container a system's components and their links, with a layered layout where no label sits on another. Pointing at a box lights its edges. `GET /api/diagram/{view}/graph` and `atticus diagram render <view> --format json` give a view's groups, nodes and edges.
- `Component.uses` (C1, optional): the modules of the same repo a module's pom or package.json depends on. The container view draws them as `uses` edges.
- A JPQL `@Query` is read against the entity's table (`@Table`, `@Entity(name)`, else Spring's naming), not the entity's name; a PostgreSQL or MySQL upsert and `SELECT ... FOR UPDATE` no longer give a table called `set` or similar.

### Discover: a clone's subfolders are its modules

- `atticus repos discover <folder>` on a folder that is itself a Git clone proposes one repo, with each subfolder that builds (a pom, a package.json, a pyproject and so on) as a module with its own component (ADR 0057). A clone inside it stays a repo of its own. A folder of clones is read as before. Discover now writes `modules` into the manifest.

### Shared parse cache

- Each file is read and parsed once per repo scan and shared by every reader (ADR 0067): built-in extractors, dialects and their rules, the Helm and Kustomize builders, Terraform and the framework survey. Tree-sitter trees, JavaFiles, SourceFiles, YAML documents, flattened configuration, HCL, XML and Groovy calls are cached, keyed by path and content. Values are frozen, so a reader that changed one fails instead of changing another's; the cache is bounded (8M characters of plain values, 1M of syntax trees, 16M of file text, least recently used first out) and frees every tree when the repo's scan ends, on error too. The SDK's `RepoHandle` gains an optional `parseCache` (`createParseCache`, `withParseCache`); handles without one work as before. Records are byte-for-byte unchanged. On the M1 exit estate parses per file went from 2.9 to 1 and the first scan of 300 repos from 59 to 90 s to 32 to 41 s.
- Tree-sitter grammars run as baseline WebAssembly code: V8 compiling them to optimised code took up to 2.2 GB of transient memory per process and killed test workers under load ("Fatal process out of memory: Zone", exit 0x80000003). The `frameworks-cli` test worker now peaks at 184 MB instead of 2.6 GB.

### Onboarding framework models

- `atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]` (ADR 0066): the learner reads the house framework first, then your organisation's assistant drafts only what it couldn't (base URLs of service ids, wrapper methods whose parameters don't name the method or path, what pipeline templates and Jenkins shared-library steps do), with the framework kit as instructions and the code as data. Checks decide: valid C6, every entry with a source, nothing read from code changed by the draft, drafted entries citing a document or a person, its tests pass, and the repos that use it give something with it they don't without it and no invalid record. Failures go back to the next attempt (`--attempts`, default 3). A passing model is a proposal in `proposals/frameworks/`, listing what it reads per repo, which records came from drafted entries, and entries that change nothing. With AI off or `--no-ai`, the learned model alone is checked.
- `atticus onboard check framework <name>` runs the same checks on a hand-written or handed-off model (with `--from`, the learner's entries are confirmed and merged in); `atticus onboard accept framework <name> [--replace]` (or `onboard accept <name>`) moves it into the org pack.
- `atticus scan` names house frameworks several repos import that no model covers, with the command to onboard each (`unmodelled` in `--json`), and models that read nothing any more in repos that import them (`coverage[].redraftFrameworks`), with the re-draft command.
- `atticus onboard eval` grades framework cases too (`kind: framework` in `case.yaml`): the first, `harbor-kit`, an invented Java starter and two repos using it; the eval runs 11 cases.
- `frameworks survey` and the scan share one import reader (moved to `@maycombhq/extractors`); the survey's output is unchanged.

### Model providers

- Model mode can call a real model (ADR 0065). A new package, `@maycombhq/model-providers`, ships three providers the CLI registers when it starts: `anthropic` (Messages API, directly or through a gateway), `openai-compatible` (Chat Completions, for internal LLM gateways, vLLM and similar; `flavour: azure` for Azure OpenAI deployments with `api-key` and `api-version`, also as `type: azure-openai`) and `bedrock` (the Converse API, SigV4 signed with `node:crypto` from the standard AWS environment variables; no AWS SDK).
- Keys stay out of `runtime.yaml`: `keyEnv` names the environment variable that holds the key, a setting that looks like a key or token is refused, and messages, run records and inspected objects never show a key. `baseUrl` must be `https://` except on this machine.
- Corporate networks: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (with proxy credentials in the URL, never printed), `NODE_EXTRA_CA_CERTS` and a `caFile` setting. Timeouts (`timeoutMs`), cancellation, and bounded retries with backoff on 429 and 5xx that honour `Retry-After` up to 60 seconds. Each failure says what to check: the key variable on 401, the model or deployment on 404, the proxy on 407, the CA on an untrusted certificate.
- Usage comes from the response's token counts. An answer cut off at the output limit or declined by the provider fails the run rather than being used.
- Contracts, additive: C5 `registerModelProvider` (an organisation's own provider registers the same way), C6 `adapters.model.type: openai-compatible`. `models.allowed`, `modes.allowed`, `ai: off` and text-only work as before.
- New dependency: undici (MIT), for the proxy. Not built: streaming, Vertex AI, AWS profiles and SSO, Azure managed identity, images and tools. No provider has been called against a real endpoint from this repo; tests use an injected transport or servers on 127.0.0.1.

### Helm and Kustomize

- Helm charts are read without running Helm (ADR 0064): each chart once per environment values file (`values-<env>.yaml`, `values.<env>.yaml`, `values/<env>.yaml`, `environments/<env>/values.yaml` and the like) layered over `values.yaml`, with local subcharts (`charts/<name>`, `file://`, `alias`, `condition`, `tags`, globals). Templates go through a small Go-template reader (a tokenizer and parser for `{{ }}` actions, not text patterns) that evaluates `.Values`, `.Chart`, `.Release.Name`, variables, `if`/`else`, `with`, `range`, `include` of the `helm create` helpers and the common functions (`default`, `quote`, `toYaml`, `nindent`, `printf`, `trunc`, `trimSuffix`, ...). Anything else (`tpl`, `lookup`, `.Files`, `.Capabilities`, `.Release.Namespace`, unknown functions) is left unknown: the field is dropped, never guessed, and a template whose condition depends on one is skipped with a warning naming its line. The release is taken to be named after the chart. Dependencies that aren't in the repo are reported, not fetched.
- Kustomize overlays are built without running kustomize: resources, bases and components, strategic-merge and JSON 6902 patches, namespace, namePrefix/nameSuffix (references to renamed objects follow), commonLabels and labels, commonAnnotations, images, replicas and `configMapGenerator` literals. Remote bases are never fetched and fields not read (`replacements`, `vars`, `helmCharts`, ...) are reported.
- The openshift (0.3.0) and ingress (0.2.0) extractors read the built objects: Deployments, Ingress hosts, HPAs and NetworkPolicies per environment, with evidence at the template or resource line and at the values file, kustomization entry or patch behind it. A workload from a chart or overlay also gives `image` and `env.<NAME>` settings per environment (ConfigMap values filled in, secrets as `secret:<name>/<key>` references).
- Behaviour change: in a repo with kustomizations, base objects come out once per overlay rather than once under no environment, and overlay patch files are no longer read as objects of their own. Other manifest readers and repos without charts or kustomizations read as before.

### Cloud resources and Terraform modules

- Shipped dialects `terraform-aws`, `terraform-azure` and `terraform-gcp` (ADR 0063) read cloud resources from Terraform in every repo with a `.tf` file: SNS topics, EventBridge buses, Kafka topics, Service Bus topics and event hubs as event topics; Service Bus and Cloud Tasks queues, DynamoDB, Cosmos DB, MSK, Redis caches and Spanner as data stores; Lambda and Azure function apps as function components with a deployment; ECS services and App Service web apps as deployments; API Gateway v2 routes, first-level v1 resources and API Management APIs as gateway routes. An org-pack dialect of the same name replaces one.
- Terraform databases (Cloud SQL, RDS instances and clusters, Azure PostgreSQL and SQL servers) moved from the infra extractor's regular expression into those dialects: the same records, now with names and engines resolved from variables, and blocks read by the HCL parser. Azure PostgreSQL single servers and MySQL flexible servers are read too. The infra extractor no longer reads `.tf` files.
- Local Terraform modules are followed: a `module` block whose source is a folder of the repo makes an instance of that folder with the caller's values, so each instantiation's resources give their own records, nested modules included. A module folder that is called is no longer read on its own with its defaults, and a resource in it whose name the caller doesn't give is skipped rather than named after its label. Remote modules stay module blocks a dialect matches.
- Dialect templates: filters `before('x')` and `after('x')`; in `hclBlock` matches an object attribute's fields are dotted (`${attr.tags.env}`) and a reference to another resource is `${attr.<name>.ref}`, for lookups.
- `atticus onboard`'s survey counts what the shipped cloud dialects read as read.
- Not read yet: Lambda triggers, API Gateway integrations, EventBridge rules, module outputs, `count` and `for_each`; clusters (EKS, AKS, GKE) give no record.

### Pipelines from any CI/CD tool, and what org templates do

- Shipped dialects for Harness pipelines, Tekton Pipelines and Argo CD Applications (ADR 0062): a Harness or Tekton pipeline is a pipeline QualityAsset with stages, environments, deploy targets, test steps and templates, like the built-in readers write; an Argo CD Application is a GitOps Deployment.
- Framework models can have `pipeline` entries: what a template (`uses: org.tide_release`, `deploy.yml@templates`, a GitHub action) or a Jenkins shared-library step (`step: deployToProd`, `environmentFrom: env`) adds. Every pipeline that uses one gains it after the scan, and `details.modelled` says which model said so and where that came from.
- Dialects: `appliesTo.repoTypes: ["*"]` (any repo, gated by the marker); a `map('a=b')` filter; `where` on collected list items; `jsonPath` reads every document of a multi-document YAML file; `contains` on any match skips files without the given text before parsing them.
- Three onboarding eval cases (Harness, Tekton, Argo CD); `atticus onboard eval` runs 10.

### Dialect fields: nested objects, collected lists, the component

- A dialect field may be an object, nested up to three levels, and a list item may collect one value per node under the match: `{ each: "@.stages[*].stage", value: "${item.name}" }` (ADR 0061). `${repo.component}` is the component the matched file belongs to. A pipeline from any CI/CD tool can now be described as rules the way the built-in readers describe one.

### Rules read syntax trees, not text patterns

- Java and Kotlin are read from their syntax trees (ADR 0060): one reader for the Spring extractor, dialects, the framework learner, batch, GraphQL and realtime. It gives what the hand-written lexer gave on every fixture file, and more: Kotlin `object` declarations, interface methods without a body, constants declared in companion objects. Calls are listed in source order, so a WebClient chain still reads its verb.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree.
- The ORM and vocabulary readers read code from syntax trees too, through one call layer (callee, receiver, positional and named arguments, string values) for Java, Kotlin, TypeScript/JavaScript, Python, Go, C# and Scala: JPA entities (every field, nested annotations such as `@Table(indexes = @Index(...))`; the Java tokeniser is gone), EF Core (attributes, DbSets, `Entity<T>()` and `ToTable` chains) and SQLAlchemy models, and the code side of the GraphQL, gRPC, realtime, webhooks, serverless, apps, data-pipeline and ML readers. Code in a string or a docstring is no longer read as code, and a declaration or attribute can span lines. Datadog resources in Terraform go through the HCL parser. Swift, Dart, .proto, GraphQL SDL, Prisma and SQL have no grammar here and keep their own readers.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree. The JPA reader still tokenises, until it moves too.
- The generic-tier call layer reads syntax trees too (ADR 0060): the .NET, Python, Go and Node extractors and house frameworks get their tokens, calls, arguments, assignments and imports from the C#, Python, Go and TypeScript/TSX/JavaScript trees, and the hand-written lexer is gone (`SourceFile.parse` replaces `new SourceFile` and `lexSource`). Every fixture gives the same records. What a file imports is read from its import statements, not searched for in its text; the frontend extractor reads calls from the tree (Vue `<script>` blocks too), so a `fetch("/x")` in a comment or a string is no longer a call; method declarations, `raise X(...)` and `for rows.Next()` are told apart correctly; typed declarations (`x: str = "a"`, `var x string = "a"`) assign `x`; generic arguments (`Message<string, string>`) no longer split an argument.
- A `syntax` match (ADR 0060): a tree-sitter query over the file's syntax tree, for Java, Kotlin, TypeScript, TSX, JavaScript, C#, Python, Go, Scala, Ruby, PHP and Rust. Captures are `${capture.<name>}` (string literals unquoted) in templates, `where` and `lookups`, so a lookup over the tree can be the repo's constants. A call in a comment or a string isn't a call. The grammars ship with Atticus (web-tree-sitter 0.22.6, tree-sitter-wasms 0.1.13); nothing is downloaded or compiled.
- The framework learners read trees too: `atticus frameworks learn` takes a Java starter's `@AliasFor` members, constants and public methods' parameters from the Java tree, and a JS or TS framework's (or a package's `.d.ts`) exports from the TypeScript, TSX or JavaScript tree, so commented-out code and code in strings teach nothing. House dependencies read poms through the XML reader (a commented-out dependency isn't one) and `build.gradle.kts` through the Kotlin tree, including `group =, name =, version =` arguments. Groovy `build.gradle` and Jenkinsfiles are still read as text until a Groovy grammar ships.
- `atticus dialect tree <file>` prints a file's syntax tree, with the node names a query uses.
- Groovy (`.groovy`, `.gradle`, `Jenkinsfile`) is a syntax language too: its prebuilt grammar is vendored with its licence. Jenkins pipelines (stages, triggers, steps, test and coverage reports) and Groovy `build.gradle` coordinates are read from the Groovy tree, so commented-out stages and dependencies are no longer read.
- `atticus onboard` gives the assistant the syntax trees of sample code files, and refuses a draft with a `regex` match. `regex` is deprecated in hand-written dialects.
- The dialect kit's reference documents `syntax`, and a worked example reads a house client in Java, Kotlin and TypeScript.

### Onboarding: your assistant drafts the dialect

- `atticus onboard <repo>` (ADR 0059): a deterministic survey of the repo (what is read already, the structured files nothing reads), a draft dialect from the organisation's assistant through the AI runtime (the dialect kit as instructions, the repo as data), and checks: valid C2, its own tests pass and exercise every rule, it reads records from the repo and none is invalid. What failed goes back to the next attempt (`--attempts`, default 3). A passing draft is a proposal in `proposals/dialects/`; `atticus onboard accept <name>` (a person) moves it into the org pack. `atticus onboard check <name> --repo <repo>` checks a hand-written or handed-off draft the same way.
- `atticus scan` names the repos it read nothing from though they have structured files no reader knows, with the command to onboard them.
- It also names rules that need re-drafting: a dialect a repo's manifest entry names whose tests now fail (the scan leaves it out), or that reads nothing in that repo any more (a framework upgrade, a renamed file). `atticus onboard <repo> --name <dialect>` re-drafts it; `onboard accept <dialect> --replace` takes the new draft. Coverage (`--json`) lists them per repo. Coverage (`--json`) lists each repo's unread structured files.
- The dialect kit ships the three gateway dialects as worked examples.
- `atticus onboard eval <dir>` scores the assistant's drafts: for each case (a repo and a reference dialect a person wrote) it compares what the draft reads from the repo with what the reference reads, by content, and reports precision and recall. `fixtures/onboard-eval` has seven invented ecosystems: Apigee with target servers, Kong, Azure APIM, AWS API Gateway, a house edge gateway, a house HTTP client in three languages, and house Terraform topics. CI runs it with a stand-in that answers with the references; run it with `--mode model` where your model is.
- Dialect templates read nested fields of structured files with dots: `${attr.forward.service}`, `${node.up.match.prefix}`; a match's ancestors include the document's top-level fields.

### Dialect rules v3: any gateway, read through rules

- Dialects take `lookups` (ADR 0058): tables built from other files of the repo, read with `${lookup:<table>(<key>).<value>}`, the key any template value with filters. A key with no row, or with rows that disagree, leaves the value unknown.
- `${node.key}`, `${node.up.<field>}` and `${node.up.up...}` read the structure around a `jsonPath`, `xpath` or `hclBlock` match: a route's service, an element's parent. New filters `parent` and `basename`. A rule's `emit` may be a list.
- `fixtures/gateways`: an invented estate whose calls go through three gateway products, each read only through an org-pack dialect: Apigee with target servers per environment, Kong's declarative config (nested services, several paths per route), Azure API Management's APIOps folders. Every call joins end to end, caller to gateway route to service, verified at both ends. The three dialects are the reference an assistant's draft is graded against.
- Fixed: the dialect kit's reference had a block of itself pasted into the `where` section since rules v2.

### Harbor gaps closed

- Calls to a vendor join the vendor's system: a host label that is a vendor system's id, name or alias from the profile, without spaces or dashes (`api.tidewater.example` → Tidewater Payments, `api.lanternmail.example` → Lantern Mail), when exactly one vendor matches. It is checked before a host's first label, after declared hosts. Harbor's three vendor interfaces, and the h01 and h09 findings from a scanned catalog, now pass.
- golang-migrate files are read: `<version>_<name>.up.sql` gives the version, in numeric order, and the `.down.sql` files that undo them are skipped.
- A vendor's OpenAPI 3.1 `webhooks` are read: each is a `webhook-send` loose end, joined to the one webhook endpoint whose path names the vendor (`/webhooks/tidewater`), via webhook.
- Profile systems take `tags`, copied to the System record (`saas` marks a SaaS vendor, ADR 0040).
- Feature detection starts flows at GraphQL operations, webhooks, websockets and server-sent events too, not only REST, gRPC and SOAP.
- Reconcile matches a diagram edge drawn as `POST /pkg.Service/Method` to the gRPC interface.
- Intake reads Mermaid files as diagrams and links the systems their boxes name, and takes Jira REST search exports and Azure DevOps work-item batches as ticket exports, not payload samples.
- The unattended-workload check covers data pipelines and anything started by a schedule.
- Every Harbor test runs: none is skipped, and every expected record has a producer.

### One component per deployable module

- A repo that builds several deployables has a component for each (ADR 0057). `repos.manifest.yaml` may list a repo's `modules` (folder, component, hosts); without them, a multi-module Maven or Gradle repo with two or more `@SpringBootApplication` modules gets one component per app, named by its `spring.application.name`, else its folder. Endpoints, calls and loose ends belong to the module their file is in (Spring, house frameworks, the .NET, Node, Python and Go backends, OpenAPI files); a module's hosts join calls to it; calls between a repo's own apps are interfaces. The repo's own component stays, for what is outside every module.
- Extractors see the modules as `ScanContext.modules` (C4, an addition).
- The messy estate gains a multi-module repo: an API, a nightly job that calls it, and a shared library.

### Dialect rules v2: infra repos, conditions, honest rules

- Dialects read Terraform (ADR 0056): an `hclBlock` match (`module`, `resource.aws_sqs_queue`) supplies each block's attributes, resolved from the folder's variable defaults, `terraform.tfvars`, `*.auto.tfvars` and locals, and its labels. With YAML and JSON (`jsonPath`) and XML (`xpath`) matches, infra and pipeline repos built on house modules, charts and templates are read through dialects.
- Rules take `where` conditions: `{ value: "${attr.source}", matches: "tide-kafka-topic" }`. All must hold for a match to emit.
- A record a rule can't complete (a field C1 requires couldn't be filled) is skipped with a warning naming the rule and the field, instead of being emitted invalid.
- `receiverType` is applied: a `methodCall` rule with it matches only calls on a field, parameter or variable declared with that type, or a static call on the type. Before, it was accepted and ignored.
- A dialect's tests must exercise every one of its rules; a rule that produces nothing in any test fails `atticus dialect test`, and a scan doesn't use the dialect. Shipped dialects gain the tests they lacked (Micronaut `@Put` and `@Patch`, Quarkus outgoing channel topics).
- The messy estate gains an infra repo whose topics come from a house Terraform module, read through an org-pack dialect.
- The dialect kit's reference, README and checklist cover all of it.

### House frameworks in any language

- `atticus frameworks learn <name> --from <dir|package.tgz>` learns a JavaScript or TypeScript framework: from its source, or from its published npm package alone (its typings, else its JavaScript; nothing is run or installed). Exported functions and the methods of exported clients and routers become calls and routes, by their parameter names, positional or object properties; exported string constants are kept. Learned entries replace hand-written ones and make verified facts; a model's tests and a person's services are kept. `frameworks discover --group @scope` finds house npm packages in package.json files and looks for them offline (`--jars` folders of .tgz files, installed node_modules). The messy estate's Lantern source and package are fixtures; learned, the BFF's routes are verified.
- A bounded reader for gzipped tar archives (npm packages) joins the ZIP reader in core.
- `atticus frameworks survey [--package <prefixes>]` shows how the estate's repos use house frameworks in any language: each house module they import, the model that covers it, and how each imported name is called or annotated (`useApi(...)`, `lantern.call(...)`, `@InternalApi`, `BankHttp.exchange(...)`), with counts and a sample line. `atticus frameworks kit [dir]` exports the framework-model kit for an organisation's assistant: a guide, two worked examples, the schema, a checklist and a task prompt. New guide page: [Teaching Atticus your house frameworks](docs/guide/frameworks.md).
- Framework models carry their own tests (ADR 0055): sample files and the records they must give (`http-call POST https://…`, `endpoint GET /x/{id}`). A scan uses a model only while its tests pass and every entry a person or document wrote is exercised; otherwise the model is left out with a problem saying why. `atticus frameworks check [name]` runs them. `frameworks learn` keeps a model's tests. The messy estate's two models ship tests (Java and TypeScript examples).
- Framework models describe calls and routes in any language (ADR 0055): `calls` (a function, its receiver, the module it comes from, which argument or object property holds the method, service and path; HTTP, events or queues) and `routes` (calls that register a served route). A new built-in extractor applies them to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, in files that import the framework, filling names from the repo's own exported constants and the model's service ids. Service ids may be plain (`payments`) and packages may be npm modules (`@tide/lantern`).
- The messy estate gains Lantern, an invented React SPA and Node BFF framework: the SPA's `useApi({ service, path, method })` and `lantern.call(...)` calls reach the BFF through its declared host, the BFF's `defineRoute` and `router.route` registrations are endpoints, and the chain continues from the TypeScript BFF to the Java service's house controller.

### House frameworks, read through framework models

- `org-pack/frameworks/<name>.yaml` (ADR 0054): what a house framework means, in terms the scanner already reads. Its annotations stand for Spring's (`@InternalApi` → `@RestController` + `@RequestMapping`, `@Op(verb, path)` → `@RequestMapping`), its wrapper client is an HTTP call (`bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")`), and its service ids and constants have values. Every entry says where it was learned (code, bytecode, a document or a person); only code and bytecode make verified facts. `atticus orgpack validate` checks the files.
- `atticus frameworks learn <name> --from <repo>` learns a model from a house starter's source: its `@interface` declarations (what each is meta-annotated with, house-on-house too, and `@AliasFor` as the attribute mapping), the public methods of its HTTP wrapper (service, method and path by parameter name), and its `static final` constants. Learned entries replace hand-written ones of the same name; what a person added (service URLs) is kept. What code can't say is printed as a note.
- `atticus frameworks learn <name> --from <starter.jar>` learns the same model from a compiled starter, for teams that have only its JAR: a small, bounds-checked class-file reader takes the annotation types (meta-annotations, `@AliasFor`), the wrapper's public methods with their parameter names (kept by `-parameters` builds, or the debug variable table) and `static final` constants, and the coordinates from `META-INF/maven/.../pom.properties`. Every entry's source is `bytecode`, naming the class inside the JAR and the JAR's sha-256. Nothing in the JAR is run.
- `atticus frameworks discover --group <prefix>` finds the house artifacts the estate builds on: it reads every repo's Maven poms (all modules, `${property}` versions) and Gradle builds, says which repos use which version, and looks for each JAR on this machine (`--jars` folders, then the Maven and Gradle caches). A JAR that isn't here is named, never downloaded. `--learn` learns each JAR it found.
- The safe ZIP reader moved to core (one reader for documents and JARs); ingestors re-exports it.
- Liquibase changelogs are read: formatted SQL (`--changeset author:id`), XML and YAML change sets (`createTable`, `addColumn`, `dropColumn`, `renameColumn`, `renameTable`, `createIndex`, `dropIndex`, `dropTable`, `addPrimaryKey`, `sql`), in the master changelog's include order. Each change set is a `liquibase` Migration, and the tables, columns and indexes are the same as the same changes written for Flyway. Flyway files in folders under `db/migration` are read too.
- Merge grows linearly with the estate: 1,600 components (about 100,000 records) merge in about 2 seconds, where 400 took over 5 and 800 about 20. Endpoints, tables and stores are looked up through indexes instead of scanned once per loose end; results are unchanged.
- Configuration is read the way Spring reads it: every YAML document (one with `spring.config.activate.on-profile` belongs to that profile), base config first, then production's values (`prod`, `production`, `prd`, `live`) for keys only profiles set, then the other profiles'. Before, `application-dev.yml` won over `application-prod.yml` because its name sorted first. Placeholders resolve innermost first and through values (`${a:${b:x}}`, `url: ${base}/v2`), and each module of a multi-module repo resolves its calls from its own config first.
- Constants are read from the whole repo, not just the file using them: `@RequestMapping(ApiPaths.CARDS)` with `ApiPaths.java` elsewhere in the repo is a verified endpoint `/cards`, and Kotlin `const val` counts too. A name defined twice with different values stays a loose end.
- The Spring extractor reads files that use a modelled framework even when they don't import Spring, and turns a file using one into a warning when nothing was read from it.
- The messy estate's two known gaps are closed: its house controller is an endpoint (inferred: a person wrote the model) and its wrapper call reaches `https://audit.tide.internal/audit/events`.
- A Spring property placeholder in a served path (`"${api.base}/x"`) is a loose end, not a verified endpoint whose path holds `${api.base}`.

### The messy estate: the catalog-truth gate

- `fixtures/messy`: an invented bank (Tidewater) written the way real teams write code (constants, `@Value` base URLs, a house starter, a wrapper client, Kotlin, JMS, a password in the datasource URL, a broken template, a gateway with a declared host). `packages/scanner/test/messy.test.ts` checks a scan finishes, makes no verified fact the code doesn't spell out, shows every client call, joins through the gateway only on its host, keeps no secret and reports coverage. The house annotation and the wrapper client are recorded as known gaps for phase 3.
- Fixed, found by it: merge dropped loose ends of every kind it doesn't join (`http-endpoint`, `mq-publish`, `mq-subscribe`, and any a dialect emits), so they never reached the catalog. They now pass through. A `kafkaTemplate.send` was also taken for a JMS send.

### Every client call is seen, joined or not

- A Spring call whose URL or topic the code builds (`restTemplate.postForObject(base + PAY, ...)`, `kafkaTemplate.send(Topics.PAYMENTS, ...)`, WebClient `.uri(...)`) is a loose end showing what it was built from, instead of nothing. Same-file `static final` String constants and `@Value` fields are filled in, so `base + PAY` reads `${nw.endpoints.payments}/v2/payments` and config resolves it where it can.
- JMS sends (`JmsTemplate.send`, `convertAndSend`) and `@JmsListener` destinations are recorded (`mq-publish`, `mq-subscribe`).
- A file that imports an HTTP or messaging client (RestTemplate, WebClient, Feign, Kafka, JMS, IBM MQ) but gave nothing is a scan warning.
- `atticus scan` prints how much of what it found it joined (`Joined 21 of 30 calls, listeners and endpoints found (70%)`); `--json` has `coverage` per repo: interfaces, loose ends and unread files.
- The Java reader reads Kotlin's `package` and `import` lines, which have no semicolon; before, the first import swallowed the rest of the file.

### No secrets in the catalog

- A Spring datasource URL loses its credentials before it is recorded, in every JDBC form (`user:pass@`, `?password=`, `;user=..;password=..`, Oracle's `scott/tiger@`); a URL that could still hold one is left out. Before, `spring.datasource.url` went into catalog files, the catalog site and context packs as written.
- Settings whose names hold credentials (`pwd`, `passphrase`, `credentials`, `api-key`, `access-key`, as well as `password`, `secret`, `token`) are recorded as `(secret)`.

### No facts made from what the code doesn't spell out

- `repos.manifest.yaml` takes `hosts` per repo (ADR 0053). Calls go through a gateway only on hosts listed for the gateway repo, and a call to a host listed for a component joins it whatever the host's labels say. Before, any unknown host whose path started with a gateway basepath was joined through the gateway, which invented interfaces. A scan note names each undeclared host that looks like a gateway.
- Merge never matches an endpoint of another method, and never joins a relative call on a generic path (`/health`, `/actuator/...`).

- A Spring path made from a constant (`@RequestMapping(ApiPaths.CARDS)`, `"/v2" + ApiPaths.CARDS`) is no longer a verified endpoint named `/ApiPaths.CARDS/...`: it is an `http-endpoint` loose end showing the name, `GET ${ApiPaths.CARDS}/${ApiPaths.BY_ID}`, until its value is known. Feign paths and listener topics made from constants show the name the same way, and stay loose ends.
- Merge never joins publishers and subscribers on a topic the code names but doesn't spell out.

### Scans that finish and say what they couldn't read

- The Java and Kotlin reader always moves on: a stray `}`, `)` or `]` inside an annotation (templates, archetypes, half-edited files) used to loop forever and stop the whole estate scan.
- A file over 5 MB (a committed `vendor.min.js`, a data dump) is left out of the scan with a warning. Before, it made the extractor that met it fail for the whole repo, losing everything else it had found there.
- `atticus scan` says how many warnings the scan had (files left out, rules that couldn't fill a template) and `--warnings` lists them; `--json` has them under `warnings`, and the scan's stats count them. Warnings don't fail the scan.

### Windows build and install

- `pnpm lint`, `pnpm licences`, `pnpm bundle` and `pnpm bundle:test` run on Windows: script paths come from `fileURLToPath`, the bundle imports through a file URL, and pnpm is started the way Windows needs. A new check in `pnpm lint` (`scripts/check-portable-paths.mjs`) refuses `URL.pathname` used as a file path and `import()` of a plain path.
- `install.ps1`: the `atticus.cmd` shim finds its version beside itself instead of holding a full path, so a profile folder with accented letters no longer breaks it; `-NoPath` leaves your PATH as it is.
- `pnpm bundle:test` installs into a home folder with a space and an accented letter, runs the `atticus` shim, no longer adds its throwaway folder to your PATH, and removes its temporary files when it passes. The bundle and licence check remove their `pnpm deploy` folder.
- The practice sandbox works on a machine with no Git identity (each repo gets a local one, with signing off), and its Git host is manual, so the product owner's lesson reaches Design with the command line alone: the hand-off PR steps are recorded with `atticus todo done`. Before, a fresh mock host in every command lost the PR.
- `atticus trace` no longer reports a test or plan twice when one worktree holds it with CRLF line endings (Git for Windows' `core.autocrlf`) and another with LF.
- Every package's tests run with their own temporary folder, removed when the run ends (`vitest.shared.mjs`); tests used to leave hundreds of folders behind in the system temp folder.
- CI runs the check on Linux and Windows on every push and pull request.
- The bundle leaves out `node_modules/.bin`, so a zip built on Windows holds the same files as one built on Linux.

## 1.0.0-rc.1 (2026-10-19)

The first release candidate: the whole product, built in five milestones.

### M5: ready to install

- `atticus doctor`: what this machine needs, each with a fix; first on the setup checklist and on Settings (ADR 0049).
- The local log (`.atticus/logs/`), redacted; crash messages that say where the details are; whole-file writes; one scan at a time; `atticus support bundle` (ADR 0050).
- `atticus upgrade` and `.atticus/metarepo.yaml`: migrations with backups, and an older Atticus refuses a metarepo a newer one upgraded (ADR 0051).
- The threat model; hardening headers on every response.
- The offline install bundle (`pnpm bundle`) with install scripts for Windows, macOS and Linux, checksums, a CycloneDX SBOM and third-party licences; the licence, dependency and docs checks in `pnpm lint` (ADR 0052).
- Performance budgets on 120 synthetic repos.
- Guides: install, admin, every role, troubleshooting, and the command reference.
- Fixed: the command line didn't declare `yaml`; shipped dialects were dropped outside the repository; `trace` cited tests in another task's worktree; `--port 0`.

### M4: the app

- The local API and all 27 screens in the HUD design, each with empty, loading and error states (ADRs 0015, 0043).
- A home and sidebar for each of thirteen roles, approvals from ownership only, first-run tours, guided setup and the catalog baseline (ADRs 0044, 0047).
- The command palette and Ask; system guides and the read-only catalog site; incident mode.
- Release views: deployment plan, forecast, evidence pack, release notes, outcome records and the security review draft (ADR 0045).
- AI on, text only or off (ADR 0046).
- Views across all changes, approvals waiting, the personal digest and the field-mapping grid (ADR 0048).
- The thirteen role journeys and an accessibility check of every screen in a browser.

### M3: changes from idea to release

- The change lifecycle across repos with hand-off PRs, separation of duties, risk and conflicts (ADR 0029); OpenSpec and Spec Kit as one framework (ADR 0030).
- The critic: rule layers, deterministic checks, AI lenses with evidence, rounds and gates (ADR 0034).
- Run with AI, assistant files for Copilot and Claude Code, planning, the story bar, manual adapters and executors (ADRs 0032, 0033, 0036, 0037).
- `init`, `adopt`, `absorb` and federation (ADR 0038); test generation, traceability, the CI drift check and the glossary (ADR 0039); features from code (ADR 0031); initiatives, learning, evals and defences (ADR 0042).

### M2: knowledge from documents

- Diagram and document ingestors, backend and platform extractors, intake and triage with curated decisions, knowledge sources, coverage and owner questions, stubs and diagram export, the dialect build kit (ADRs 0021 to 0028).

### M1: the catalog from code

- Built-in extractors and the dialect engine, merge and identity, the local index and query language, diagrams and reconcile (ADRs 0016 to 0020).

### M0: foundations

- The contracts C1 to C6, canonical YAML, the plugin SDK basics, the OpenSpec adapter, the workspace manager, adapters with mocks, the AI runtime and the OpenAPI document (ADRs 0001 to 0015).
