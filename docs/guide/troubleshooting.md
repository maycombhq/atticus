# Troubleshooting

Start with `atticus doctor` in the metarepo: most problems are on the machine, and each line it prints says what to do.

| What you see                                                 | What it means                                 | What to do                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `atticus` isn't found                                        | The install script's folder isn't on PATH yet | Open a new terminal. On macOS or Linux, add `~/.local/bin` to PATH                                                       |
| "Atticus needs Node.js 22.13 or later"                       | An older Node                                 | Install Node 22 LTS from your software catalogue                                                                         |
| `[FAIL] OpenSpec CLI`                                        | The bundled OpenSpec didn't run               | Run the install script again from the bundle                                                                             |
| `[warn] Long paths (Windows)`                                | Git will fail on deep worktree paths          | `git config --global core.longpaths true`                                                                                |
| `[warn] TLS certificates`                                    | A proxy is set and no extra CA is             | Set `NODE_EXTRA_CA_CERTS` to your organisation's root certificate (PEM)                                                  |
| "Another scan is running"                                    | A scan holds the lock on this metarepo        | Wait for it. If its process is gone, the next scan takes over and says the last one didn't finish                        |
| "The last scan stopped before it finished"                   | A scan was cut short                          | Nothing to repair: this scan brings the catalog up to date. Every file is written whole                                  |
| "This metarepo was upgraded by Atticus X"                    | A newer Atticus has upgraded it               | Install X or later on this machine                                                                                       |
| `[warn] Metarepo version: upgrade steps to run`              | This Atticus writes newer files               | `atticus upgrade`, then a pull request                                                                                   |
| A screen says "The catalog is empty: run atticus scan first" | Nothing is scanned yet                        | `atticus scan`, or _Scan now_ on Scans                                                                                   |
| Port 4321 in use                                             | Another `atticus ui` or program               | `atticus ui --port 4322`                                                                                                 |
| A shipped dialect isn't applied                              | Its own tests failed; the scan lists why      | Check the scan's problems; for your own dialects, `atticus dialect test <name>`                                          |
| "Could not read this Helm template at line N"                | It depends on a form Atticus doesn't evaluate | Nothing is guessed: that template's objects are left out. Move the cluster-dependent part into values if you can         |
| "Remote base ... is not fetched"                             | A kustomization uses a URL as a base          | Scans never fetch; add the base's repo to the manifest so it is scanned as its own repo                                  |
| An AI step waits forever                                     | Hand-off mode waits for your assistant        | Open the prompt it wrote, answer in your assistant, then `atticus handoff done <run-id>`; with AI off, write it yourself |
| A write to a shared system became a step                     | The adapter is manual or couldn't be reached  | Do the step from To-do (every field is ready to copy), then record it: `atticus todo done <step> --by <you>`             |

## The log

`.atticus/logs/atticus.log` in the metarepo: one JSON object per line, newest last. Each command with its flag names, exit code and time; failed API calls; crashes with their stack. Secrets, tokens, credentials in URLs, your home folder and user name are hidden before anything is written. `ATTICUS_LOG=debug atticus <command>` records more for one run.

## Asking for help

```bash
atticus support bundle
```

writes `.atticus/logs/atticus-support-<time>.zip` (or `--out <file>`): versions, operating system, the machine checks, the setup checklist, org-pack problems, counts of records, changes, repos and inputs (never their names) and the last 2,000 lines of the redacted log. Nothing is sent anywhere. Read every file before it leaves your organisation: an error message can still name one of your systems or changes, so remove what you can't share.
