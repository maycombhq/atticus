# 0050. The local log, crash safety and the support bundle (C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

When something went wrong at an install there was nothing to look at afterwards: errors went to the terminal and were gone, a scan cut short could leave the catalog half-written, two scans could run at once, and nobody could say what to send a person helping without sending client data with it.

## Decision

- **The local log.** Every command and every API call of `atticus ui` is logged to `.atticus/logs/atticus.log`, one JSON object per line: the command and its flag names (never their values), the exit code and the time taken; API calls by method and path (never the query or body), at debug level unless they fail. A crash is logged with its stack, and the terminal says where the log is. Every entry is redacted before it is written (credentials in URLs, bearer tokens, `token=`-style values, secret-named fields, long opaque keys, the home folder and user name). `ATTICUS_LOG=debug|info|warn|error|off` sets the level; the log rotates at 5 MB and keeps three old files. Writing the log never fails a command.
- **This machine's files stay out of Git.** `.atticus/.gitignore` lists `me.yaml`, `logs/` and `locks/`. It lives inside `.atticus/`, so it works the same in a metarepo and in a repo adopted in place.
- **Whole files.** `writeFileAtomic` moves to core: a unique temporary file beside the target, then a rename, retried briefly on Windows when a scanner holds the file. Catalog records, change files, findings, rounds and migrations are written this way, so a crash leaves every file either old or new, never half.
- **One scan at a time.** A scan takes `.atticus/locks/scan.json` (process, host, start). A second scan is refused with who holds it; a lock whose process is gone was cut short, is taken over, and the new scan says the last one didn't finish. `atticus doctor` reports an interrupted scan.
- **`atticus support bundle [--out file.zip] [--json]`** writes a zip on this machine and sends it nowhere: a README, versions and layout, the doctor checks, the setup checklist, org-pack problems, counts (records per kind, changes per state, repos, input files: numbers, never names) and the last 2,000 lines of the redacted log, with paths starting at `<metarepo>`. No catalog record, change, org-pack file, document or code. The README asks the person to read every file before it leaves the organisation.

## Consequences

A problem at an install can be looked at after the fact, and handed to someone without handing over the estate. The redaction is a safety net, not a guarantee: error messages can name a system or a change, which is why a person reads the bundle first.
