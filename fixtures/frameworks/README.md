# What nine repos are built on (invented)

ADR 0124 addendum A-framework. Everything here is made up: Forge is an invented company and
`com.forge.platform` its invented house platform. Each repo is a build file and just enough code
to have one entry point, read by hand into facts the way `/atticus-map` asks.

| Repo | Built on | What it shows |
| --- | --- | --- |
| `repos/forge-ledger-api` | Spring Boot 3.3.4, `forge-web-starter` 2.8.1 | A parent pom's version; a module (`web/`) that declares its own framework, whose version is held in a property of the parent pom (`versionCite.with`) |
| `repos/forge-statements` | ASP.NET net8.0 | A framework declared by an MSBuild SDK, whose version is a `<TargetFramework>` on another line; `Microsoft.EntityFrameworkCore.SqlServer` is a library the code uses, not what the repo is built on, so no fact records it |
| `repos/forge-notify` | Express 4.19.2 | Name and version on one line of `package.json` |
| `repos/forge-portal-web` | Angular 18.2.3 | A scoped npm package; a screen entry, which is what Angular's patterns produce |
| `repos/forge-admin-web` | React 18.3.1 | The same for React |
| `repos/forge-rates` | Quarkus 3.15.1 | A BOM in `dependencyManagement`, its version a `${property}` on a third line |
| `repos/forge-reconcile` | Django 5.1.1 | A PyPI requirement written `django==5.1.1`, name and version on the one line |
| `repos/forge-audit` | Rails 7.1.4, Sidekiq 7.3.2 | A Gemfile, which the reading order now puts with the other build files; **a gap**: Sidekiq is declared and no `batch-job` entry is in the facts |
| `repos/forge-cards-api` | Spring Boot 3.2.9, `forge-card-starter` 4.2.0 | **A gap**: Spring Boot is declared and the facts hold no REST entry, because the routes are in the house starter's `@ForgeEndpoint`, which no reader here can see. **A prompt to learn**: `forge-card-starter` is a house framework Atticus doesn't know, so it is learned as a C6 framework file rather than guessed at |

`facts/` holds what a reader writes for each repo, verified against `repos/` in
`packages/verify/test/frameworks.test.ts`. Files here are byte-exact: the facts cite their line
numbers.
