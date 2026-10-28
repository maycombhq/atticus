# Atticus

**Your AI assistant reads the code; Atticus checks every fact it writes against the line it cites, then runs each change from idea to tasks on that map, with a critic that argues the other side and a person's approval at every gate.**

Atticus is an open-source framework for teams whose systems span many repositories, gateways, event streams and vendors. It builds on [OpenSpec](https://github.com/Fission-AI/openspec) and works with the assistant you already use: Claude Code, GitHub Copilot (VS Code or IntelliJ), Cursor, or any chat you can paste into.

> **Status: beta 2.0.0-beta.8 (Atticus 2, ADR 0124).** The map now comes from the assistant's cited facts, not from Atticus's own parsers. All five parts are built and measured on public repos; several bars are not met yet (below). What is open is in [docs/build-status.md](docs/build-status.md), under "Where Atticus 2 stands".

## The five parts

1. **Map: the assistant reads, Atticus verifies.** The assistant reads a repo (`/atticus-map`) and writes facts: what it serves, calls and stores, the fields crossing each boundary, where it deploys, the config naming other systems, and flows through them. Each fact gives its file, line, claimed value and quote. `atticus verify` checks that the file exists at the commit, that the claimed value is on the cited line, that the quote matches and references resolve, that no secret is quoted, and reports coverage. Fabricated or misplaced citations are rejected. `atticus verify --write` projects the kept facts into the catalog (contract C1) and renders `map.md`, `flows/` and OpenAPI `contracts/` for review in a pull request. With several repos, `verify --write` joins each call to the entry in another repo that serves it, citing both ends. If a host matches no repo, it asks a person instead of guessing. `atticus join` then follows flows from repo to repo through those joins. The built-in readers remain as an optional cross-check.
2. **Change, in three stages.** Feature, architecture, then stories and tasks. In each stage the assistant drafts, Atticus checks the draft in code, the critic argues, open points become questions, and the stage closes when its hand-off pull request merges. The architecture stage drafts target flows, contract deltas, data changes and a deploy order. Code then checks that every delta cites a fact and that a breaking change lists its consumers from the map. It also checks that a new table has a migration, classification and retention, and that the order puts a callee before its caller and a migration before its code.
3. **Stories and tasks, with acceptance criteria and a completeness check.** A story has context, scope, Given/When/Then criteria including error cases, interface and data changes, non-functional needs, test notes, dependencies and a definition of done. Each task names the files to touch and the command to run. Before the critic sees a story, a completeness check rejects:
   - an entry the flows add that the story leaves out;
   - an invented field or column;
   - a new request field with no validation or error criterion;
   - column facts that differ from the target flow's.
4. **The critic's four questions.** Is it true to the code? Is it complete? Is it safe to build? Can it ship? Code answers what it can, and then one AI lens per question reads the rest in a fresh session, bound to evidence. Constitution rules can't be waived, and organisations add their own rules on top. Org packs written for the old seven role lenses still work.
5. **Knowledge.** `atticus knowledge scan` indexes the organisation's wikis and documents into patterns, standards, decisions, processes, vendors and terms. Quotes are checked word for word, conflicts and superseded pages are flagged, and injected instructions are cut out. Each stage lists the items that apply to a change, with near-misses, in the change's `knowledge.yaml`. `atticus change knowledge` confirms or excludes items.

The rule behind all five: the assistant does the thinking; Atticus keeps the files, checks them in deterministic code, and names the next step. Tests never call a model.

## Any assistant: three tiers and the probe

- **Tier 1, agentic** (Claude Code, Cursor, Copilot agent mode): the assistant opens files and runs commands. Reading a repo takes one session.
- **Tier 2, chat with a token limit and no file tools** (Copilot Chat): `atticus map <repo> --handoff` splits the repo into batches that fit the model. Each answer is verified as it comes back.
- **Tier 3, copy and paste** (IntelliJ with Copilot, a web chat): the same batches with `--copy`.

`atticus probe` measures the tier instead of guessing it. The assistant must open a file holding a code, write the code back and run a command. The result stays on your machine. Every tier writes the same facts and gets the same checks; only the speed differs.

## Twelve commands and six app entries

`atticus help` shows twelve commands: `init`, `map`, `verify`, `join`, `change`, `critic`, `stories`, `task`, `questions`, `knowledge`, `next`, `ui`. `atticus legacy` lists every other command; each still runs by its own name, exactly as before.

The app (`atticus ui`) has six entries:

| Entry     | What it shows                                                   |
| --------- | --------------------------------------------------------------- |
| Home      | What needs you, what is read and trusted, changes in flight     |
| Map       | Estate canvas, flows, contracts, impact, trust                  |
| Change    | All changes, at a glance, feature, architecture, stories, tasks |
| Questions | Open questions                                                  |
| Knowledge | Items, sources, documents, search                               |
| Set up    | Repos, AI, org pack                                             |

`atticus ui --full` brings back every other page. The VS Code extension has three views by default, with the setting `atticus.fullUi` for the rest. Nothing was removed.

## Measured, with the caveats

On the bench (`bench/`: 22 public repos pinned to a commit, with references written by reading the code; numbers and method in [bench/README.md](bench/README.md)):

| What                                           | Result                                                                                                        | Bar                        | Caveat                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map, batch 2 (16 repos, held out)              | **88% precision, 84% recall**; the built-in readers 57% and 33%                                               | 95% precision, 85% recall  | Not met. Read once with the protocol frozen. Scored after three matcher equivalences added after the read (82% and 79% before them). Fixes made since are not measured. |
| Map, batch 1 (6 repos)                         | 89% precision, 97% recall; the readers 60% and 31%                                                            | the same                   | Tuned: the protocol and verifier were fixed on these repos, then the repos were read again.                                                                             |
| Estate, steps in order and fields at crossings | petclinic 67% and 94%, microservices-demo 80% and 100%, eShop 33% and 83%                                     | 80% and 90%                | Met by microservices-demo only. Tuned (these repos were read before). eShop's sagas run through ten integration events.                                                 |
| Stories, three reference stories               | changed steps 2/8, 1/2, 3/8; fields all; nothing invented; sections 17/17; error cases by entry 1/5, 2/4, 2/5 | none set yet (ADR 0124 §6) | One assistant, one run. Step coverage is far from the design's 90%.                                                                                                     |
| The critic (`fixtures/forge-change`)           | 12 blocking issues (10 by code, 2 by the lenses) and 14 gaps caught                                           | every seeded issue         | Re-baselined for the four questions. Three seeded items retired with the old lenses (service-desk drafts, UX states).                                                   |
| Offline bundle                                 | 20.1 MB on Linux x64, installed and used offline                                                              | under 60 MB                | Search by meaning is now an optional plugin (`--with-embeddings`). Windows and macOS sizes not measured here.                                                           |

No model cost per repo was recorded: the reading sessions ran as Claude sessions, not through the runtime's meter.

## Get started

- **Install, then a first map and a first change:** [docs/guide/install.md](docs/guide/install.md) has one page covering every tier and an offline company laptop. From your npm mirror it is one package, `npm install -g @maycombhq/atticus@beta` (the model and this machine's onnxruntime come with it); without a registry, one offline zip (about 20 MB) and one script. Either way you need Node.js 22.13 or later and Git 2.30 or later.
- **Set it up for a team:** [docs/guide/admin.md](docs/guide/admin.md).
- **By kind of work:** [docs/guide/roles.md](docs/guide/roles.md).
- **Every command:** [docs/guide/commands.md](docs/guide/commands.md).
- **Security:** [docs/security/threat-model.md](docs/security/threat-model.md).

Try it without touching anything real:

```bash
atticus sandbox create ./practice      # the invented Forge ecosystem, no outside system reached
cd practice/metarepo
atticus doctor
atticus next
atticus ui --open
```

From a checkout:

```bash
corepack enable
pnpm install
pnpm build
pnpm check          # deny-list, lint, dependency, licence and docs checks, typecheck, tests
pnpm bundle         # dist/atticus-<version>-offline.zip
pnpm npm:test       # the npm packages, installed from a throwaway mirror, as a company mirror would serve them
```

## Where things are

`packages/` holds one package per responsibility: `core` (the contracts, the facts schema and its projection, the facts join), `verify` (the verifier and the map renderers), `assistant-files` (the slash commands for every assistant, and the probe), `planner` (the stages and the stories), `naysayer` (the critic), `knowledge`, `cli`, `server`, `ui`, `vscode`, `intellij` and more. [docs/codebase-map.md](docs/codebase-map.md) lists each package and marks which are outside the default product. Other locations:

- `fixtures/`: the invented Forge ecosystem the tests use.
- `bench/`: the public-repo bench.
- `docs/adr/`: the decisions.
- `plugins/atticus/`: the Claude Code plugin.
- `scripts/bundle/`: the offline bundle.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors and AI coding assistants follow [CLAUDE.md](CLAUDE.md); [docs/build-status.md](docs/build-status.md) says what is done and what is next.

## Licence

[Apache 2.0](LICENSE). The name comes from Atticus Finch, the honest advocate in _To Kill a Mockingbird_; the project lives in the `maycombhq` organisation, after the town where he lived.
