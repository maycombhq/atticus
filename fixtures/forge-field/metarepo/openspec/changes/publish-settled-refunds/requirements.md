# Publish settled refunds

Refunds settle in forge-svc-01 and nothing says so. It publishes each settled refund to
the topic forge.items.settled, which the estate has, so that who listens there hears of refunds too.

## Application architect

forge-svc-01 becomes a second publisher of forge.items.settled. forge-svc-02 publishes to it today.

| Question | Evidence | Asked by | Answered by | Answer | State |
| --- | --- | --- | --- | --- | --- |
| Who receives the topic today, and do they expect a refund on it? | `forge-svc-03.on-forge-items-settled` src/main/java/forge/events/ItemListener.java:1 | application-architect-naysayer | ari | forge-svc-03 listens and ignores a kind it doesn't know | answered |
| Does anything else read the topic that the map can't show? | `forge-audit` | application-architect-naysayer | ari | forge-audit does, by its team's word; it is in the manifest and not read yet, so its task is in this change | answered |

## Developer

The event is published after the refund's row is written.

| Question | Evidence | Asked by | Answered by | Answer | State |
| --- | --- | --- | --- | --- | --- |
| Where is a refund settled in the publisher? | `forge-svc-01` | developer-naysayer | dev | In its settlement entry; the publish goes after the write there | answered |

## QA

A settled refund is heard once by each listener.

| Question | Evidence | Asked by | Answered by | Answer | State |
| --- | --- | --- | --- | --- | --- |
| What if the publish fails after the row is written? | - | qa-naysayer | quinn | The refund stays settled and the publish is tried again from the row | answered |
