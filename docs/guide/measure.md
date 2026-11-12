# Measuring your map on your own estate

How well has Atticus read your repos, and how often does it join a call to the right repo? On
your own code, only you know. `atticus join measure` lets you say it for two or three repos you
know well and scores the map against what you wrote. It reads files only: your org pack, the
verified facts in `facts/`, and the answers to the targets questions. It writes nothing but its
report, so nothing of your estate leaves your metarepo.

## 1. Write the reference

Pick two or three repos you know: one that calls through your API gateway, one behind the
platform's ingress, one that calls a vendor. For each, list the entries it serves and the calls
it makes, and for each call the repo it should reach. Keep the file in your metarepo, for example
`measure/links.yaml`:

```yaml
estate: our-estate # any name; it heads the report
repos:
  - repo: portal-bff # the repo's id in repos.manifest.yaml
    entries:
      - GET /portal/accounts/{id}
      - POST /portal/payments
    calls:
      - call: GET /accounts/v1/accounts/{id}
        at: src/main/java/portal/AccountsClient.java:16
        reaches: accounts-service # the repo it ends at, after any gateway
      - call: POST /v2/charges
        at: src/main/java/portal/ChargesClient.java:22
        outside: northwind-pay # a profile system no repo of yours belongs to
      - call: GET /ping
        reaches: none # nothing in the estate should be linked
```

- **An entry** is `METHOD /path` as callers use it, or `{ entry, at, fact }`.
- **A call** is found by `call` (`METHOD /path` as the code writes it; a base URL in front may
  be left out), by `at` (`file:line`, matched within 3 lines), by `fact` (the fact id), or by
  more than one of them. Give `at` where two calls share a path.
