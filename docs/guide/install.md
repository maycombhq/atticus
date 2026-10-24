# Installing Atticus

Atticus runs on each person's own machine: a command line (`atticus`) and a local app (`atticus ui`) that work on a Git metarepo the team shares. There is no server to run and nothing to host.

## What a machine needs

| Need         | Version                                  | Why                                                              |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------- |
| Node.js      | 22.13 or later (LTS 22 or 24)            | Atticus is a Node program; its index uses Node's built-in SQLite |
| Git          | 2.30 or later                            | Base clones, worktrees, hand-off branches                        |
| An editor    | VS Code or IntelliJ (optional)           | Change worktrees open as editor workspaces                       |
| An assistant | GitHub Copilot or Claude Code (optional) | AI steps run in the person's own assistant (hand-off)            |

No administrator rights are needed. Atticus never needs a package registry after it is installed, and scans never touch the network.

## Install from the offline bundle (recommended)

The bundle is one zip, `atticus-<version>-offline.zip`, with a `.sha256` file beside it. It holds the command line and app with every dependency, install scripts, `SHA256SUMS`, an SBOM (`sbom.cdx.json`) and the third-party licences.

1. Check the zip against its `.sha256` file, then unzip it anywhere.
2. Run the install script from the unzipped folder:
   - **Windows:** right-click `install.ps1` and choose _Run with PowerShell_, or run `powershell -ExecutionPolicy Bypass -File install.ps1`. Add `-NoPath` to leave your PATH as it is.
   - **macOS, Linux:** `sh install.sh`.
3. Open a new terminal and run `atticus --version`.

The script checks Node, checks every file against `SHA256SUMS`, copies the version into your own programs folder (`%LOCALAPPDATA%\Programs\Atticus\<version>` on Windows, `~/.local/share/atticus/<version>` elsewhere) and puts `atticus` on your PATH. Versions sit side by side: to go back, run the older bundle's script.

On Windows, also run once:

```bash
git config --global core.longpaths true
```

Change worktrees nest deeply, and Windows paths stop at 260 characters without it.

Atticus knows you by your Git user (ADR 0073): there is no sign-in and no role to pick. If Git doesn't know you yet, set it once:

```bash
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

Every command and the app record you by it (the email's part before the `@`); `--by <handle>` names someone else. Without it, Atticus uses your OS user name and warns each time.

## Install from source

For contributors, or where the bundle can't be used:

```bash
corepack enable
pnpm install
pnpm build
node packages/cli/dist/bin.js --version
```

`pnpm bundle` builds the offline bundle from a checkout, and `pnpm bundle:test <zip>` installs it into a throwaway folder and uses it.

## Check the machine

In your metarepo (after the next section, or in a practice sandbox):

```bash
atticus doctor
```

Each line is `[ok]`, `[warn]` or `[FAIL]` with what to do. It checks Node, Git and your Git identity, long paths on Windows, the bundled OpenSpec, proxy variables, `NODE_EXTRA_CA_CERTS`, that the metarepo is writable, free disk, the app's port, the org pack, the assistant and editor `runtime.yaml` allows, the metarepo's version and whether the last scan finished. It reads the machine only: no network, no AI, and never a secret's value.

### Behind a proxy that inspects TLS

Atticus itself makes no network calls in a scan. Plugins and adapters that reach your systems do, and they use Node's certificate store. If your proxy re-signs TLS, set `NODE_EXTRA_CA_CERTS` to your organisation's root certificate in PEM form (your desktop or network team has it), and add `localhost` and `127.0.0.1` to `NO_PROXY`. `atticus doctor` checks both.

## Start a metarepo

A team needs one metarepo: a Git repository that holds the org pack, the catalog and the changes.

**New metarepo:**

```bash
atticus init forge-meta --platform forge --owner <you>
cd forge-meta
atticus repos discover <folder with your clones>
```

`repos discover` proposes `repos.manifest.yaml` entries; add what it proposes. Then:

```bash
atticus workspace sync
atticus scan
atticus ui --open
```

The app updates by itself when files change, whoever wrote them: your assistant, the command line or a teammate's pull. The page carries its own session token; `atticus ui --show-token` prints it for an assistant or a script that calls the local API.

**An existing repo** (an OpenSpec or Spec Kit repo, or a repo with its own assistant prompts) can use Atticus in place: `atticus adopt <path>` writes only `.atticus/`, and `atticus unadopt <path>` leaves the repo byte for byte as it was.

**Practice first:** `atticus sandbox create <dir>` makes a throwaway metarepo from the invented Forge ecosystem, with every outside system a mock except the Git host, which is manual: you record its pull request steps with `atticus todo done`, as you would without Git host access.

**In your editor or assistant:**

- **VS Code:** the Atticus extension (`packages/vscode`), with Copilot running the AI steps.
- **IntelliJ IDEA:** the Atticus plugin (`packages/intellij`); AI steps run as `/atticus-*` slash commands in Copilot Chat.
- **Claude Code:** the Atticus plugin (ADR 0104). Install it once:

  ```
  /plugin marketplace add maycombhq/atticus
  /plugin install atticus@maycombhq
  ```

  Every step is a slash command (`/atticus-next`, `/atticus-survey`, `/atticus-needs` and the rest), a session in a metarepo starts with its next step, and the read-only `atticus` MCP tools read the catalog, knowledge, changes and needs. `atticus assistant-files` still writes the org pack's own agents, skills and commands into the metarepo.

The app's Home shows the setup checklist until the catalog is accepted. The same list is `atticus setup`. Next: [the admin guide](admin.md).

## Upgrade

1. Install the new bundle (step 2 above). The old version stays.
2. In the metarepo: `atticus doctor`, then `atticus upgrade`.
3. Commit what `upgrade` changed, in a pull request.

`atticus upgrade` copies every file it changes to `.atticus/backups/<time>/` first and records the version in `.atticus/metarepo.yaml`. `atticus upgrade --check` lists what it would do. An older Atticus refuses a metarepo a newer one upgraded, so install the newer version on every machine that works in it.

## Uninstall

Delete the version folder (`%LOCALAPPDATA%\Programs\Atticus\<version>`, or `~/.local/share/atticus/<version>`) and the `atticus` command (`...\Atticus\bin\atticus.cmd`, or `~/.local/bin/atticus`). Atticus keeps nothing else outside your metarepos. In a metarepo, `.atticus/logs/`, `.atticus/locks/`, `.atticus/backups/` and `.atticus/me.yaml` (your digest settings) are this machine's own files and are never committed.
