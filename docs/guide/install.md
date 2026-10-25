# Installing Atticus

From nothing to a first map and a first change, on one page. Atticus is a command line (`atticus`) and a local app (`atticus ui`) on each person's own machine, working on a Git metarepo the team shares. There is no server to run.

## Minute 0: what the machine needs

- **Node.js 22.13 or later** and **Git 2.30 or later**, from your software catalogue. No administrator rights.
- **An assistant** (optional, but it does the reading): Claude Code, Copilot in VS Code or IntelliJ, or any chat you can paste into.

## Minute 2: install

**From the offline bundle** (a bank laptop, no package registry). The bundle is one zip, `atticus-<version>-offline.zip`, about 20 MB, with a `.sha256` beside it.

1. Check the zip against its `.sha256`, then unzip it anywhere.
2. **Windows:** right-click `install.ps1`, _Run with PowerShell_ (or `powershell -ExecutionPolicy Bypass -File install.ps1`; `-NoPath` leaves your PATH alone). **macOS, Linux:** `sh install.sh`.
3. Open a new terminal: `atticus --version`.

The script checks Node and every file against `SHA256SUMS`, copies the version into your own programs folder (`%LOCALAPPDATA%\Programs\Atticus\<version>`, or `~/.local/share/atticus/<version>`) and puts `atticus` on your PATH. Nothing in it reaches the network. It carries an SBOM (`sbom.cdx.json`) and the third-party licences for your security review.

**From your npm mirror** (Artifactory, Nexus): `npm install --global @maycombhq/cli`. The mirror needs every `@maycombhq/*` package the CLI depends on and the third-party packages in the SBOM. The embedding plugin's packages (`@maycombhq/embed`, `@maycombhq/embed-model`, `@maycombhq/onnxruntime-*`) are optional dependencies: `npm install --global --omit=optional @maycombhq/cli` leaves them out, and a mirror that doesn't hold them doesn't fail the install.

**Search by meaning is an optional plugin.** The default bundle leaves out the local embedding model and its runtime (all-MiniLM-L6-v2 and onnxruntime, about 100 MB more): Atticus finds things by words and names (SQLite FTS5 with BM25) and by following the graph, and `atticus doctor` says so under _Embedding model_. Three ways to add it:

- **The plugin zip, next to the default bundle:** `atticus-<version>-embeddings-plugin.zip` (built with `pnpm bundle --embeddings-plugin`, about 0.25 MB, the same zip on every platform). It holds the plugin's packages and their pins, not the model's or onnxruntime's bytes.
  1. Check it against its `.sha256`, unzip it, and run its `install.ps1` (Windows) or `sh install.sh`. It finds the Atticus of the same version in your programs folder (or give the folder: `-Atticus <folder>`, or `sh install.sh <folder>`), checks every file against `SHA256SUMS` and copies the packages into it.
  2. Fetch the model and this machine's onnxruntime: `node <Atticus folder>/embeddings-plugin/fetch-model.mjs`. Each file comes from its pinned source (Hugging Face at a fixed revision, the npm registry, onnxruntime's licence on GitHub) and is checked against the sha256 in `pins.json`. On a machine that can't reach them, `--list` prints each file's sha256 and source: fetch them through your mirror or on another machine, put them in a folder under any names, and run the step with `--from <folder> --offline`. `--check` says what is still missing.
  3. `atticus doctor` shows the model and its runtime under _Embedding model_; then `atticus index embed` in the metarepo.

  An upgrade of Atticus needs the plugin zip of the new version, installed again.

- **The bundle with the model inside:** a bundle built with `pnpm bundle --with-embeddings` (`atticus-<version>-offline-embeddings.zip`, for one platform), with nothing else to fetch.
- **The npm install** without `--omit=optional`.

Atticus itself never downloads anything after install; only the plugin's fetch step does, when a person runs it.

On Windows, once: `git config --global core.longpaths true`. If Git doesn't know you yet: `git config --global user.name "Your Name"` and `user.email`; Atticus records who did what by your Git user, with no sign-in.

## Minute 5: a metarepo and the machine check

```bash
atticus init forge-meta --platform forge --owner <you>   # an estate of repos: one metarepo for the team
cd forge-meta
atticus repos discover <folder with your clones>         # proposes repos.manifest.yaml entries; add them
atticus workspace sync                                   # base clones of every repo
atticus doctor                                           # each line [ok], [warn] or [FAIL], with what to do
```

