# Conformance fixtures (ADR 0114)

Does the code do what the design says? These files give the transfer limit (`add-transfer-limit`,
`../forge-change`) target flows for forge-ledger, and a state of forge-ledger after its tasks
that builds only part of them. Everything here is invented: the Forge platform and the vendor
Northwind Pay.

| Folder | What it holds |
| --- | --- |
| `specs/forge-ledger/` | Today's flow for POST /transfers, citing `../forge/repos/forge-ledger` |
| `target-flows/` | The approved target flows: `ledger-api.create-transfer` (modify: a limit lookup with its migration, a velocity check call to Northwind Pay, a refusal branch, the direct payment call removed) and `ledger-api.get-limit` (a new flow behind GET /accounts/{id}/limit) |
| `stories/` | A story in the stories stage's layout: which task builds which step |
| `after/forge-ledger/` | The files that differ after the tasks, laid over `../forge/repos/forge-ledger`: the limit endpoint, the migration with `daily_limit` and an extra table, and an extra refund call; the velocity check is missing and the payment call is still there |
| `expected/result.yaml` | Every item the check must report (found, missing, still there, unexpected) and what it can't check, each with its citation |
| `expected/findings.yaml` | The C3 findings it must write on the conform gate |

The expected files are written by hand; never regenerate them from the check's output.
