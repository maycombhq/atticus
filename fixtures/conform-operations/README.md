# Conformance of operations (ADR 0206)

Does the code have what a change's operations set? `move-orders-to-anvil` moves forge-orders and
forge-ledger to the Anvil platform. Everything here is invented: the Forge platform and Anvil.

| Folder or file                   | What it holds                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `target-flows/_operations.yaml`  | The change's operations: every kind, one with no `sets`                                           |
| `facts/<repo>.<before,after>.jsonl` | The verified facts of each repo at the branch's base and at its commit                         |
| `tree/<repo>.txt`                | The files of each repo at the commit, as `git ls-tree` lists them                                 |
| `files/<repo>/`                  | The files the facts cite, for the check of a value on its line                                    |
| `expected/`                      | Each repo's result and the findings, written by hand; never regenerate them from the check's output |

The secret's literal in forge-ledger is a plain word, not a secret's shape; the test checks it is
in no output.
