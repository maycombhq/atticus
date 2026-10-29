# Running Atticus for a team (platform lead)

This guide is for the person who sets Atticus up for a team and keeps it healthy: usually the platform lead, with the architect for the catalog and the process owner for procedures. Install first: [installing Atticus](install.md).

## The setup checklist

Home shows it until the catalog is accepted; `atticus setup` prints it. Each step says what to do next:

1. **This machine has what Atticus needs** (`atticus doctor`).
2. **The org pack is valid** (`atticus orgpack validate`).
3. **Repos are listed** (`atticus repos discover <folder>`, then add the proposals to `repos.manifest.yaml`). Give each repo the `hosts` its component answers on, and the gateway repo its gateway's hosts (`hosts: [api-gw.example.internal]`, `*` for any part of a label): calls join components and go through gateways only on hosts listed here (ADR 0053). Several repos may list the same host: an API gateway whose proxies each live in their own repo lists its host on every one of them, and a call is joined to whichever proxy's route serves its path. Where several services sit behind one host under a common prefix and their own module name (an OpenShift or GCP ingress: `/<base>/<module>/...`), give each repo its `basePath` (`basePath: /cdp/limits`, or per module): a call whose path starts with it goes to that repo, so even a path every service serves (`/ping`) is joined, not asked (ADR 0134). Adding hosts or base paths needs no new read: run `atticus verify --all --write` again. A scan note names each undeclared host that looks like a gateway. A repo that builds several deployables lists them under `modules` (`- { path: accounts-api, component: accounts-api, hosts: [accounts.example.internal] }`), each with its own component and hosts; a repo with two or more Spring Boot apps gets one per app without it, named after each app (ADR 0057). A call to a vendor joins the vendor's system when a label of its host is the vendor's id, name or one of its `aliases` in the profile, written without spaces or dashes (`api.northwindpay.example` → Northwind Pay); give vendors the aliases their hosts use.
   Give each repo one line saying what it is, in your own words (`atticus repo add <url> --description "..."` for one repo, `atticus repo describe <repo> --description "..."` later; `atticus repo describe` lists the repos that say nothing). A repo id often says nothing; that line is carried into every reading prompt, into the question a join asks when two repos could answer on a host, into what `map --estimate` proposes leaving out, into what a repo is matched on when knowledge and stories are placed, and into `map.md` and the app's views. Write what it is for and who uses it, not what the code already says. On the first read of a repo that says nothing your assistant drafts a line with the lines it read it from; it stays marked unconfirmed until someone runs `atticus repo describe <repo> --accept`, changes it or drops it (ADR 0128).
4. **Repos are cloned here** (`atticus workspace sync`, or _Sync repos_ on the Scans screen).
5. **The first scan is done** (`atticus scan`, or _Scan now_). Scans read files only: no network, no AI.
6. **Existing knowledge is added** (optional): diagrams, partner specs and exports in `inputs/` (`atticus intake add <files>`), wikis in `sources.yaml` (`atticus sources add`).
7. **The catalog is accepted**: walk the ecosystem map with the architect, then `atticus baseline` or _Accept the catalog_ on Home. It writes `catalog/baseline.yaml` with your name (your Git user); commit it and open a pull request, whose merge makes it the baseline on main. Every later scan, document and change is compared with this baseline.

### Branches

The catalog is read from each repo's `defaultBranch`: that is the baseline, the one the hand-off PRs build on. `atticus workspace sync` and `atticus doctor` say when a remote calls another branch its default; changing it is your decision, on **Set up › Repos** or in the manifest (ADR 0123).

To see what another branch would bring, list it under `branches` in the manifest (or on Set up › Repos) and run `atticus scan --ref develop`. It reads each repo's `develop` in a read-only checkout beside its base clone, keeps the catalog in `catalog/branches/develop/`, and says what it adds, removes and changes against the baseline. A branch is never merged into the baseline.

### Knowledge as files

Knowledge comes in two scopes (ADR 0122):

- **General knowledge** goes in the metarepo's `inputs/`: decisions, runbooks, specs, request forms, slides and exported pages. Add files on Knowledge › Documents, with **Add to Atticus knowledge** in either editor, or with `atticus intake add <files>`. `atticus sources sync` reads `inputs/` as a source called `inputs`, and the knowledge scan (`/atticus-knowledge inputs`) reads it into items, each quote checked against the file. A file dropped twice is read once, and an older version is kept but not read.
- **Specific to one change** goes in that change's Files attached (`atticus change attach`). Only that change's steps read it. **Copy to general knowledge** (`--promote`) copies it into `inputs/inbox/` when every change should see it.

