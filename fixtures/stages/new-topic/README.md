# A change that publishes to a new topic (ADR 0207 part 4)

forge-orders publishes `forge.orders.shipped`, a topic the map doesn't have, through forge-hub,
and forge-ledger adds a flow that listens to it. `flows.yaml` holds the two flow deltas, the
publish step carrying `topic` (its format, schema file, key, fields, classification and
settings). `design-topics.md` is the "Topics this change adds" section design.md gains, written
by hand; never regenerate it from the renderer's output. Everything here is invented.
