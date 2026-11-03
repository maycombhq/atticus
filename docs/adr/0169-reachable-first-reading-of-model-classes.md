# 0169. Reachable-first reading of model classes

- Status: accepted (pending review by the product owner)
- Date: 2026-11-03
- Builds on: ADR 0124 (facts the assistant writes; addenda A-big, A-ledger, A-read, A-lean), 0157 (a second pass on the gaps), 0161 (the whole estate in one command), 0164 (a contract check on every link), 0167 (a top-up for reading rules added since a read)

## Context

A Java service behind a gateway proxy held about 350 request and response classes (about 1M tokens). Its first read, in Copilot agent mode, ran short of room and marked big folders "reviewed, nothing to record" (18 files read, 511 reviewed). The folders held its controllers as well as its DTOs, so the repo had no REST entries and no field facts, and the contract check (ADR 0164) had nothing to compare between the gateway's payloads and the service's. Leaving the DTOs out by an exclusion is wrong: their fields are what a mismatch is found in. Reading all 350 cost about 25 sessions, most of them on classes no route or call uses.

## Decision

### 1. Reachability, by text alone

`reachableModels` (`packages/verify/src/reachable.ts`) finds which model classes a repo's entry points and outbound calls reach, without a parser:

- **A model file** (`isModelFile`) is code in a model folder (`model(s)`, `dto(s)`, `payload(s)`, `schema(s)`, `pojo(s)`, `beans`, `viewmodel(s)`) or named for one (`...Dto`, `...Request`, `...Response`, `...Payload`, `...Model`, `...Body`, `x.dto.ts`, `x_schema.py`). A class that maps a table (`@Entity`, `@Table`, `[Table(`, `__tablename__`, `models.Model`, `gorm.Model`) is never one: its columns are store facts.
- **The roots** are, when the repo is read, the files its entry and call facts cite; then every file the planner ranks as an entry point (`readingRank` 2) or a client or publisher (by name, folder or a `.controller.ts`-style part). A root no fact cites is still a root, so a read that swept its controllers away is put right.
- **Type names** are the identifiers a root's text names that a model file declares: its basename when it reads as a type's (`ListingRequest.java`), or a `class`, `record`, `interface`, `struct`, `enum`, `object` or leading `type` line. The same patterns hold for Java, Kotlin, C#, TypeScript, Python and Go.
- **Transitively**: each reached model file's own identifiers are followed in turn. With facts, a model file a kept fact cites is reached (it was read), and a field fact's `type` (and a message type's `name`) is followed.
- Each model file is read once; the order is fixed by the paths alone. A repo with no root at all (a library of models) leaves nothing out.

It is a choice of what to read first, never a fact: the assistant reads every reached file and cites each fact as before.

### 2. Planning

`atticus map <repo> --estimate` (and the `map --all` that plans through it), a first read or `--force` in batches, `--gaps` (and `--part n --gaps`) and the rules top-up (ADR 0167, the field-types set and the others) all take:

1. the build and config files and the entry points and clients,
2. the reached model files in reachability order, each by its own path,
3. everything else, as folders where a folder holds nothing else.

No folder glob covers a model file left out (`planParts(files, room, order)`, `planBatches({ reach })`, `planGaps(…, { first })`). Model files nothing reaches are left out by default and recorded in the read plan as `notReached` (why, the files, their tokens), never silently: `--estimate` says how many and lists them in a data block, and the estimate's files, tokens and parts count reflect it. `--models all` reads every one; the plan records `models: all`, so the sessions `map --all` gives keep it, and `--models reachable` goes back. A re-read (A-incremental) reads what changed and keeps what the plan records.

A part's unit that names one file (an entry point, a reached model class) is done when a fact cites that file or a reviewed glob names it, not when another file of its folder is.

### 3. What the reader is told

The estimate, the batch prompts, the gaps prompt and the top-up prompt carry the reached model classes, each with the names it declares and where it is reached from, in a data block (rule 6: the paths and names are the repo's text), with one rule (`MODELS_RULE`): write a field fact for each field (name, type, required, side), owned by the entry or call that takes, returns, sends or receives it; never mark an entry point or a folder holding one reviewed. The /atticus-map steps say the same. FACT_RULES are unchanged, so its hash and the reads it records are too; the step's golden file and the generated plugin and agents are regenerated.

### 4. verify

- `coverage.notReached`: the model files the plan leaves out that no fact cites and no reviewed line names. They are neither unknown nor reviewed, and out of the ratio; verify says "N model files no entry or call reaches; atticus map <repo> --models all reads them". `--gaps` doesn't plan them.
- A reviewed glob covering an entry point (a controller, resource, route, handler, listener, consumer or endpoint by name or folder: `isEntryPointFile`) no fact cites is refused: read it. One file reviewed by its own path still holds, so a stub controller can be said to hold nothing. The planner's wider entry rank (`main`, `index`, `...Api`, which generated clients are named too) is read first but not refused.

The read plan is the CLI's own file, not a contract; `models` and `notReached` are optional and an older plan reads as before. `coverage.notReached` is the verifier's report and the `verify.yaml` summary's (left out when none). No schema of C1 to C6, nor the facts file, changes.

## Consequences

- The repo of the context is read in a handful of sessions instead of about 25, its controllers first, and the classes they use have field facts the contract check compares.
- A model class only a service, a mapper or reflection names is left out; it is listed, and `--models all` reads it. A class named only in a comment of a controller is read: over-reading costs tokens, never accuracy.
- A read that marked an entry point reviewed with a glob now fails verify until it reads it; reviewing the one file by its path still holds.
