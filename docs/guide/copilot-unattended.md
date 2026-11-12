# Running Copilot unattended (copilot-acp)

Where GitHub Copilot is the assistant, Atticus's steps hand you a line to paste into a new Copilot
Chat. With **copilot-acp** (ADR 0171) Atticus does the pasting itself: it starts the GitHub Copilot
language server in its Agent Client Protocol mode, opens a new Copilot session for each step, sends
the same text the slash command would, and checks the result as it does when you paste. `atticus
map --all` then reads a whole estate without anyone at the keyboard.

See also: [Running Atticus's steps through Copilot agent mode](copilot-agent-mode.md) (the same
steps, pasted by a person), and [Commands](commands.md).

## Turning it on

An organisation turns it on in `org-pack/runtime.yaml`, in a pull request. It needs version 3:

```yaml
schemaVersion: 3
assistants: { allowed: [copilot], default: copilot }
modes: { allowed: [hand-off, copilot-acp], default: hand-off }
copilotAcp:
  command: npx --yes @github/copilot-language-server # the default
  # model: gpt-5          # optional: a model id the server offers
  # maxTurns: 200         # optional: tool calls before a session is stopped
  # timeoutMs: 1800000    # optional: the longest one session may take
```

- `command` is the server's program and any words before `--acp`, on one line. Atticus adds
  `--acp`. A path with spaces goes in double quotes. Where npx isn't allowed, give the server's full
  path. If your server needs `--stdio` as well, add it here.
- With `default: copilot-acp`, every step and `atticus map --all` use it without `--mode`. With
  `default: hand-off`, ask for it per command: `--mode copilot-acp`.
- A file at version 1 or 2 that names copilot-acp is refused until `atticus upgrade` moves it to
  version 3 (the number only).

Check it with `atticus doctor`: the **Copilot ACP** line says whether the server runs, its version,
and whether it is signed in. Doctor starts the server for that and opens no session: nothing runs
and no tokens are spent.

## Using it

```text
atticus map --all --mode copilot-acp [--repos a,b] [--max-parts n] [--budget-tokens n]
atticus map forge-ledger --mode copilot-acp          # one repo, the same loop
atticus map forge-ledger --gaps --mode copilot-acp   # the second pass on the gaps
atticus questions propose --mode copilot-acp         # /atticus-propose, unattended
atticus change feature <change> --mode copilot-acp   # any AI step: its prompt in one session
```