Pictures go to a person, since AI steps take text only. A scanned PDF with no text layer can't be read: OCR isn't built.

### Helm charts and Kustomize overlays

A scan reads deployment repos the way they are kept, without running `helm` or `kustomize` (ADR 0064):

- **Helm**: each chart (a folder with `Chart.yaml`) once per environment values file (`values-prod.yaml`, `values.uat.yaml`, `environments/<env>/values.yaml` and the like), layered over `values.yaml`, with local subcharts under `charts/`. The release is taken to be named after the chart. Atticus evaluates the common template forms (`.Values`, `.Chart`, `.Release.Name`, `default`, `quote`, `include` of the `helm create` helpers, `if`, `with`, `range`, `toYaml | nindent` and similar); anything else (`tpl`, `lookup`, `.Files`, `.Capabilities`, `.Release.Namespace`) is left unknown, so that field is missing from the catalog rather than guessed. A template whose condition depends on such a form is skipped, and the scan's problems name it with its line.
- **Kustomize**: each overlay (a kustomization no other one uses) is built: bases, components, patches (strategic merge and JSON 6902), name prefixes and suffixes, namespace, labels, images, replicas and `configMapGenerator` literals. Remote bases are never fetched; the scan names them.

Deployments, routes, autoscaling and network policies come out per environment, with each container's image and environment variables as settings (a secret stays a reference, never a value). Evidence points at the template or resource file and at the values file, kustomization entry or patch behind the value.

## The org pack

Everything a team might want to change is in `org-pack/`: configuration and rule files, never code. Changes to it go through pull requests like any other code. The full schema is [contract C6](../spec/contracts/c6-org-pack.md); the files a team touches most:

