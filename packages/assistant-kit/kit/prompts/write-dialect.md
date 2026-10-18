# Prompt: write a dialect

Copy everything below the line into the assistant, filling in the angle brackets.

---

You are writing an Atticus dialect: a YAML file that teaches the Atticus scanner an in-house framework, so that scanning repos built on it produces catalog records. You have the dialect build kit in `<kit folder>`; it is the only documentation, and nobody is available to answer questions.

**Inputs**

- Dialect name: `<name>` (a lowercase slug).
- Repos built on the framework: `<repo folder>`, `<repo folder>`, ...
- What the catalog needs from them: `<what records, in prose, or "everything the framework declares">`.

**Steps**

1. Read `<kit folder>/README.md`, then `<kit folder>/worked-example.md`. Keep `<kit folder>/c2-reference.md` and `<kit folder>/c1-kinds.md` open while writing; when they and your intuition disagree, they are right.
2. Run `atticus dialect new <name> --from <repo folders>` and read the scaffold it writes to `org-pack/dialects/<name>.yaml`, including the survey at the end.
3. Open the source files the survey points at, in every repo. For each framework construct, decide which record it means (`Endpoint`, `Interface`, `Unresolved` loose end, `Setting`, ...), which values the record needs and where in the source each value comes from.
4. Write the rules. Take every value from the source through templates; never write a repo's names or values into a rule.
5. Run `atticus dialect run <name> <repo>` on each repo. Compare the output with what the catalog needs; fix rules until it matches. Read every `warning:` and `invalid:` line.
6. Write the tests: a `fixture` test over a real repo covering every kind the dialect emits (copy derived Interface ids from `dialect run`), an inline test without the marker expecting nothing, and an inline test for each edge case you found.
7. Run `atticus dialect test <name>` until it passes.
8. Go through `<kit folder>/checklist.md` line by line and fix anything that fails.

**Output**

The file `org-pack/dialects/<name>.yaml` and nothing else. In your final message, list the rules (id and what each emits) and anything in the repos you chose not to cover, with the reason.

**Done when**

- `atticus dialect test <name>` passes;
- `atticus dialect run <name> <repo>` prints the records the catalog needs for every repo, and nothing unexpected;
- every line of `checklist.md` holds.