For `map --all`, each part gets a NEW session (a fresh context, never one session for two parts).
When the session ends, Atticus verifies the part as it does when you paste (`atticus verify <repo>
--write`, and the part is done once verify's coverage leaves nothing under it). A part that isn't
accounted for gets one more new session with only what is left; then the run moves on and lists it
as incomplete, with the command that carries on. The console shows short progress lines: the files
the session reads, the atticus commands it runs, anything refused, and what it said at the end.

`--max-parts` counts sessions; `--budget-tokens` counts the tokens the server reports (or the
part's estimate when it reports none).

### The model's limit

Parts are planned at the model's limit, so a part fits one session. It is `--max-tokens n`, else
`maxInput` under `adapters.model` in runtime.yaml, else what `atticus probe` measured. A metarepo
that reads only through Copilot has no `adapters.model`: give `--max-tokens` (the context window of
the model Copilot uses, for example `--max-tokens 128000`). From the app, the run's dialog asks for
it ("Your model's limit, in tokens") and fills it with the one given for the last run on this
machine. That value is kept in `.atticus/map-all/limit.json`, on this machine only; runtime.yaml
isn't changed.

A part's session runs `atticus map <repo> --estimate` (or `--part n`) itself, without the limit.
With a read plan on file at that commit (`facts/<repo>.read-plan.yaml`, written by the run), it
plans at the plan's own session size, so the session sees the run's parts. `--max-tokens` plans the
repo again at another limit.

### Before the first session: the assistant files

Copilot reads the metarepo's assistant files (`.github/copilot-instructions.md`,
`.github/prompts/`), whose first step checks that they are current. So before it starts a session
the run checks them as `atticus assistant-files --check` does:

- **missing or out of date**: the run writes them from the org pack, as `atticus assistant-files`
  does, and names them in the Console. They are generated files in the metarepo, a local write
  like the facts: propose them for review with the facts.
- **edited by hand** (or a file in the way that isn't Atticus's): only a person replaces those, so
  the run is refused before any session starts. Look at the file, then put back the generated text
  (`atticus assistant-files --force` writes it over the edits), and start the run again. The app's
  dialog says so and won't start.

### When verify rejects what a session wrote

`atticus verify` moves each fact it rejects out of `facts/<repo>.jsonl` into
`facts/<repo>.rejected.jsonl`, with why. Nothing is undone: the facts it kept stay. Every read's
session is told this first. When a session ends its turn with facts rejected, Atticus gives it one
more turn in the same session listing each reason. The part's second session (a new one) starts
from the reasons too; they stay in the rejected file for it.

If the second session adds nothing either (no fact and no reviewed line kept), the run stops that
repo there instead of going on to its next part. The Console says what was rejected and why; the
app shows the repo on the run's strip and under Problems (**Copilot stopped reading**). The run
goes on with the next repo. Fix the rejected lines (or read the part in a new chat), and the next
run carries on from there.

## From the app

With copilot-acp allowed, Map › Trust has buttons that start the same run from the app (ADR 0173):
**Read the stale repos with Copilot**, **Fill the gaps with Copilot**, **Read the repos not read yet
with Copilot**, and on each repo **Read it again with Copilot** (whole, as `--force`). Each asks first:
a dialog names what the run reads, the model from runtime.yaml and what a session may do, and nothing
starts until you say yes. Where Atticus doesn't know the model's limit, the dialog asks for it (see
[The model's limit](#the-models-limit)); it also says when the assistant files will be written
first, and won't start while one is edited by hand. The app's server runs `atticus map --all`'s own code (no shell), one run at a
time.

While it runs, a strip under the top bar says which repo of how many, the session under way, the
facts kept and rejected and the tokens so far, with **Stop**. The **Console** at the foot of the app
(open and close it with its button) lists the run beside everything else Atticus is doing (ADR 0187;
troubleshooting, "Where to see what Atticus is doing"). Pick the Copilot run to see what it prints: a
tab for the run, then one per session with its steps as Copilot takes them and the verify after it. It
follows the end unless you pick an older tab; search and copy work on the tab shown. An `atticus map
--all` run in a terminal shows in the Console too, as its own entry with what it prints. A reload, or the app in VS Code or IntelliJ, picks
the run up where it is. Stop cancels the session under way, as Ctrl+C does; the next run carries on.

## What a session may and may not do

These rules are fixed in Atticus. No setting widens them.

| A session may                                                                                                     | A session may not                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| read files under the metarepo and the repos' clones                                                               | read anything outside them                                               |
| write the step's own result: `facts/` for a read, `proposals/questions/` for proposals, the result file of a step | write anything else: the org pack, the catalog, questions, `.git`        |
| run `atticus <command> <arguments>` (this same Atticus, no shell)                                                 | run any other program, or a command line with `\|`, `&`, `;`, `>` or `$` |
|                                                                                                                   | answer a question, `--approve`, `--accept`: those are a person's         |
|                                                                                                                   | fetch a web page, delete or move a file                                  |

When the session asks permission for something these rules allow, Atticus allows it once; it never
says "always". Everything else is refused, and the session is told why. Atticus adds no network of
its own: the only network is the Copilot language server's own, to GitHub, as in your editor. Your
organisation's Copilot policy (models, content exclusions, agent mode) applies as it does in the
editor; Atticus only narrows what a session may do.

## Signing in

Atticus never handles your GitHub sign-in. The server uses the sign-in your editor's Copilot already
has. If it isn't signed in, the run stops and prints what the server said, with any link and code;
sign in yourself (in your editor's Copilot, or at that link), then run the command again.

## Stopping and carrying on

Ctrl+C stops cleanly: Atticus cancels the session under way, saves where the estate stands and
stops. Run the same command again to carry on; what is done is read back from the facts on disk.
You can also switch between this and pasting lines yourself (`--mode hand-off`): both keep the same
state.

## What is recorded

Each session is a run under `.runs/<change>/<run>/` (`map-<repo>` for a read): `prompt.md`, the
whole conversation in `transcript.jsonl`, and `run.json` with the model the server reported, the
server's name and version, what Atticus did for the session and what it refused. `atticus runs`
lists them.

## Limits

- The editors' own buttons still hand steps to Copilot Chat; the app's Map › Trust buttons (also in
  the editors' app tab) start an unattended run.
- A run started in a terminal isn't shown in the app while it runs, nor the other way round; both
  carry on from the same saved state.
- Atticus can refuse only what the server asks it. It relies on the server asking permission before
  its own tools edit or run anything, as the protocol describes.
