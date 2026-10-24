# The active capability probe (ADR 0124 §4, addendum A-probe)

Hand-written inputs and expected output for `atticus probe` and `atticus probe answer`, and for
the tier `doctor`, `init`, `adopt` and `map --estimate` say once a probe is on file.

- `results/claude-code.yaml`: Claude Code opened the challenge file, wrote the answer file and ran
  `atticus probe answer` itself (tier 1); no limit stated.
- `results/copilot.yaml`: Copilot opened and wrote the files, and the person pasted the line it
  gave (tier 2), with the limit the person stated.
- `results/copilot-stale.yaml`: a measurement of Copilot from January (tier 3), older than 90 days.
- `results/broken.yaml`: not a probe result; it is reported and left out.
- `expected/claude-code.yaml`: what `atticus probe answer <code>` records for a tier 1 answer
  measured at 2026-10-24T09:30:00.000Z.
- `expected/start.txt`: what `atticus probe --assistant claude-code` prints in a metarepo.
