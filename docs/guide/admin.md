# Running Atticus for a team (platform lead)

This guide is for the person who sets Atticus up for a team and keeps it healthy: usually the platform lead, with the architect for the catalog and the process owner for procedures. Install first: [installing Atticus](install.md).

## The setup checklist

Home shows it until the catalog is accepted; `atticus setup` prints it. Each step says what to do next:

1. **This machine has what Atticus needs** (`atticus doctor`).
2. **The org pack is valid** (`atticus orgpack validate`).
3. **Repos are listed** (`atticus repos discover <folder>`, then add the proposals to `repos.manifest.yaml`). Give each repo the `hosts` its component answers on, and the gateway repo its gateway's hosts (`hosts: [api-gw.example.internal]`, `*` for any part of a label): calls join components and go through gateways only on hosts listed here (ADR 0053). A scan note names each undeclared host that looks like a gateway. A repo that builds several deployables lists them under `modules` (`- { path: accounts-api, component: accounts-api, hosts: [accounts.example.internal] }`), each with its own component and hosts; a repo with two or more Spring Boot apps gets one per app without it, named after each app (ADR 0057). A call to a vendor joins the vendor's system when a label of its host is the vendor's id, name or one of its `aliases` in the profile, written without spaces or dashes (`api.northwindpay.example` → Northwind Pay); give vendors the aliases their hosts use.
4. **Repos are cloned here** (`atticus workspace sync`, or _Sync repos_ on the Scans screen).
5. **The first scan is done** (`atticus scan`, or _Scan now_). Scans read files only: no network, no AI.
6. **Existing knowledge is added** (optional): diagrams, partner specs and exports in `inputs/` (`atticus intake add <files>`), wikis in `sources.yaml` (`atticus sources add`).
7. **The catalog is accepted**: walk the ecosystem map with the architect, then `atticus baseline` or _Accept the catalog_ on Home. It writes `catalog/baseline.yaml` with your name (your Git user); commit it and open a pull request, whose merge makes it the baseline on main. Every later scan, document and change is compared with this baseline.

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

### What AI may do here

`runtime.yaml` holds one line for it:

```yaml
ai: on # on | text-only | off
```

