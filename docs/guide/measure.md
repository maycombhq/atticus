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
  named. A wrong one is usually a guess (joined by path, or by a host's first label).
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