| File                                      | What it decides                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack.yaml`                               | Name, version, owner, review window, how long facts stay fresh                                                                                                                            |
| `runtime.yaml`                            | What AI may do, assistants and editors, run modes, autonomy, budgets, outside systems                                                                                                     |
| `sources.yaml`                            | Wikis Atticus reads (read-only)                                                                                                                                                           |
| `gates.yaml`                              | The gate at each phase and its checklists                                                                                                                                                 |
| `change-types.yaml`, `test-strategy.yaml` | Change types and the tests each needs (built-in defaults until written)                                                                                                                   |
| `profiles/<platform>/`                    | The platform profile and `repos.manifest.yaml`                                                                                                                                            |
| `dialects/`                               | Rules that teach the scanner a house framework (`atticus dialect new`)                                                                                                                    |
| `frameworks/`                             | What a house framework means: its annotations, wrapper clients, service ids, constants, calls and routes in any language, and tests that must pass before a scan uses it (ADR 0054, 0055) |
| `patterns/`, `checklists/`                | Integration patterns and the critic's checklists, starting with the starter review (`checklists/review.yaml`)                                                                             |
| `process/`                                | Change templates, service-desk request templates, procedures and skills                                                                                                                   |
| `agents/`                                 | AI agent definitions the critic and planners use                                                                                                                                          |

A secret never goes in the org pack: Atticus refuses keys that look like one. Credentials come from the OS credential manager, Git's own helper or the plugins.

### Which assistants

`runtime.yaml` lists the assistants your people use:

```yaml
assistants: { allowed: [copilot, claude-code, cursor], default: copilot }
```

They can be `copilot`, `claude-code`, `cursor`, `gemini-cli`, `windsurf` or `agents-md`. Use `agents-md` for Codex and any other tool that reads `AGENTS.md`. `atticus assistant-files` writes the same slash commands, instructions and skills for each allowed assistant, in the files that tool reads (ADR 0121). `atticus next` tells people to type the command in the default assistant, and `atticus doctor` looks for each one's program.

In the app, **Set up › AI** sets all of this with a form: the assistants, the modes, and the model provider with its settings. Saving writes `runtime.yaml`; commit it in a pull request. **Test the provider** checks that the provider answers.

### A model provider Atticus has no built-in for

The built-in providers are Anthropic, OpenAI-compatible endpoints (with Azure OpenAI) and AWS Bedrock. For any other, such as Google Vertex AI or your organisation's own gateway, add a **model-provider plugin** in `org-pack/plugins/model-providers/<id>/` (ADR 0121):

- `plugin.yaml` names the plugin, the settings it takes, the only hosts a request may go to, and how the key is sent (`bearer`, `x-api-key`, `header:<name>` or `none`).
- `index.js` has two functions. `request` turns the prompt into a URL, headers and a body; `response` turns the provider's answer into text. They run in the plugin sandbox, with no network, files or clock. Atticus makes the call, over HTTPS to the named hosts only, through the same proxy and CA as every provider, and adds the key from `keyEnv` itself. The plugin never sees the key.
- `test/<case>/` holds golden files: `request.json` with `expected-request.json`, and `answer.json` with `expected-answer.json`.

Atticus ships one plugin, for Vertex: `atticus plugin add vertex` copies it into the org pack. It handles Anthropic's models (through `rawPredict`) and Google's (through `generateContent`). Its key is an OAuth access token, which lasts about an hour, so refresh it outside Atticus, for example in the job that starts the run.

Review the code, run `atticus plugin test <id>`, then `atticus plugin pin <id>`, and commit the folder through a pull request. Model mode uses a plugin only while its `index.js` matches the pin. Then choose it on **Set up › AI** (it is listed as a plugin), or set `adapters.model.type: <id>`.

What isn't built yet: a plugin can't call tools (tool calls need a built-in provider), and nothing refreshes a token for you.

### What AI may do here

`runtime.yaml` holds one line for it:

```yaml
ai: on # on | text-only | off
```

- `on`: AI steps run in the modes `modes.allowed` lists (hand-off to the person's own assistant by default).
- `text-only`: no AI step is given a picture; pictures in `inputs/` become items for a person in Intake.
- `off`: no AI step starts. People write what agents would draft, the critic's rule checks still review it, and every gate works without AI.

The app shows the mode in the top bar and on Settings. See ADR 0046.

### A model per kind of step

`runtime.yaml` (version 2) can name a model for each of the five kinds of AI step (`models.read`, `draft`, `critic`, `knowledge`, `quick`), so the critic's lenses and the small checks don't spend the strongest model's requests. [Choosing models at an organisation on Copilot](models.md) has a default table and the reasoning; `atticus doctor` lists what each kind runs on here.

### Calling a model directly (model mode)

Hand-off mode, the default, needs no model access: the person's own assistant does the step. To let Atticus call a model itself, allow model mode and name the provider in `runtime.yaml`. Three providers ship with Atticus (ADR 0065): `anthropic`, `openai-compatible` (also as `azure-openai`) and `bedrock`. `vertex` has none yet.

```yaml
modes: { allowed: [hand-off, model], default: hand-off }
models: { allowed: [claude-opus-5-5] } # leave empty to allow any model the adapter names
adapters:
  model:
    type: anthropic
    settings:
      model: claude-opus-5-5
      keyEnv: ATTICUS_MODEL_KEY # the NAME of the variable holding the key
```

**The key is never in runtime.yaml.** `keyEnv` names where the key is: an environment variable of that name in the environment Atticus runs in (a user environment variable, or your secrets tooling), or this machine's credential store under that name. Use `atticus secret set ATTICUS_MODEL_KEY` and pipe the key in, or the AI tab's "Set the key on this machine". The environment is read first. Atticus refuses a setting that looks like a key or token, and never prints a key: messages name the variable instead.

Settings every provider reads:

| Setting      | What it does                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`      | The model id; `models.allowed` is checked against it                                                                                                            |
| `baseUrl`    | Where to call. Must be `https://` (plain `http://` only for `localhost` or `127.0.0.1`)                                                                         |
| `keyEnv`     | The environment variable holding the key (not Bedrock)                                                                                                          |
| `timeoutMs`  | How long one request may take, default 300000 (5 minutes)                                                                                                       |
| `maxRetries` | Retries after 429, 5xx or a dropped connection, default 3, at most 6. `Retry-After` is honoured up to 60 seconds                                                |
| `maxOutput`  | The most output tokens to ask for, default 16000. Lower it for a model with a smaller limit                                                                     |
| `maxInput`   | The model's input limit in tokens (1000 or more), optional. The app's server gives it to every step it starts as `--max-tokens`, so each prompt fits (ADR 0112) |
| `caFile`     | A PEM file of extra certificate authorities for model calls, added to Node's own list and `NODE_EXTRA_CA_CERTS`                                                 |

