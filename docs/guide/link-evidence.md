# Contracts and traffic as evidence for links

Atticus links two services when the code shows the call at one end and the entry that serves it at the other. Two kinds of file can back those links up, or show where they are wrong (ADR 0151):

- the **contract files** a consumer keeps: Pact files, and the OpenAPI spec of an API it calls;
- a **traffic export** from your gateway's analytics or your API catalogue.

Neither makes a link. A link Atticus guessed stays a guess, even when a contract or the traffic agrees: only the code naming the callee settles it.

## Contract files

Nothing to set up. When you run `atticus verify <repo> --write`, Atticus reads the repo's checkout for:

- Pact files (spec v2, v3 or v4): `.json` files under a folder or file name with `pact` in it. Each HTTP interaction counts; message interactions are skipped.
- OpenAPI specs the repo keeps for an API it calls: files named `openapi` or `swagger`. A spec the repo's own entries serve is its own spec, and is left alone.

It keeps what it found beside the repo's facts, in `facts/<repo>.contracts.yaml`, so every later write reads the same contracts.

Each request is matched to the links from the consumer by its method and path:

| What Atticus finds                        | What it does                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| A link to the provider the contract names | Flags the link `confirmed-by-contract` and cites the contract's line    |
| A link to another component               | Flags it `contract-disagrees`, and lists it as `provider-differs`       |
| No link (a Pact interaction)              | Lists it as `no-link`: a call the facts don't have, or a stale contract |
| A provider the estate doesn't have        | Lists it as `unknown-provider`                                          |

The provider is the component or repo the Pact's `provider.name` names. For an OpenAPI spec, it is the repo whose manifest lists a server URL's host, or the one its `info.title` names.

## Traffic exports

Export a report from your gateway's analytics, or your API catalogue's usage, as a CSV or JSON file. Then import the file:

```sh
atticus intake traffic september.csv --source apigee --from 2026-09-01 --to 2026-09-30
```

Atticus never connects to the gateway: it reads the file you give it.

**What is kept.** Only counts: how many requests per calling app, method, path, proxy and base path over the date range. No row of the export is kept. Client ids, API keys, IP addresses, user agents, query strings, bodies and every other column are dropped before anything is written. Paths are written as the estate's route templates (`/accounts/{id}`, never `/accounts/ACC-1001`). An app name, proxy or path segment that looks like an IP, an email or a token is dropped too.

**What is refused.** Atticus writes nothing when:

- it can't find an app, a method and a path column;
- the file has no dates and you gave no `--from` and `--to`;
- what it would write still holds a dropped value, an IP, an email or a token-looking value;
- a word in it is on your metarepo's `.denylist`.

The counts go to `evidence/traffic/<source>-<from>-<to>.yaml`. **Review that file in a pull request** like any other. Where an app's name isn't a component, add the component to its row:

```yaml
- app: forge-mobile
  component: mobile-bff
  method: GET
  path: /forge/v1/accounts/{id}
  count: 15
```

The next `atticus verify <repo> --write`:

- flags each link the traffic used `seen-in-traffic`, and cites the row that counts it;
- lists traffic that no link carries (`missed-link`);
- lists links the export covers that nobody used over the range (`unseen-link`): the link may be dead, or joined wrongly.

An export covers the links through the proxies and base paths it has rows for. An export with neither covers the links into the services its traffic reached.

The sources Atticus reads, and the columns it takes from each, are listed in `packages/ingestors/src/traffic-formats.ts`. A new source is a new entry there.

## Where the results are

`atticus verify <repo> --write` prints a `Contracts:` line and a `Traffic:` line, with the first five findings for the repo. Add `--verbose` for all of them. The full lists are under `contracts` and `traffic` in `facts/<repo>.verify.yaml`, which goes in the same pull request as the catalog.
