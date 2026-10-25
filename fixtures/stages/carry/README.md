# Findings carried into the next draft (ADR 0087 and 0115 addenda, 2026-10-25)

A real change's run through feature, architecture and stories, retold on the invented Forge
estate of `add-fraud-check`. The critic found a real bug (a cache key missing a data version)
in the same round in which the assistant asked a question; once the question was answered, the
next draft wasn't told about the finding. The tests copy these files in themselves, with
`../lenses/checklists/stage-review.yaml`:

- `feature-asks.yaml`: the first placement. It caches the screen's verdict by order id only,
  and asks a question a person answers.
- `feature-fixed.yaml`: the placement once the finding is handed back: the cache key has the
  screen's data version.
- `findings-true.yaml`: the true lens's blocking finding on the first placement, with its fix.
- `findings-complete.yaml`: the complete lens's risk finding (rule `brief-outcome-placed`, a
  risk): handed back for one more draft, never blocking.

Everything here is invented.