- **What it should reach**: `reaches: <repo>` (a repo id or its component), `reaches: none`, or
  `outside: <system>` (a system's id, name or alias in your profile: a vendor, or another
  team's system that no repo here belongs to). Through a gateway, name the repo the call ends
  at; where the gateway forwards out of the estate, name the gateway's repo, and give the
  gateway's forwarding call `outside:`.
- `note:` on a call is yours; Atticus ignores it.

## 2. Measure

```sh
atticus join measure measure/links.yaml
atticus join measure measure/links.yaml --json
```

The report says:

- **Reading**: how many of the entries and calls you listed are in the facts. A miss means the
  reader left it out: read the repo again (`atticus map <repo>`), or check the line and path you
  wrote.
- **Join precision**: of your listed calls the join linked to a repo, how many reach the repo you
  named. A wrong one is usually a guess (joined by path, by a host's first label, by a platform-wide setting or a setting's folder name, or despite an open host conflict).
- **Join recall**: of the calls that should reach a repo, how many do.
- **The rest**: calls asked about (answer them with `atticus questions`, then
  `atticus verify --all --write`), guesses and how many were right, outside systems, calls nothing
  linked, and listed calls not read.

Then each call, `ok` or `--`, with what you wanted and what the join made of it.

The join is the one `atticus verify <repo> --write` makes: the manifest's hosts and base paths,
your profile's outside systems, and the targets people named. A call whose base URL is a
`${PLACEHOLDER}` set in a deploy or config repo is asked about, not joined, today, so it counts
as a miss.

`atticus estate measure` is the same command.

## A sample audit: precision across the whole estate

A reference is thorough but takes a while to write. For a quick, honest number on every repo, audit a sample instead (ADR 0148):

```sh
atticus verify audit forge-payments            # 10 kept facts and 10 links, drawn at random
atticus verify audit forge-payments --size 5 --seed s2   # another sample, the same every time for s2
```

Each fact and link is shown with every line it rests on (a link with how it was joined, and each gateway hop), and on a terminal you answer right, wrong or unsure. A wrong fact is corrected with Correct this on the Map; a wrong link with Why is this linked? › This link is wrong. The answers go to `facts/<repo>.audit.yaml`, your record: commit it in a pull request. Nothing is sent anywhere.

In the app, Map › Trust's Sample audit has **Answer a sample**: it draws the same sample (the same seed and size give the same items as the command), shows each item with its lines, and writes your right, wrong or unsure (with a note) to the same file. A wrong fact opens Correct this in place; a wrong link points to the canvas, where the link's Why is this linked? › This link is wrong corrects it. The app writes only the audit file and gives the `git` command; it runs none.

From a script or an agent, give the answers instead of being asked: `--answers answers.yaml` (each item id, as the sample lists it, mapped to `right`, `wrong` or `unsure`, or to `{ answer: wrong, note: ... }`), or `--right`, `--wrong` and `--unsure` with comma-separated ids.

```sh
atticus verify audit forge-payments --report   # precision per kind of fact and for links
atticus verify audit --report                  # every repo audited, and the estate
```

The report gives the share right of those answered right or wrong, how many that is, and a 95% interval. A sample of ten says little: 9 of 10 right is somewhere between 60% and 98%, so read the range, not the number, and draw more with another seed. A fact answered right shows as checked by the sample on the Map while it still cites the line you saw; Map › Trust shows each repo's audit.

## Canaries: recall, fabrication and the silent error rate

The audit measures real lines read wrongly. It can't see what a read misses, or a claim about something that isn't there. A canary does, on your own code and with nobody labelling anything (ADR 0196):

```sh
atticus canary plant forge-payments            # a run folder outside the metarepo: the copy and a prompt
# open the run folder it names as your assistant's workspace, so it asks about no file outside it:
#   code <run folder>                (Copilot in agent mode)
#   cd <run folder> && claude        (Claude Code)
# give it prompt.md in a new chat; it reads the copy and loops, in the run folder, on:
atticus verify --here                          # the same as atticus canary check forge-payments
# then, back in the metarepo:
atticus canary score forge-payments            # writes reports/canaries/<date>-forge-payments.yaml
atticus canary report                          # the latest canary of each repo, and the two numbers
```

In the copy, Atticus plants a few made-up entries, calls, topics and config keys (by template, for Spring, Node and Python code) and comments out a few real lines your verified facts cite. It plants only what the repo can serve: a library the build files of the module it plants in already declare (no Kafka topic without a Kafka client, no route or `process.env` in a browser app; Gradle version catalogs and `buildSrc` convention plugins count), a route only on an app or router the repo makes (a blueprint or router only when the app registers it), and Spring classes beside the `@SpringBootApplication` class; nothing it plants would crash if it ran. What it leaves out, and why, is in the plant's output, the report and Map › Trust. The copy holds no file of secrets or credentials (env files, registry, database, cloud and cluster credentials, keys and key stores, Terraform's variables and state, and their backups), no file whose start holds a private key or a token, and no link. The run folder is in `atticus-reads`, a folder of yours that no other user can write to, in the temporary folder; its name, the prompt and the check say nothing of a canary. The key remembers where that folder is, so the check and the score find the run even with another temporary folder set later; if the folder can't be trusted any more (opened to others, say), they touch nothing in it and keep the key, and say so. The prompt is `/atticus-map`'s own protocol aimed at the copy, recall loop and all, so the canary measures the read you use.

The read must find what was planted (recall) and leave out what was taken out (fabrication); a claim about a commented line that the verifier still kept is a silent error. The seed is drawn at random each time, so no read can work out what was planted; it is in the report, and `--seed` plants the same copy again. Atticus runs none of the code and calls no model: your assistant does the read. The copy, the prompt and the key are deleted when the canary is scored (or kept, when nothing in the facts file reads, for you to fix it), and the report is the only file written to the metarepo: commit it with the audit. It names each planted item by its kind, stack and result only, never its words or place, so a report on file teaches no later read what a canary plants.

How often a claim graded as backed is wrong is given as **two numbers side by side**, each with its count and a 95% interval: the **audit misread rate** (the audit's answers on kept facts, and links not joined by a guess, answered wrong) and the **canary pass-through rate** (lines taken out that a read still claimed and the verifier kept, of the lines taken out). They measure different things, so they are never added up. A fact that names a removed path but cites another line is counted apart, in neither. Run canaries on a few repos of each stack per release, not on every read. Map › Trust shows both numbers, their ranges and what the canaries cover.