`atticus init` makes the folder a git repository (`git init`, branch `main`) when it isn't inside one, so the metarepo's changes go through pull requests; a folder already inside a repository is left as it is. `atticus repos discover` never looks inside hidden folders (an assistant's worktrees under `.claude/`), `node_modules` or a nested worktree.

One repo instead of an estate: `atticus adopt <path>` writes only `.atticus/` in it (`atticus unadopt <path>` leaves it byte for byte as it was). To practise first: `atticus sandbox create ./practice`, then work in `practice/metarepo`.

## Minute 10: measure your assistant

```bash
atticus probe
```

It writes a file holding a code it never prints and tells you to run `/atticus-probe` in your assistant. The assistant opens the file, writes the code back and runs `atticus probe answer <code>`; what it managed decides its tier, measured rather than guessed, and `atticus map <repo> --estimate` then says what the first read costs. A chat that can't run commands gives you the line to run with `--pasted`; one that can't open files answers `none`. The result stays on your machine (`.atticus/probe/`).

## The first map, by tier

Every tier writes the same facts file, each fact citing its file and line, and `atticus verify` checks every claim on its line. Only the speed differs.

**Claude Code, Cursor or Copilot agent mode (tier 1: the assistant opens files and runs commands).**

- Claude Code: install the plugin once, `/plugin marketplace add maycombhq/atticus` then `/plugin install atticus@maycombhq`.
- Copilot agent mode (VS Code) or another tool: `atticus assistant-files` writes its prompt files into the metarepo; commit them in a pull request.

Then, in the assistant: `/atticus-map <repo>`. It reads the repo, runs `atticus verify <repo>` after each pass and fixes what is rejected until everything passes, then shows you the questions it raised. Finish with `atticus verify <repo> --write`: the facts go into the catalog and the map is rendered under `map/<repo>/` for review in a pull request.

For a big repo, run `atticus map <repo> --estimate` first: it proposes folders of data, docs or vendored code to leave out (an `exclude:` block to add to `org-pack/scan/<repo>.yaml` in a pull request), and, past what one session reads, the parts to read it in, one per session or sub-agent.

**Copilot Chat without tools (tier 2: it reads and writes a file you give it, but runs nothing).**

```bash
atticus map <repo> --estimate   # the batches at your model's limit
atticus map <repo> --handoff    # prints the batch's prompt file and the answer file to write
```

Give the assistant the prompt file; it writes the answer file. Then `atticus handoff done <run>` and `atticus map <repo> --next` for the next batch: each answer is verified as it comes back. When the last batch is in, `atticus verify <repo> --write`.

**Copy and paste (tier 3: IntelliJ with Copilot Chat, a web chat).**

```bash
atticus map <repo> --copy                    # prints the batch's prompt to paste
atticus map <repo> --copy --answer reply.txt # reads the answer you saved (--answer - for stdin)
```

Repeat until it says the read is done, then `atticus verify <repo> --write`.

With several repos read: `atticus join` follows flows from repo to repo through the calls the facts join, and asks which repo answers a host nobody lists. `atticus ui --open` shows the map, with the Trust tab saying per repo what was verified.

## The first change

```bash
atticus change new "Cap daily transfers" --type feature   # then write its brief
atticus next                                              # the next step, and its slash command
```

The stages, each looping with Atticus's checks and the critic until it is done: the feature (`/atticus-feature <change>`, or `atticus change feature <change> --handoff`), the architecture (`/atticus-architecture`), the stories (`/atticus-stories`, or `atticus stories <change>`), then a task at a time (`/atticus-task <change> <task>`, or `atticus task <change> <task>`). `atticus critic <change>` reviews it at a gate; `atticus questions` lists what needs a person. Every write to a shared system waits for a person's approval, and a gate is approved by merging its hand-off pull request.

A tier 2 assistant takes each stage with `--handoff` (prompt file in, answer file out, `atticus handoff done <run>`); a tier 3 one with the same prompt pasted.

## When something goes wrong

- `atticus doctor` first. Behind a proxy that re-signs TLS, set `NODE_EXTRA_CA_CERTS` to your root certificate and add `localhost` and `127.0.0.1` to `NO_PROXY`; doctor checks both. A scan never touches the network; the only network call a read makes is to the model provider your runtime.yaml names, if any.
- `atticus help` shows the twelve main commands; `atticus legacy` lists the rest, which all still run by their own names. [The troubleshooting guide](troubleshooting.md) says what each error means.

## Upgrade and uninstall

Install the new bundle; the old version stays beside it. In the metarepo: `atticus doctor`, then `atticus upgrade` (it backs up every file it changes to `.atticus/backups/<time>/`; `--check` lists what it would do), and commit what it changed in a pull request. To uninstall, delete the version folder and the `atticus` command (`...\Atticus\bin\atticus.cmd`, or `~/.local/bin/atticus`); Atticus keeps nothing else outside your metarepos.

From a checkout instead: `corepack enable`, `pnpm install`, `pnpm build`, then `node packages/cli/dist/bin.js --version`. `pnpm bundle` builds the offline bundle for this platform, `pnpm bundle --with-embeddings` the one with the model (filled from pinned sources through `.cache/pinned`), `pnpm bundle --embeddings-plugin` the plugin zip, and `pnpm bundle:test <zip>` installs a bundle into a throwaway folder and uses it (`--plugin <plugin zip>` adds the plugin next to the default bundle; `--plugin-from .cache/pinned` runs its fetch step offline and searches by meaning).

Next: [running Atticus for a team](admin.md).