- `on`: AI steps run in the modes `modes.allowed` lists (hand-off to the person's own assistant by default).
- `text-only`: no AI step is given a picture; pictures in `inputs/` become items for a person in Intake.
- `off`: no AI step starts. People write what agents would draft, the critic's rule checks still review it, and every gate works without AI.

The app shows the mode in the top bar and on Settings. See ADR 0046.

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

**The key is never in runtime.yaml.** `keyEnv` names an environment variable; set that variable in the environment Atticus runs in (a user environment variable, or your secrets tooling). Atticus refuses a setting that looks like a key or token, and never prints a key: messages name the variable instead.

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

### Outside systems

`runtime.yaml` `adapters` names the work tracker, service desk, Git host, wiki, notifications and design tool. Each can be a live adapter (a plugin), `manual` (Atticus writes a step a person does, with every field ready to copy, and records the result) or left out. A live adapter that can't be reached falls back to manual steps on its own (ADR 0032). Every write to a shared system needs a person's approval, whatever the adapter.

### Who you are and how approving works

Atticus has no roles, views or sign-in (ADR 0073). Each person is the metarepo's **Git user** (`git config user.name` and `user.email`), which the app shows in the top bar and every command records as `by`; `--by <handle>` names someone else. With no Git user set, Atticus uses the OS user name and warns until it is set.

**A gate is approved when its hand-off PR merges.** Who may approve is the Git host's business: put the rules on the metarepo with branch protection, required reviews and CODEOWNERS (Atticus names the CODEOWNERS of a phase's files as the PR's reviewers). The person who raised a PR is never its only approver. Waiving a finding, accepting the catalog baseline and release go / no-go are files in the metarepo recorded with the person's name, and reach main through a pull request like everything else.

Every write to a shared outside system (the Git host, the work tracker, the service desk, notifications) still needs the person's explicit confirmation: the command is a dry run until they add `--approve`, and the app's buttons say exactly what they send. This can't be configured away.

`roles.yaml` is deprecated. A pack that has one still loads and validates, but nothing reads it: not its `mappings`, `approvals` or `separation`, nor the `approvers` and `minApprovals` in `gates.yaml`, the `approvals` in `change-types.yaml`, or `privacy.role`, `risk.approvals` and `selfApproval` in `process/change-policy.yaml`. `atticus init` no longer writes it. Move what it said to branch protection and CODEOWNERS, then delete it.

## Day to day

| Task                                   | How                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Keep the catalog current               | `atticus scan` (incremental; `--full` ignores the cache). One scan runs at a time per metarepo        |
| Bring in documents                     | `atticus intake add <files>`, then decide what needs a person: `atticus triage`, or the Intake screen |
| Give one change its documents          | `atticus change attach <change> <files...>`, or Attach a file on the change's page (ADR 0113)         |
| Start a task with its context          | `/atticus-task <change> <task>` in Copilot or Claude Code, or `atticus task context <change> <task>`  |
| Answer owner questions                 | `atticus questions`, or the questions on the Ecosystem map                                            |
| Check the pipeline matches the catalog | `atticus ci snippet <github\|azure\|gitlab\|jenkins>` adds the drift check to a repo's pipeline       |
| Watch AI quality                       | `atticus eval report`, or the AI quality screen                                                       |
| Look for planted instructions          | `atticus defences scan`                                                                               |
| See what waits on you                  | Home, or `atticus digest --as <you>`                                                                  |

## Logs, problems and support

- **The log** is `.atticus/logs/atticus.log`: each command with its flag names (never their values), exit code and time; the app's API calls when they fail; crashes with their stack. It is redacted before it is written and never leaves the machine. `ATTICUS_LOG=debug` records more; `off` records nothing.
- **The prompt history** is `.atticus/history/<yyyy-mm>.jsonl` (ADR 0110): each prompt a person sent their assistant in the metarepo and each reply, one JSON object per line, with its session and the change it is about when that can be told exactly. It is written only by `atticus history add`, which the Claude Code plugin's hooks and VS Code's `@atticus` call; Copilot's other chats, and anything typed in IntelliJ, can't be recorded. A record keeps at most 64 KB of text (a longer one is cut and marked), and what matches the log's secret patterns is masked and the record marked. It stays on the machine (`.atticus/.gitignore`). Recording is on by default: `atticus history off` stops it for one person, `history: { record: false }` in `runtime.yaml` for everyone. Read it with `atticus history`, the app's Prompt history screen or the `prompt_history` MCP tool.
- **When something breaks**, the terminal says where the log is. Run `atticus doctor` first.
- **To hand a problem to someone**, run `atticus support bundle`. It writes a zip of versions, the machine checks, the setup checklist, org-pack problems, counts (never names) and the redacted log. Read every file before it leaves your organisation: an error message can name one of your systems.

More in [troubleshooting](troubleshooting.md).

## Upgrades and backups

Install the new version on every machine, then one person runs `atticus upgrade` in the metarepo and opens a pull request with what it changed. Files it changes are copied to `.atticus/backups/<time>/` first. `atticus upgrade --check` exits 1 while an upgrade is pending, for a pipeline that should insist. The metarepo itself is the backup of everything else: the catalog, changes and org pack are files in Git, and the local index rebuilds from them (`atticus index rebuild`).

## Security

Read the [threat model](../security/threat-model.md). In short: the app listens on 127.0.0.1 only and every call needs a per-start token; ingested content is data, never instructions; a person approves every write to a shared system; AI never pushes to a protected branch or deploys; Atticus never connects to live databases, consoles or monitoring. None of these can be configured away.
