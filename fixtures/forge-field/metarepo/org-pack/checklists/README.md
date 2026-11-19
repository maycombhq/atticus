# Checklists

Critic rule packs (contract C3), one YAML file per pack. The constitution is built in; packs here add organisation rules.

`review.yaml` is the starter review (ADR 0120): AI rules the critic's lenses apply to every draft, judging its meaning against the estate and the brief, and three code checks (a call's timeout, a store write's rollback step, a story criterion from an attached note quoting the note's line). It is this organisation's configuration, not the constitution: change, waive or retire its rules, or delete one, through a pull request. Delete the file to turn the starter review off; `atticus upgrade` won't add it back.
