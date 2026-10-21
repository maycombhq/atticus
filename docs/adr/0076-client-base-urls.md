# 0076. Client base URLs in scan settings (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0075 (scan settings per repo), ADR 0074 (the AI reads; every fact cites its code)

## Context

The bench (`bench/README.md`) found no call in any of its four front ends. Their URLs are built from a base set somewhere else: an Angular environment file (`environment.REST_API_URL + 'owners'`), an HTTP interceptor that puts a base in front of every request, an axios instance's `baseURL`, a generated client's base path. The readers either dropped those calls (a URL that isn't one written string, a call with type arguments such as `this.http.get<T>(...)`, a call through an axios instance) or kept a path with no host that joins nothing.

Where the base is, and which names in code hold it, is a fact about one repo that a reader of the repo can see and no built-in reader can know in general. ADR 0075 left it as the next kind of scan setting.

## Decision

1. **The readers record the call with the base's expression.** The frontend reader reads a call to `fetch`, `axios` or `http.<verb>` whose URL is built: it follows the names the file assigns (class fields too, `this.entityUrl`), and the first name it can't know becomes the base, written `${name}`, as Spring placeholders are: `GET ${environment.REST_API_URL}owners/{ownerId}`. Only a base that names configuration is kept: a member (`environment.X`, `this.url`, `import.meta.env.X`), a constant in capitals or an imported name, followed by a written part of the path (or alone when it is a member). A bare parameter (`fetch(url)`) isn't recorded; the helper reader (ADR 0069) reads those. Requests through an axios instance the repo makes are read where the instance is imported, also through an alias (`@/lib/api-client`), with the instance's `baseURL` read the same way. Mock handlers (msw) aren't calls. Calls in a Node server package stay the node reader's.
2. **Scan settings gain `clients`** (`ScanSettings`, schema version stays 1):

   ```yaml
   clients:
     - paths: ["src/app/**"]
       base: http://localhost:9966/petclinic/api/
       names: [environment.REST_API_URL]
       why: REST_API_URL in the production environment file
       at: "src/environments/environment.prod.ts:25"
       value: http://localhost:9966/petclinic/api/
   ```

   For a call in a file matching `paths`, a URL that starts with `${name}` for one of `names`, or a path with no host, gets `base` in front; the first entry that applies wins. `base` is a URL or a path starting with `/`.

3. **The citation check** refuses an entry whose cited line doesn't contain `value`, whose `base` doesn't end with `value` (a host may be put in front of a path the line gives), or whose `names` appear in no file it covers. A refused entry is reported and not applied. A resolved call keeps its id and cites the base's line as a second piece of evidence, so the interface it joins cites both.
4. `atticus scan survey` asks for `clients`, shows the assistant the calls the readers found without a host, reads the usual client config files (environment files, interceptors, `.env`, Vite config, proxy config), and checks the answer as above.

## Consequences

- C6: `clients` is a new optional list with an empty default, so every existing settings file still loads and scans as before; the schema version stays 1 and there is no migration. A file that uses `clients` is refused by an older Atticus (the schema is strict), which is acceptable because the org pack and Atticus are upgraded together.
- Without settings, built calls are now recorded and join nothing (merge leaves `${...}` loose). On the bench they count as wrong until the repo is surveyed: measured read-only on today's bench, calls found 16 → 32 and wrong 28 → 62 across all repos without settings, and no other repo changed. With hand-written client entries of the kind the survey drafts: spring-petclinic-angular 30 of 30 calls (0 wrong), angular-realworld 18 of 19 (0 wrong; the one missed is a path chosen by a condition), bulletproof-react 32 of 32 (0 wrong).
- Not built: calls through a generated client's methods (fastapi-template's `@hey-api` client, 0 of 16), a base chosen at run time by a condition, a fetch wrapper that passes the URL through another function first (bulletproof's Next.js App Router client; its calls are found through the Pages Router app, which makes the same ones), and relative paths with no leading slash outside axios instances.
- Tests use the mock runtime; no test calls a model.
