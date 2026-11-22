# Conformance of a quick change (ADR 0206)

Does the code have what a quick change's design says it will? `refund-receipts` gives forge-refunds
a receipt for each settled refund. Its `change/design.md` has the table under `## In the code`;
`facts/` holds forge-refunds's verified facts at the branch's base and commit, `tree/` the
commit's files, `files/` the lines the deploy and config facts cite (for a value written on its
line). The table's operation rows (deployment, route, config, secret, pipeline, cut-over) are
read with `pairsOf` as an operation's `sets`. `expected/` is written by hand; never regenerate it from the check's output.
Everything here is invented.