**Anthropic**, directly or through a gateway that speaks the Messages API:

```yaml
model:
  type: anthropic
  settings:
    model: claude-opus-5-5
    keyEnv: ATTICUS_MODEL_KEY
    # baseUrl: https://llm-gateway.tidewater.example/anthropic   # a gateway; default https://api.anthropic.com
    # auth: bearer                                               # if the gateway wants Authorization: Bearer
```

**Azure OpenAI** (a deployment, the `api-key` header and an API version):

```yaml
model:
  type: azure-openai
  settings:
    baseUrl: https://tidewater-ai.openai.azure.com
    deployment: atticus-gpt
    apiVersion: "2024-10-21"
    keyEnv: ATTICUS_AZURE_OPENAI_KEY
    # model: gpt-4o        # what models.allowed checks; defaults to the deployment name
    # auth: bearer         # if the variable holds a Microsoft Entra ID token instead of a key
```

**An internal LLM gateway, vLLM or another server that speaks OpenAI's Chat Completions:**

```yaml
model:
  type: openai-compatible
  settings:
    baseUrl: https://llm-gateway.tidewater.example/v1 # Atticus calls {baseUrl}/chat/completions
    model: tidewater-llm-70b
    keyEnv: ATTICUS_GATEWAY_KEY # sent as Authorization: Bearer; leave out if the gateway takes none
    # outputLimitField: max_completion_tokens   # for servers that reject max_tokens
```

**AWS Bedrock** (the Converse API, signed with the standard AWS environment variables):

```yaml
model:
  type: bedrock
  settings:
    model: anthropic.claude-opus-5-5 # a model id or an inference profile id
    region: us-east-1 # or AWS_REGION in the environment
    # baseUrl: https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com   # a VPC endpoint
```

Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN`. Atticus doesn't read AWS profiles or SSO itself; `aws configure export-credentials --format env` prints the variables for a profile. The role needs `bedrock:InvokeModel` on the model, and model access must be granted in the region.

**Behind a corporate proxy.** Atticus reads `HTTPS_PROXY` (then `HTTP_PROXY`) and `NO_PROXY`, in upper or lower case, for model calls. Proxy credentials can go in the proxy URL (`http://user:password@proxy.tidewater.example:8080`); they are sent to the proxy and never printed. `NO_PROXY` takes host names, `.domain` suffixes, `host:port`, IPs and `*`, not CIDR ranges. If the proxy inspects TLS with your organisation's own certificate authority, set `NODE_EXTRA_CA_CERTS` to that CA's PEM file before starting Atticus (the same setting `atticus doctor` checks), or name it in `caFile`. Atticus never turns certificate checks off.

An organisation with its own client can register a provider in code (`registerModelProvider` from `@maycombhq/ai`) under a type runtime.yaml accepts, replacing the built-in one; a new type name needs a change to contract C6. There is no loader yet that picks a provider plugin up from configuration. See ADR 0065.

### Small changes (the fast path)

A change type marked small in `change-types.yaml` (version 2) goes from brief to tasks in one AI step, `atticus change small <change>`, with every check the feature, architecture and stories stages run and the critic at one gate (ADR 0113):

```yaml
schemaVersion: 2
types:
  - id: small-change
    name: Small change
    size: small
    phases: [plan, build, release]
    artifacts: [brief, proposal, design, stories, tasks]
  - id: config-change
    name: Configuration change
    smallWhenBriefSays: true # a brief with the line "Size: small" takes the fast path
    phases: [define, plan, build, release]
    artifacts: [proposal, tasks, snow]
```

A small type has at most one phase before build, so its plan is one hand-off PR; the gates it keeps are the gates of its phases, and `fastGate: <gate id>` picks the one whose critic reviews the step (by default the gate of its last phase before build). A brief that says `Size: standard` takes the full path whatever the type. A version 1 file still reads, every type standard; `atticus upgrade` moves it to version 2 without changing what any type does. The built-in types include `small-change`.

### The starter review (the critic's AI rules)

