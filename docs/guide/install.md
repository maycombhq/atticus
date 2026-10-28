# Installing Atticus

From nothing to a first map and a first change, on one page. Atticus is a command line (`atticus`) and a local app (`atticus ui`) on each person's own machine, working on a Git metarepo the team shares. There is no server to run.

## Minute 0: what the machine needs

- **Node.js 22.13 or later** and **Git 2.30 or later**, from your software catalogue. No administrator rights.
- **An assistant** (optional, but it does the reading): Claude Code, Copilot in VS Code or IntelliJ, or any chat you can paste into.

## Minute 2: install

**From your npm mirror** (a company with Artifactory or Nexus in front of npm): this is the shortest way, and it brings search by meaning with it.

```bash
npm install -g @maycombhq/atticus@beta     # @maycombhq/atticus once Atticus 2 is out of beta
atticus --version
```

- **One package.** `@maycombhq/atticus` is the command line and its app in one self-contained package (6 MB to download): Atticus's own code and the third-party JavaScript it uses are bundled inside, with their licences in its `THIRD-PARTY-LICENSES.txt`. npm installs it with the model and this machine's onnxruntime beside it: five packages in all on Linux x64, about 106 MB from the mirror and 180 MB on disk (Atticus 2.0.0-beta.1 was 141 packages, 117 MB and 250 MB).
- **Search by meaning comes with it.** The local embedding model (`@maycombhq/embed-model`, all-MiniLM-L6-v2, 79 MB to download) and this machine's onnxruntime (`@maycombhq/onnxruntime-<platform>-<arch>`, 10 to 25 MB, plus the 3.6 MB WebAssembly fallback, with `onnxruntime-common` from the public registry) are optional dependencies that carry their files: npm installs only your platform's runtime, and nothing is downloaded after install. `atticus doctor` then says _Embedding model: ready … runtime: native_.
- **No install scripts.** No Atticus package has one, so a mirror or an npm config with `ignore-scripts=true` (`npm install -g --ignore-scripts @maycombhq/atticus@beta`) installs the same thing.
- **Without search by meaning:** `npm install -g --omit=optional @maycombhq/atticus@beta` installs the one package (6 MB to download); Atticus searches by words and names, and doctor says so. A mirror that doesn't hold the optional packages doesn't fail the install either.
- **If the scope is blocked** (`404` or `403` for `@maycombhq/atticus`), ask the Artifactory or Nexus team to: proxy the public npm registry for the `@maycombhq` scope (or allow it in the npm remote repository's include patterns); allow tarballs of about 80 MB (`@maycombhq/embed-model`; the largest runtime, `onnxruntime-darwin-arm64`, is 25 MB); and let their licence scanner pass Apache-2.0 (Atticus and the model) and MIT (onnxruntime), and read `THIRD-PARTY-LICENSES.txt` for what is bundled inside `@maycombhq/atticus` (MIT, ISC, BSD, EPL-2.0 for the diagram layout engine, OFL-1.1 for the app's fonts). Every package's licence is in its `package.json` and its `LICENSE` file; the model's training data is listed in its `MODEL-CARD.md` for your legal team.
- **The old package names** (`@maycombhq/cli`, `@maycombhq/core` and the other 37 that 2.0.0-beta.1 published) are deprecated: install `@maycombhq/atticus` instead. A mirror that cached them can drop them.
- Your npm settings decide where it comes from: `npm config get registry` should print your mirror. Behind a proxy that re-signs TLS, set `NODE_EXTRA_CA_CERTS` as below.

**From the offline bundle** (a laptop with no package registry). The bundle is one zip, `atticus-<version>-offline.zip`, about 20 MB, with a `.sha256` beside it.

1. Check the zip against its `.sha256`, then unzip it anywhere.
2. **Windows:** right-click `install.ps1`, _Run with PowerShell_ (or `powershell -ExecutionPolicy Bypass -File install.ps1`; `-NoPath` leaves your PATH alone). **macOS, Linux:** `sh install.sh`.
3. Open a new terminal: `atticus --version`.

The script checks Node and every file against `SHA256SUMS`, copies the version into your own programs folder (`%LOCALAPPDATA%\Programs\Atticus\<version>`, or `~/.local/share/atticus/<version>`) and puts `atticus` on your PATH. Nothing in it reaches the network. It carries an SBOM (`sbom.cdx.json`) and the third-party licences for your security review.

