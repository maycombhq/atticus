# 0192. A library of the estate's own is what its services depend on: build coordinates as facts

- Status: accepted (pending review by the product owner)
- Date: 2026-11-10
- Builds on: ADR 0068 (`Component.uses`, a module's build dependencies inside one repo), ADR 0124 (facts the assistant writes, the verifier checks), ADR 0135 (why is this linked, this link is wrong), ADR 0167 (rule sets a read is topped up with), ADR 0174 (corrections from the canvas)
- Contracts: the facts file (ADR 0124) gains the `artifact` and `dependency` kinds at version 5, additive: older files read unchanged. C4 (local API 3.10.0, unreleased, so no bump) adds the graph edge type `depends-on`, the join `how` `coordinates` and the join's optional `dependency`. C1 is unchanged: nothing is projected from the new kinds. The corrections file is unchanged: its `target.kind` takes every fact kind, these two included.

## Context

An estate often has a library of its own (an invented example: `forge-payments-common`) that several Spring Boot or Fuse services build on as a Maven or Gradle dependency. The map drew it as one more box beside the services, with nothing joining them, and a reader that met the library's client classes in a service sometimes wrote them as calls, so a box named from the reader's free text appeared. What a person expects, in their words: the dependency shown as a line, the library's own calls its own, and an arrow from every module that builds on it, because it is our own repo.

Nothing in the facts said what a build publishes or what it depends on. ADR 0068 read a module's dependencies inside one repo with a built-in reader and left "uses across repos" to the framework model (ADR 0054), which teaches what a house library's annotations mean, not who depends on it.

## Decision

### 1. Two fact kinds (facts file, version 5)

```
artifact:   group: text, name: text, version?: text
dependency: group: text, name: text, version?: text, scope?: compile|runtime|provided|test|import
```

An `artifact` fact is the coordinates a component's build publishes: a pom's own `<groupId>` and `<artifactId>` (a module that writes no `<groupId>` has its `<parent>`'s), a Gradle project's `group` and name (`rootProject.name`). A `dependency` fact is a dependency the build declares in its dependencies (never a `<dependencyManagement>` entry, a plugin's dependency, an exclusion or a BOM import). Each is cited on the line that writes the name (`cite.value` the name, or a Gradle line's coordinates as written), with the group's line, and the version's when one is given, in `cite.with`. A dependency belongs to the component whose build file cites it: a module's pom is its module's (`component`). Coordinates are written resolved (`${project.groupId}` is refused by the schema; the line that writes the value is cited).

Two kinds, not one with a role: they are joined against each other, a repo has one of the one and many of the other, and the verifier checks each against a different part of the build file. Fields of their own, not `framework` facts: a framework fact names what a component is built on in the sense of its reading rules (Spring Boot, a house starter to learn), it is one per framework, and a dependency on the estate's own library is no framework to learn.

The reader records every dependency, the organisation's own or not. Which are the estate's own is never the reader's call, nor a group prefix or naming convention's: it is read from what the estate's repos publish (section 3).

### 2. The verifier reads the build file (rule 4)

`verify/src/build-coords.ts` is a small deterministic reader of a pom (elements line by line, comments left out) and a Gradle build (a dependency line's configuration and coordinates, `group = '…'`, `rootProject.name`). The verifier checks, beside the usual line check of the name: an `artifact`'s cited line is the project's own `<artifactId>` (not a dependency's or the `<parent>`'s); a `dependency`'s is a `<dependency>`'s in `<dependencies>`, not under `<dependencyManagement>` or a plugin; the name is the one that line writes; the group the project, its parent or the dependency writes is the one claimed and its line is cited; the scope is the one declared (a Gradle `test…` configuration is `test`). A miss is `build-coordinates`, with the line it found instead. The same reader is the cross-check: the coordinates and dependencies the build files a kept fact cites write that no fact records are a note (`buildUnrecorded`), never a rejection. The reader is never the path to the facts: it writes none.

### 3. The dependency join

`joinDependencies` (`core/src/facts-deps.ts`) pairs every `dependency` fact with the `artifact` fact whose coordinates (group and name, letter case aside) it names: a "depends on" link from the depending component to the library's, cited at both ends. A dependency on coordinates nobody in the estate publishes draws nothing and asks nothing (counted as `outside`); a test-scoped one draws nothing (`test`); coordinates two components publish draw nothing and are said (`ambiguous`); a component's dependency on itself draws nothing. Pure and order-free.

The library's own calls are untouched: they are the library repo's call facts, joined as before, and nothing of the library is given to the services that depend on it.

### 4. Where it shows

Nothing is projected into C1, as with framework facts: `Component.uses` stays ADR 0068's (a module's dependencies inside a repo, from a built-in reader), and a cross-repo link with its lines at both ends has no C1 field to hold it without a C1 bump. The views read the facts: the graph API (`ui-api-graph.ts`) joins the verified facts on file and hands the links to `buildEstate`, which draws each as a `depends-on` edge between the two catalog components (a link whose end isn't in the catalog yet is left out, never a box of its own). It is its own edge type, so it is never merged into the calls or counted with them, and it is lifted to system level like every edge. The architecture and repo lenses draw it; the integration, data and infrastructure lenses don't (it is no call, event or table). Its join's `how` is `coordinates`, `verified` (code at both ends, each claim checked on its line), with `dependency` (group, name, version, scope), the dependency's lines as `caller` and the publishing lines as `callee`.

The canvas draws it dash-dot with the label "depends on" in words (in italics), and the legend says it apart from the calls with its count; the link counts by who made them leave it out. Why is this linked? says the coordinates and both ends' lines. This link is wrong marks the dependency fact on the depending build file's line `wrong`, with why (required), through the existing corrections file: verify leaves it out and the arrow goes at the next write, as any fact marked wrong does. A dependency arrow has no "All calls on this arrow are wrong" (it has no calls); each dependency on it is corrected under itself.

### 5. Reads before this

The rule is its own rule set, `build-coordinates` (ADR 0167), on the build files: a repo read before is topped up with it alone (`atticus map --all --stale`), and a read with no record lacks it too. A batch prompt (tiers 2 and 3) whose files include no build file carries neither the rule nor the two kinds' lines of the facts reference: a small model's room is mostly its instructions (ADR 0124 addendum A-lean), and at an 8,000-token limit two more lines everywhere left a batch of a generated client less room than a batch may have. The tier-1 command carries everything, as before.

## Consequences

- A library of the estate's own is drawn as what its services build on, with no naming convention to configure; a vendor's SDK and open-source libraries stay off the map.
- The library's calls are its own, so a call through it reads as the library's, once.
- Not done: `depends-on` in `map.md`, impact (`atticus impact`) and the ecosystem views read from C1; a dependency declared through a version catalog (`libs.forge.payments`) or a property's value (cited, but not resolved by the reader); npm, NuGet and Python packages (the same two kinds fit them, with readers of their own); the transitive reduction `uses` edges get.
