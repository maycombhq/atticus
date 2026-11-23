# A quick change's tasks and their acceptance criteria (v31, WP-05)

`refund-receipts-tasks` is a quick change of forge-refunds. Its `change/tasks.md` states the
criteria of a task in the two ways the plan hand-off reads:

- its own: an indented list item under the task's checkbox line, in the one-line form the stories
  stage writes (`- Given …, when …, then …`);
- its spec's: a row of `design.md`'s `## In the code` whose Task is the task and whose Spec names a
  requirement of a spec delta that has a `#### Scenario:`.

r1 has both, and an error case of its own. r2 has only its requirement's scenario, which names no
failure (a note). r3 has its own criterion, which names an entry nothing has (a note), and calls
another system with no error case (a note). r4 has neither, so the hand-off is refused. Everything
here is invented. The expected findings are in `packages/changes/test/quick-tasks.test.ts`,
written by hand.