The critic's AI lenses review every draft a stage writes, with Copilot too, but only where the org pack has AI rules for that gate and lens (ADR 0115). The built-in constitution has deterministic rules only, so `atticus init` and `atticus adopt` write a starter review into `org-pack/checklists/review.yaml` (ADR 0120): ten AI rules, each a prompt in plain words that asks a lens to judge the draft's meaning against the estate and the brief.

| Gate   | Lens         | The rule asks                                                                                           | Severity |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------- | -------- |
| define | business     | Is every outcome the brief states placed?                                                               | blocking |
| define | architecture | Is a flow the change alters marked only read?                                                           | blocking |
| define | architecture | Is a capability the brief assumes, but nothing in the estate does, named as a gap?                      | blocking |
| design | architecture | Does every outcome have the target-flow steps that deliver it?                                          | blocking |
| design | architecture | Does data a step returns or shows come from somewhere?                                                  | blocking |
| design | architecture | Does a new column have its classification and migration, and does the classification fit what it holds? | blocking |
| design | architecture | Does each hop's approved pattern fit what the hop does?                                                 | risk     |
| plan   | story        | Does each outcome have a story?                                                                         | blocking |
| plan   | story        | Is each criterion testable, naming the data it checks?                                                  | risk     |
| plan   | delivery     | Are requests and approvals raised before the phase that needs them?                                     | risk     |

The gate is where a rule's artifacts are first due (brief at define; design, data and interfaces at design; stories and tasks at plan). A rule runs again at each later gate, and only for change types whose lenses include its lens. Every finding quotes the line it cites, like any lens finding.

It is your configuration, not the constitution. Change it through a pull request like any other checklist:

- **Change a rule**: edit its `prompt`, `title` or `severity`. A blocking rule is waivable; set `waivable: false` to stop that. Only blocking rules can be waivable.
- **Turn one rule off**: set `status: retired` on it, or delete it.
- **Turn the starter review off**: delete `review.yaml`. `atticus upgrade` won't add it back.
- **Add your own**: write another checklist file beside it, with `check: { type: ai, prompt: ... }` for a lens's judgment or a deterministic check. A gate in `gates.yaml` that names `checklists` runs only those packs; the defaults name none, so every pack runs.

`atticus upgrade` adds the starter review to an older metarepo once, unless the org pack already has a `review.yaml` or any checklist with an AI rule; it never changes a checklist you wrote. `atticus init --from <pack>` copies your pack as it is, without the starter review.

### How the steps find their context (retrieval)

The steps that use the context engine (change needs, feature, architecture, stories) search the index for what their input is about. `runtime.yaml` `retrieval` sets how (ADR 0116 and its addendum). Leaving the section out, or writing `retrieval: {}`, gives the defaults:

```yaml
retrieval:
  embeddings:
    model: bundled # or off, or a model folder with atticus-model.yaml
    # runtime: ../tools/onnx # a folder whose node_modules holds onnxruntime, if it isn't beside Atticus
  expansion: true # your assistant first reads what the input is about
  rerank: false # not measured yet
```

