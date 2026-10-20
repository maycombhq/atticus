# Running Atticus for a team (platform lead)

This guide is for the person who sets Atticus up for a team and keeps it healthy: usually the platform lead, with the architect for the catalog and the process owner for procedures. Install first: [installing Atticus](install.md).

## The setup checklist

Home shows it until the catalog is accepted; `atticus setup` prints it. Each step says what to do next:

1. **This machine has what Atticus needs** (`atticus doctor`).
2. **The org pack is valid** (`atticus orgpack validate`).
3. **Repos are listed** (`atticus repos discover <folder>`, then add the proposals to `repos.manifest.yaml`). Give each repo the `hosts` its component answers on, and the gateway repo its gateway's hosts (`hosts: [api-gw.example.internal]`, `*` for any part of a label): calls join components and go through gateways only on hosts listed here (ADR 0053). A scan note names each undeclared host that looks like a gateway.
4. **Repos are cloned here** (`atticus workspace sync`, or _Sync repos_ on the Scans screen).
5. **The first scan is done** (`atticus scan`, or _Scan now_). Scans read files only: no network, no AI.
6. **Groups are mapped to roles** (`org-pack/roles.yaml`, below).
7. **Existing knowledge is added** (optional): diagrams, partner specs and exports in `inputs/` (`atticus intake add <files>`), wikis in `sources.yaml` (`atticus sources add`).
8. **The catalog is accepted**: walk the ecosystem map with the architect, then `atticus baseline --by <you>` or _Accept the catalog_ on Home. Every later scan, document and change is compared with this baseline.

## The org pack

Everything a team might want to change is in `org-pack/`: configuration and rule files, never code. Changes to it go through pull requests like any other code. The full schema is [contract C6](../spec/contracts/c6-org-pack.md); the files a team touches most:

| File                                      | What it decides                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack.yaml`                               | Name, version, owner, review window, how long facts stay fresh                                                                                                                            |
| `runtime.yaml`                            | What AI may do, assistants and editors, run modes, autonomy, budgets, outside systems                                                                                                     |
| `roles.yaml`                              | Optional roles, directory groups mapped to roles, who approves what, separation of duties                                                                                                 |
| `sources.yaml`                            | Wikis Atticus reads (read-only)                                                                                                                                                           |
| `gates.yaml`                              | The gate at each phase, its approvers and checklists                                                                                                                                      |
| `change-types.yaml`, `test-strategy.yaml` | Change types and the tests each needs (built-in defaults until written)                                                                                                                   |
| `profiles/<platform>/`                    | The platform profile and `repos.manifest.yaml`                                                                                                                                            |
| `dialects/`                               | Rules that teach the scanner a house framework (`atticus dialect new`)                                                                                                                    |
| `frameworks/`                             | What a house framework means: its annotations, wrapper clients, service ids, constants, calls and routes in any language, and tests that must pass before a scan uses it (ADR 0054, 0055) |
| `patterns/`, `checklists/`                | Integration patterns and the critic's checklists                                                                                                                                          |
| `process/`                                | Change templates, service-desk request templates, procedures and skills                                                                                                                   |
| `agents/`                                 | AI agent definitions the critic and planners use                                                                                                                                          |

A secret never goes in the org pack: Atticus refuses keys that look like one. Credentials come from the OS credential manager, Git's own helper or the plugins.

### What AI may do here

`runtime.yaml` holds one line for it:

```yaml
ai: on # on | text-only | off
```

- `on`: AI steps run in the modes `modes.allowed` lists (hand-off to the person's own assistant by default).
- `text-only`: no AI step is given a picture; pictures in `inputs/` become items for a person in Intake.
- `off`: no AI step starts. People write what agents would draft, the critic's rule checks still review it, and every gate works without AI.

The app shows the mode in the top bar and on Settings. See ADR 0046.

### Outside systems

`runtime.yaml` `adapters` names the work tracker, service desk, Git host, wiki, notifications and design tool. Each can be a live adapter (a plugin), `manual` (Atticus writes a step a person does, with every field ready to copy, and records the result) or left out. A live adapter that can't be reached falls back to manual steps on its own (ADR 0032). Every write to a shared system needs a person's approval, whatever the adapter.

### Roles, views and approvals

```yaml
enabledOptional: [data-architect, sre]
mappings:
  - { group: "Forge Architects", role: architect }
approvals:
  waiver: { roles: [architect], groups: ["Forge Architects"] }
  catalog-assert: { people: [ari] }
separation:
  - actions: ["author:design", "approve:design"]
    reason: The author of a design can't approve it.
```

A person's **view** (the role their home and sidebar follow) comes from a group mapping, or they pick one. Views change what a person sees, never what they may approve. **Approvals** come only from ownership: people, groups or roles named here, and CODEOWNERS for the files in a hand-off PR. Each person's groups and chosen view live in `.atticus/me.yaml` on their own machine.

## Day to day

| Task                                   | How                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Keep the catalog current               | `atticus scan` (incremental; `--full` ignores the cache). One scan runs at a time per metarepo        |
| Bring in documents                     | `atticus intake add <files>`, then decide what needs a person: `atticus triage`, or the Intake screen |
| Answer owner questions                 | `atticus questions`, or the questions on the Ecosystem map                                            |
| Check the pipeline matches the catalog | `atticus ci snippet <github\|azure\|gitlab\|jenkins>` adds the drift check to a repo's pipeline       |
| Watch AI quality                       | `atticus eval report`, or the AI quality screen                                                       |
| Look for planted instructions          | `atticus defences scan`                                                                               |
| See what waits on you                  | Home, or `atticus digest --as <you>`                                                                  |

## Logs, problems and support

- **The log** is `.atticus/logs/atticus.log`: each command with its flag names (never their values), exit code and time; the app's API calls when they fail; crashes with their stack. It is redacted before it is written and never leaves the machine. `ATTICUS_LOG=debug` records more; `off` records nothing.
- **When something breaks**, the terminal says where the log is. Run `atticus doctor` first.
- **To hand a problem to someone**, run `atticus support bundle`. It writes a zip of versions, the machine checks, the setup checklist, org-pack problems, counts (never names) and the redacted log. Read every file before it leaves your organisation: an error message can name one of your systems.

More in [troubleshooting](troubleshooting.md).

## Upgrades and backups

Install the new version on every machine, then one person runs `atticus upgrade` in the metarepo and opens a pull request with what it changed. Files it changes are copied to `.atticus/backups/<time>/` first. `atticus upgrade --check` exits 1 while an upgrade is pending, for a pipeline that should insist. The metarepo itself is the backup of everything else: the catalog, changes and org pack are files in Git, and the local index rebuilds from them (`atticus index rebuild`).

## Security

Read the [threat model](../security/threat-model.md). In short: the app listens on 127.0.0.1 only and every call needs a per-start token; ingested content is data, never instructions; a person approves every write to a shared system; AI never pushes to a protected branch or deploys; Atticus never connects to live databases, consoles or monitoring. None of these can be configured away.