**In the offline bundle, search by meaning is an optional plugin.** The default bundle leaves out the local embedding model and its runtime (all-MiniLM-L6-v2 and onnxruntime, about 100 MB more): Atticus finds things by words and names (SQLite FTS5 with BM25) and by following the graph, and `atticus doctor` says so under _Embedding model_. Two ways to add it:

- **The plugin zip, next to the default bundle:** `atticus-<version>-embeddings-plugin.zip` (built with `pnpm bundle --embeddings-plugin`, about 0.25 MB, the same zip on every platform). It holds the plugin's packages and their pins, not the model's or onnxruntime's bytes.
  1. Check it against its `.sha256`, unzip it, and run its `install.ps1` (Windows) or `sh install.sh`. It finds the Atticus of the same version in your programs folder (or give the folder: `-Atticus <folder>`, or `sh install.sh <folder>`), checks every file against `SHA256SUMS` and copies the packages into it.
  2. Fetch the model and this machine's onnxruntime: `node <Atticus folder>/embeddings-plugin/fetch-model.mjs`. Each file comes from its pinned source (Hugging Face at a fixed revision, the npm registry, onnxruntime's licence on GitHub) and is checked against the sha256 in `pins.json`. On a machine that can't reach them, `--list` prints each file's sha256 and source: fetch them through your mirror or on another machine, put them in a folder under any names, and run the step with `--from <folder> --offline`. `--check` says what is still missing.
  3. `atticus doctor` shows the model and its runtime under _Embedding model_; then `atticus index embed` in the metarepo.

  An upgrade of Atticus needs the plugin zip of the new version, installed again.

- **The bundle with the model inside:** a bundle built with `pnpm bundle --with-embeddings` (`atticus-<version>-offline-embeddings.zip`, for one platform), with nothing else to fetch.

Atticus itself never downloads anything after install; only the plugin's fetch step does, when a person runs it.

On Windows, once: `git config --global core.longpaths true`. If Git doesn't know you yet: `git config --global user.name "Your Name"` and `user.email`; Atticus records who did what by your Git user, with no sign-in.

## Minute 5: a metarepo and the machine check

```bash
atticus init forge-meta --platform forge --owner <you>   # an estate of repos: one metarepo for the team
cd forge-meta
atticus repos discover <folder with your clones>         # proposes repos.manifest.yaml entries; add them
atticus workspace sync                                   # base clones of every repo (--from <folder with your clones>: copied from them, no network)
atticus doctor                                           # each line [ok], [warn] or [FAIL], with what to do
```

`atticus init` makes the folder a git repository (`git init`, branch `main`) when it isn't inside one, so the metarepo's changes go through pull requests; a folder already inside a repository is left as it is. It also writes your assistant's files — the slash commands (`.claude/commands/`), Copilot's prompts (`.github/prompts/`) and the instructions — so `/atticus-map <repo>` works in the new metarepo straight away; commit them in a pull request, and run `atticus assistant-files` again whenever the org pack's process files change. `atticus repos discover` never looks inside hidden folders (an assistant's worktrees under `.claude/`), `node_modules` or a nested worktree.

Atticus reads each repo from its own base clone under `workspace/`, on the branch the manifest names (`repos discover` records the branch each of your clones is on), never from the clones you work in. When your clones are already on this machine, `atticus workspace sync --from <folder with your clones>` copies each one instead of cloning it again: nothing comes over the network, Git hard-links the files on the same drive, and your clones are only read. It takes each branch as your clone last fetched it (`origin/<branch>`), so your unpushed commits and edits stay yours, and points the copy's `origin` at the server, so later syncs fetch from there as usual.

### Say what each repo is

A repo id often says nothing — three repos differ by a suffix, one is named after a programme that was renamed. So each entry in the manifest can carry one line saying what the repo is, in your own words:

```bash
atticus repo add https://git.example.com/forge/forge-ledger.git \
  --type forge-service --owner team-ledger \
  --description "The ledger: every posting and the balances read from them. Northwind Pay settles against it nightly."

atticus repo describe forge-gateway \
  --description "The gateway in front of the Forge APIs: it checks the OAuth token and forwards to orders, ledger and customers."

atticus repo describe            # the repos that say nothing, and the drafts waiting for you
```