- **Search by meaning (`embeddings`).** `bundled` is all-MiniLM-L6-v2 (87 MB, Apache-2.0), an optional plugin: npm installs it with Atticus, the model and this platform's onnxruntime inside the packages (nothing to fetch, no install script; ADR 0124 addendum D-npm), and the offline bundle carries it with onnxruntime only when built with `pnpm bundle --with-embeddings` (the default bundle leaves it out, ADR 0124 addendum D-bundle). On the retrieval eval it found 0.96 of what a step needed, against 0.81 by words and names alone (`docs/evidence/context-eval.md`). It runs on the machine, on the CPU, and nothing is ever downloaded. Where the model or onnxruntime isn't installed (the default offline bundle, a checkout without `pnpm model:fetch`, or an organisation that hasn't approved them yet), the engine searches by words and names, never fails a step, and `atticus doctor` says so under "Embedding model". Set `model: off` to say your organisation doesn't use one. The model's training data needs your legal team's sign-off (ADR 0116 lists it); a model you name by folder is a one-line switch.
- **The expansion.** One small call (a 6,000-token budget, within GPT-4o mini's reach) before a step's selection: your assistant reads the step's input and the estate's names and says what it is about in the estate's words, and every name it uses. Atticus checks each name against the input and each id against the index. The names the estate doesn't know become the step's gaps, so a vendor named only in a sentence is asked about. In hand-off mode it is one extra round per step (one prompt, then the step's own); its answer is kept in `judgments/expansion/`, so the same input with the same estate names is never asked again, and an answer that fails its check is left out with a note while the step goes on by words and names. `expansion: false` turns it off; then only names the input marks by their form (an endpoint, a name in backticks) are asked about.
- **The rerank** orders the candidates when they don't fit the room. It is built but not measured, so it is off.

### Outside systems

`runtime.yaml` `adapters` names the work tracker, service desk, Git host, wiki, notifications and design tool. Each can be a live adapter (a plugin), `manual` (Atticus writes a step a person does, with every field ready to copy, and records the result) or left out. A live adapter that can't be reached falls back to manual steps on its own (ADR 0032). Every write to a shared system needs a person's approval, whatever the adapter.

### OpenSpec stores (beta)

OpenSpec's stores are a beta feature: an `openspec/` folder in its own Git repo, marked by `.openspec-store/store.yaml`. Each developer registers a clone once with `openspec store register <path>`. Atticus works with stores but never needs them (ADR 0126). Everything below is off until you turn it on, and Atticus never registers, clones, pulls or pushes a store.

- **Make the metarepo a store.** Run `atticus init <folder> --platform <p> --openspec-store` for a new metarepo, or `atticus upgrade --openspec-store` in an existing one. Either writes `.openspec-store/store.yaml` with the org pack's name as the store id. Commit it in a pull request. Then a developer runs `openspec store register <their clone>`, and plain OpenSpec sees the metarepo's changes and specs from anywhere with `--store <id>`. A repo adopted in place can't be a store, because its OpenSpec folder isn't at its root.
- **Give code repos the metarepo as context.** In `org-pack/openspec.yaml`, set `referenceInRepos: true`. Each hand-down then adds the metarepo under `references:` in the repo's own `openspec/config.yaml`, with its origin as `remote`, in the commit on the change branch. It only edits a config that is already there, and keeps its comments and other keys. The metarepo must be a store first; when it isn't, the hand-down says so and writes nothing.
- **Read stores you already have.** List them by the path of a clone. Their open changes then show in `atticus change list` under "From OpenSpec stores (read-only, beta)", each with its store. `atticus openspec check` gives each store's changes and specs. `atticus feature spec` says when a store already has a spec for the capability it drafts. Atticus never writes into these stores or validates them.

```yaml
# org-pack/openspec.yaml (optional)
schemaVersion: 1
stores:
  - path: ../forge-payments-store # relative to the metarepo, absolute, or ~/...
    label: payments # default: the store's id
referenceInRepos: false
```

`atticus doctor` has an "OpenSpec stores (beta)" line. It warns when the installed OpenSpec has no stores but this metarepo uses them; the OpenSpec Atticus ships (1.14.0) has them. Store names, flags and formats may change in OpenSpec. A store file in a newer format is still read, with a note.

### Who you are and how approving works

Atticus has no roles, views or sign-in (ADR 0073). Each person is the metarepo's **Git user** (`git config user.name` and `user.email`), which the app shows in the top bar and every command records as `by`; `--by <handle>` names someone else. With no Git user set, Atticus uses the OS user name and warns until it is set.

**A gate is approved when its hand-off PR merges.** Who may approve is the Git host's business: put the rules on the metarepo with branch protection, required reviews and CODEOWNERS (Atticus names the CODEOWNERS of a phase's files as the PR's reviewers). The person who raised a PR is never its only approver. Waiving a finding, accepting the catalog baseline and release go / no-go are files in the metarepo recorded with the person's name, and reach main through a pull request like everything else.

Every write to a shared outside system (the Git host, the work tracker, the service desk, notifications) still needs the person's explicit confirmation: the command is a dry run until they add `--approve`, and the app's buttons say exactly what they send. This can't be configured away.

`roles.yaml` is deprecated. A pack that has one still loads and validates, but nothing reads it: not its `mappings`, `approvals` or `separation`, nor the `approvers` and `minApprovals` in `gates.yaml`, the `approvals` in `change-types.yaml`, or `privacy.role`, `risk.approvals` and `selfApproval` in `process/change-policy.yaml`. `atticus init` no longer writes it. Move what it said to branch protection and CODEOWNERS, then delete it.

`process/change-policy.yaml` may also set `stages`, the stage path (ADR 0087 addendum): for each stage its `phase`, the `loop` file it keeps, the `command` that runs it, the files it `writes` and the change type's `artifacts` it writes. A change whose folder holds a stage's loop file is on the stage path: `change status` and the hand-off then want each phase's stage done and its files, not `proposal.md` and `specs/`. Left out, the built-in feature, architecture and stories stages apply; a list you write replaces them, so add `snow` to the stories stage's `artifacts` if your plan hand-off needs `snow.md`.

`process/change-policy.yaml` may also set `questionsPerStop` (default 5): the most questions one stop of a stage asks a person (ADR 0117 addendum). The rest wait, and are asked once those are answered; the stop says how many wait. It may also set `draftSelfChecks` (default 3): how many times a stage's drafter checks its own draft with the stage's checks before the draft is handed in as it is (ADR 0087 addendum).

## Day to day

| Task                                   | How                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the catalog current               | `atticus scan` (incremental; `--full` ignores the cache). One scan runs at a time per metarepo                                                                   |
| Bring in documents                     | `atticus intake add <files>`, then decide what needs a person: `atticus triage`, or the Intake screen                                                            |
| Give one change its documents          | `atticus change attach <change> <files...>`, or Attach a file on the change's page (ADR 0113)                                                                    |
| Start from an earlier change           | `atticus change similar "<brief>"`, then `change new --like <archived>` or `change attach <change> --like <archived>`; on the app, the change's At a glance page |
| Start a task with its context          | `/atticus-task <change> <task>` in Copilot or Claude Code, or `atticus task context <change> <task>`                                                             |
| Answer owner questions                 | `atticus questions`, or the questions on the Ecosystem map                                                                                                       |
| Check the pipeline matches the catalog | `atticus ci snippet <github\|azure\|gitlab\|jenkins>` adds the drift check to a repo's pipeline                                                                  |
| Watch AI quality                       | `atticus eval report`, or the AI quality screen                                                                                                                  |
| Look for planted instructions          | `atticus defences scan`                                                                                                                                          |
| See what waits on you                  | Home, or `atticus digest --as <you>`                                                                                                                             |

## Logs, problems and support

- **The log** is `.atticus/logs/atticus.log`: each command with its flag names (never their values), exit code and time; the app's API calls when they fail; crashes with their stack. It is redacted before it is written and never leaves the machine. `ATTICUS_LOG=debug` records more; `off` records nothing.
- **The prompt history** is `.atticus/history/<yyyy-mm>.jsonl` (ADR 0110): each prompt a person sent their assistant in the metarepo and each reply, one JSON object per line, with its session and the change it is about when that can be told exactly. It is written only by `atticus history add`, which the Claude Code plugin's hooks and VS Code's `@atticus` call; Copilot's other chats, and anything typed in IntelliJ, can't be recorded. A record keeps at most 64 KB of text (a longer one is cut and marked), and what matches the log's secret patterns is masked and the record marked. It stays on the machine (`.atticus/.gitignore`). Recording is on by default: `atticus history off` stops it for one person, `history: { record: false }` in `runtime.yaml` for everyone. Read it with `atticus history`, the app's Prompt history screen or the `prompt_history` MCP tool.
- **When something breaks**, the terminal says where the log is. Run `atticus doctor` first.
- **To hand a problem to someone**, run `atticus support bundle`. It writes a zip of versions, the machine checks, the setup checklist, org-pack problems, counts (never names) and the redacted log. Read every file before it leaves your organisation: an error message can name one of your systems.

More in [troubleshooting](troubleshooting.md).

## Upgrades and backups

Install the new version on every machine, then one person runs `atticus upgrade` in the metarepo and opens a pull request with what it changed. Files it changes are copied to `.atticus/backups/<time>/` first. `atticus upgrade --check` exits 1 while an upgrade is pending, for a pipeline that should insist. The metarepo itself is the backup of everything else: the catalog, changes and org pack are files in Git, and the local index rebuilds from them (`atticus index rebuild`).

## Publishing to npm

For whoever releases Atticus (ADR 0124 addenda D-npm and D-npm2). Nine packages are published to the public npm registry under the `maycombhq` scope, so a company's mirror (Artifactory, Nexus) can proxy them and `npm install -g @maycombhq/atticus` brings everything, search by meaning included:

- **`@maycombhq/atticus`**: the command line (`bin` `atticus`) and its app, self-contained. Its build (`packages/atticus`, `scripts/bundle/npm-atticus.mjs`) bundles the CLI's workspace packages and their third-party JavaScript with esbuild, and OpenSpec as a program of its own, and copies what they read at run time (rules, the constitution, schemas, the assistant kits, lessons, the app's web files, the Forge fixtures, tree-sitter's grammars). `dist/files.json` lists every file with its sha256; `THIRD-PARTY-LICENSES.txt` holds every bundled third party's licence.
- **`@maycombhq/sdk`**: the plugin SDK (C4), with what it uses of the core bundled in and its types beside it; it depends only on `zod` and `yaml`.
- **`@maycombhq/embed-model`** and the six **`@maycombhq/onnxruntime-*`** packages: optional dependencies of `@maycombhq/atticus`, carrying their files. Each one's `prepack` fills it from `.cache/pinned` with no network, checks every file against its `pins.json`, and refuses to pack when one is missing or wrong.

Every other workspace package is private: built and tested in the monorepo, never published. No package has an install script.

Once:

1. On npmjs.com, sign in and create the organisation `maycombhq` (Add organization; the free plan publishes public packages). Add the people who may publish.
2. On your machine: `npm login` (it opens the browser). `npm whoami` prints your user; `npm org ls maycombhq` lists you.
3. For the workflow: create an npm token that may publish to the scope (a granular access token with read and write on `@maycombhq`, or an automation token), and store it as the `NPM_TOKEN` secret of the GitHub environment `npm` (Settings, Environments; add a required reviewer there so a person approves each publish). Provenance needs a public repository: when it is public, set the repository variable `NPM_PROVENANCE` to `true`.

Each release, from a clean checkout of the release tag:

```bash
pnpm install --frozen-lockfile
pnpm build                        # builds @maycombhq/atticus and the SDK's npm/ too
pnpm model:fetch                  # the model and onnxruntime into .cache/pinned, each checked against pins.json
pnpm licences                     # every licence, the bundled third parties' too
pnpm npm:test                     # pack, a throwaway mirror, npm install -g --ignore-scripts, used offline
pnpm release:npm --dry-run        # the pack check, then pnpm publish --dry-run of the nine: nothing uploaded
pnpm release:npm                  # the pack check, then pnpm publish --access public --tag beta --no-git-checks
```

`pnpm release:npm` publishes, of the nine, each package whose version npm doesn't have yet, dependencies first; `--tag <tag>` picks the dist-tag (by default the prerelease word of `@maycombhq/atticus`'s version, `beta`, else `latest`), and `--pack-only` stops after the check. On npm's rate limit (429) it waits and publishes what is still missing. The onnxruntime packages keep onnxruntime's version (1.30.0), so they are published once and then only when onnxruntime moves. The same steps run in `.github/workflows/publish-npm.yml` when a GitHub release is published (started by hand, it is a dry run unless you untick it). About 162 MB is uploaded in all, the model's package 79 MB of it and `@maycombhq/atticus` 6 MB.

**The names 2.0.0-beta.1 published** (`@maycombhq/cli`, `@maycombhq/core` and 37 more) are private from 2.0.0-beta.2. Once `@maycombhq/atticus` is on npm, mark them deprecated so an install of an old name says where Atticus went:

```bash
pnpm release:npm:deprecate        # a dry run: prints the 39 npm deprecate commands, runs nothing
pnpm release:npm:deprecate --yes  # runs them: "Atticus is now one package: npm install -g @maycombhq/atticus"
```

A name npm doesn't have (beta.1's publish stopped at 25 of 47) is skipped. **Release notes** for a version say how to install it: `npm install -g @maycombhq/atticus@<version>` from the mirror, or the offline bundle `atticus-<version>-offline.zip`.

## Security

Read the [threat model](../security/threat-model.md). In short: the app listens on 127.0.0.1 only and every call needs a per-start token; ingested content is data, never instructions; a person approves every write to a shared system; AI never pushes to a protected branch or deploys; Atticus never connects to live databases, consoles or monitoring. None of these can be configured away.