Write what it is **for** and **who uses it**, in one line of up to 300 characters: "the gateway in front of the Forge APIs", "a vendored text corpus the parser is tested against", "the batch that closes the day". Don't write what the code would tell you anyway (the language, the framework, the endpoints) — Atticus reads that from the code and it goes stale. Don't put anything in it you wouldn't put in the repo's README.

That line is carried into every reading prompt (clearly marked as your note, which the code beats), into the question a join asks when two repos could answer on a host, into what `map --estimate` proposes leaving out, into what a repo is matched on when knowledge and stories are placed, and into `map.md` and the app's repo and estate views.

`atticus repos discover` and a bulk add from the editor never stop to ask: the repos that say nothing turn up as a step in `atticus next` and in `atticus repo describe`, to fill in when you have a minute.

**Your assistant can draft one.** On the first read of a repo that says nothing, your assistant drafts a line from what it read, citing the lines it read it from. Atticus keeps it marked unconfirmed everywhere it is used until you decide:

```bash
atticus repo describe forge-ledger --accept                  # it is right: it becomes your words
atticus repo describe forge-ledger --description "..."       # it isn't quite: yours replaces it
atticus repo describe forge-ledger --reject                  # drop it
```

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
- Copilot agent mode (VS Code) or another tool: `atticus init` already wrote its prompt files into the metarepo; `atticus assistant-files` writes them again after an org-pack change.

Then, in the assistant: `/atticus-map <repo>`. It reads the repo, runs `atticus verify <repo>` after each pass and fixes what is rejected until everything passes, then shows you the questions it raised. Finish with `atticus verify <repo> --write`: the facts go into the catalog and the map is rendered under `map/<repo>/` for review in a pull request.

For a big repo, run `atticus map <repo> --estimate` first: it proposes folders of data, docs or vendored code to leave out (an `exclude:` block to add to `org-pack/scan/<repo>.yaml` in a pull request; it never proposes build, config or migration files, or an API spec such as an OpenAPI file or an `oas/` folder, whatever their size), and, past what one session reads, the parts to read it in, one per session or sub-agent.

You don't keep that list of parts yourself. `--estimate` writes the plan to `facts/<repo>.read-plan.yaml` and, run again, says which parts are read and which comes next:

```bash
atticus map <repo> --estimate   # part 4 of 13 is next (3 of 13 read): ...
atticus next                    # the same, among the other steps
```

A part counts as read when every folder it covers is accounted for in the facts: a fact citing a file under it, or a line of `facts/<repo>.reviewed.jsonl` saying the file holds nothing to record. So the plan survives a lost session, a sub-agent and someone else carrying on, and reading a part again never un-does it. Commit the plan with the facts.

**Copilot Chat without tools (tier 2: it reads and writes a file you give it, but runs nothing).**

```bash
atticus map <repo> --estimate   # the batches at your model's limit
atticus map <repo> --handoff    # prints the batch's prompt file and the answer file to write
```

Give the assistant the prompt file; it writes the answer file. Then `atticus handoff done <run>` and `atticus map <repo> --next` for the next batch: each answer is verified as it comes back. When the last batch is in, `atticus verify <repo> --write`.

If an answer doesn't read, the command that reads it says so — the file, the line and the column, and what to fix (a value holding a `:`, a `#` or `{ } [ ]` goes in double quotes). You never get the same prompt back in silence.

**Copy and paste (tier 3: IntelliJ with Copilot Chat, a web chat).**

```bash
atticus map <repo> --copy                    # prints the batch's prompt to paste
atticus map <repo> --copy --answer reply.txt # reads the answer you saved (--answer - for stdin)
```

Repeat until it says the read is done, then `atticus verify <repo> --write`.

### What `--write` keeps, and what the catalog leaves out

`--write` rewrites `facts/<repo>.jsonl` with the facts it kept. That file stays your assistant's own: every claim it wrote is still in it, and the only changes to the bytes are that a quote carrying a secret value is redacted (so a secret never sits in the file) and that a quote the cited line can't be checked against — a minified bundle, a notebook, a binary, a line over 1,000 characters — is left off and counted. A fact that was rejected isn't in the file: it is in `<repo>.rejected.jsonl` with why, for your assistant to fix.

The catalog is stricter than the facts file, and that is where a claim is dropped rather than from your assistant's work:

- **An entry's `auth` reaches the catalog only when a line is cited for it** (`authCite`: the file and line that sets the auth, and what it writes there), or when you wrote the fact yourself. Without one, the claim stays in the facts file and no `Endpoint` or `Interface` record carries it, so the map never says an auth nothing shows.
- `atticus verify` says how many entries that is, on **every** run, `--write` included, until a line is cited. If you see "N entries' auth rests on no cited line", have your assistant add an `authCite` to each and verify again; the number falls as the lines are cited, and not before.

### A big repo and memory

A repo of a few thousand files with a few thousand facts needs a few hundred megabytes while it is verified. If `atticus verify` says a repo's facts need more memory than Node was given, run it again with more, or a repo at a time:

```bash
ATTICUS_MAX_OLD_SPACE=4096 atticus verify <repo> --write   # megabytes Node may use
```

Closing an IDE usually frees enough on its own. Atticus checks its own memory as it reads and stops with that message, so the command never dies without saying anything.

With several repos read: `atticus join` follows flows from repo to repo through the calls the facts join, and asks which repo answers a host nobody lists. `atticus ui --open` shows the map, with the Trust tab saying per repo what was verified.

## The first change

```bash
atticus change new "Cap daily transfers" --type feature   # then write its brief
atticus next                                              # the next step, and its slash command
```

The stages, each looping with Atticus's checks and the critic until it is done: the feature (`/atticus-feature <change>`, or `atticus change feature <change> --handoff`), the architecture (`/atticus-architecture`), the stories (`/atticus-stories`, or `atticus stories <change>`), then a task at a time (`/atticus-task <change> <task>`, or `atticus task <change> <task>`). `atticus critic <change>` reviews it at a gate; `atticus questions` lists what needs a person. Every write to a shared system waits for a person's approval, and a gate is approved by merging its hand-off pull request.

A tier 2 assistant takes each stage with `--handoff` (prompt file in, answer file out, `atticus handoff done <run>`); a tier 3 one with the same prompt pasted.

Between rounds you copy nothing. When a stage's checks find something, the next round's prompt points at a result file that already holds your assistant's last answer, to be edited in place; the stage says which file it copied where. And whichever command reads an answer names what is wrong with it, with the line and what to fix, before it offers a prompt again.

OpenSpec itself ships inside Atticus rather than on your PATH, so run it through Atticus:

```bash
atticus openspec status                  # --change is filled in when one change is open
atticus openspec instructions apply
atticus openspec list --specs
```

## When something goes wrong

- `atticus doctor` first. Behind a proxy that re-signs TLS, set `NODE_EXTRA_CA_CERTS` to your root certificate and add `localhost` and `127.0.0.1` to `NO_PROXY`; doctor checks both. A scan never touches the network; the only network call a read makes is to the model provider your runtime.yaml names, if any.
- `atticus help` shows the twelve main commands; `atticus legacy` lists the rest, which all still run by their own names. [The troubleshooting guide](troubleshooting.md) says what each error means.

## Upgrade and uninstall

Install the new bundle (the old version stays beside it), or `npm install -g @maycombhq/atticus@<version>` from your mirror. In the metarepo: `atticus doctor`, then `atticus upgrade` (it backs up every file it changes to `.atticus/backups/<time>/`; `--check` lists what it would do), and commit what it changed in a pull request. To uninstall, delete the version folder and the `atticus` command (`...\Atticus\bin\atticus.cmd`, or `~/.local/bin/atticus`), or `npm uninstall -g @maycombhq/atticus`; Atticus keeps nothing else outside your metarepos.

From a checkout instead: `corepack enable`, `pnpm install`, `pnpm build`, then `node packages/cli/dist/bin.js --version`. `pnpm bundle` builds the offline bundle for this platform, `pnpm bundle --with-embeddings` the one with the model (filled from pinned sources through `.cache/pinned`), `pnpm bundle --embeddings-plugin` the plugin zip, and `pnpm bundle:test <zip>` installs a bundle into a throwaway folder and uses it (`--plugin <plugin zip>` adds the plugin next to the default bundle; `--plugin-from .cache/pinned` runs its fetch step offline and searches by meaning). `pnpm npm:test` packs the public npm packages (after `pnpm model:fetch`), serves them from a throwaway mirror and installs `@maycombhq/atticus` with `npm install --global --ignore-scripts` as a locked-down company machine would, then uses it with the network blocked (doctor, a practice metarepo, a search by meaning, `map --estimate`, the app); publishing is in [the admin guide](admin.md#publishing-to-npm).

Next: [running Atticus for a team](admin.md).
