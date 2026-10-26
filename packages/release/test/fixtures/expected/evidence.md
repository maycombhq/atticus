# Evidence pack: add-transfer-limit

Add a daily transfer limit. Generated 2026-10-21T09:00:00Z by Atticus from the files of the change folder (`openspec/changes/add-transfer-limit/`); nothing here is typed by hand, and every item names the file it came from.

## Change summary

| | |
| --- | --- |
| Change | add-transfer-limit |
| Title | Add a daily transfer limit |
| Type | feature |
| State | released |
| Risk | high (score 13) |
| Systems | audit, ledger, northwind-pay, portal |
| Owners | architect: ari, avery; business-analyst: bao; delivery-lead: dana; developer: dev, dee; product-owner: pat; qa: quinn; sre: sam; team-lead: tia |
| Created | 2026-10-19T09:00:00Z by pat |

Source: change.yaml

**Problem.** Portal customers can send any amount in one day. Two accounts were drained last month before anyone noticed, and support had to reverse the transfers by hand. (brief.md:3)

**Outcome.** Each account has a daily transfer limit. A transfer that would go over it is refused with a clear message, and the customer can see how much of today's limit is left. Support can change an account's limit, and every change is recorded. (brief.md:8)

State history:

- 2026-10-19T09:00:00Z: draft → define by pat: Created from the feature template
- 2026-10-19T11:00:00Z: define → design by pat (PR #1): Send to architecture merged
- 2026-10-19T14:00:00Z: design → plan by avery (PR #2): Approve design merged
- 2026-10-20T15:00:00Z: plan → build by dana: Moved to build for the test
- 2026-10-20T15:00:00Z: build → qa by dana: Moved to qa for the test
- 2026-10-20T15:00:00Z: qa → release-ready by dana: Moved to release-ready for the test
- 2026-10-20T15:00:00Z: release-ready → released by dana: Moved to released for the test

Source: change.yaml history

## Artifacts and their sha-256

| File | Bytes | sha-256 |
| --- | --- | --- |
| brief.md | 1144 | `69ea62e1978a4f47007597a3ba7b9c7d4fd5cf6eb4b5127ed780b8be96a7c5ec` |
| change.yaml | 2565 | `1d762ab0f4c6cb21d3168696a413f0ddac2bbd34480b5259abde82a687a7f08b` |
| data.md | 756 | `2c3388182867fc52f1d0e55c1626629e530ed6332321f0a0f4a66c42c835676f` |
| design.md | 888 | `ed777b1343f8d9dab04a26df20d161c12c2a0732a639a7a1df00239950ebd927` |
| interfaces.md | 1170 | `5de25fc72cc83c149c157c5c626da5606a81f17e2d4ca39f1269300e8ebb35f9` |
| mappings.md | 970 | `0143f7d7a7dc28bb5a21c3bb89603ffd2f8c4eaf80d1cc0f78a048f4a241f307` |
| proposal.md | 1101 | `6b80c3e85debdd27587d994112b49effb647464eea68a50d8332d825b4400c00` |
| review/design/1/f-audit-no-pattern.yaml | 670 | `fb914797ace1a5fe24872e372a5b0f86490c71b8734b77ef38d914a4ab965c82` |
| review/design/1/meta/round.yaml | 483 | `d1af196ce7e93a7e5f0c1cba3e13c8bec1130ff49de0173ffbe8944d70b6ae35` |
| review/drift/1/meta/round.yaml | 167 | `3e56194694db6b9cc06db78448470d05d66858ee87b3819ac6b0a42afdfb8108` |
| review/plan/1/f-no-firewall-request.yaml | 588 | `1e64a0aab4e92fb058f24f1915edb1607d3da96b39a83f7b9d3af9dc28316a50` |
| review/plan/1/meta/round.yaml | 275 | `1a158f576bfd4e791c1cf44170f2ecb965e11dbf856742bd279b33dc4210b10d` |
| snow.md | 347 | `2ee71826ff1b797af0bbe9228c29c13811e7f1667473b6163ee8fddf3c68277c` |
| specs/transfer-limits/spec.md | 829 | `345b3d801f011acab5512f844aa7559b1fd62ebf701b26dbac2f4aa7b8e2e689` |
| steps/sd-gateway-route-gw-northwind-v2.yaml | 496 | `65ae77ee4cbfabfba9e3b76f0b6d52d44fa57a6aa202fd5e7b852bf1b297a9b0` |
| stories/s1-refuse-over-limit.md | 534 | `5d001e0d8cf8e8a1bac288c6634d2cc2ada868f7124c1e1398f4c34938439110` |
| stories/s2-show-remaining.md | 330 | `f49b0ad06dc3a5660fb9bdbff96ca08e05a81d72ab6904a3cc174e036889efc2` |
| stories/s3-audit-refusals.md | 492 | `ac3832a2bf303666745655271b20a86d8a15d9b88a48c960e752b1f86d6f1a45` |
| stories/s4-velocity-check.md | 422 | `8dbaa99783e1f8367268b591d163eddde3d3d75fcfc91709cee5b9a5ae472d90` |
| stories.md | 442 | `2ea1b12929e3e813a6aca26c4bfea8b824aa2fa112ec3e38d3d4c4b5404a4c41` |
| sync.yaml | 308 | `b51a29558d8b471b4cd9990e2536783f442bc196cb52d5011bf897ebce9e3512` |
| tasks/1.3/runs/run-20261020-0001.yaml | 368 | `622771648b34a75d72ca344fc3c15964366902b0f486a24d421443f873700a71` |
| tasks.md | 456 | `235218c3172feafafd2705a2483c7ff3a8b8e95704adb062c034f5e5cc1e118c` |
| ux.md | 288 | `9486087aa96ed24253e0a9e7c4508e09ced88277a608e45c2c7eebcc040532de` |

_No hand-off recorded artifact hashes, so there is nothing to compare against._

## Critic rounds and findings

### design gate, round 1 (2026-10-20T09:00:00Z)

1 finding, 0 open. Source: review/design/1/

| Finding | Severity | Rule | State | Summary | Resolution | Source |
| --- | --- | --- | --- | --- | --- | --- |
| f-audit-no-pattern | blocking | interface-has-pattern | waived | POST /audit/events has no integration pattern. | waive by avery 2026-10-20: Audit calls stay direct until the audit gateway exists next quarter. | review/design/1/f-audit-no-pattern.yaml |

### plan gate, round 1 (2026-10-20T12:00:00Z)

1 finding, 1 open. Source: review/plan/1/

| Finding | Severity | Rule | State | Summary | Resolution | Source |
| --- | --- | --- | --- | --- | --- | --- |
| f-no-firewall-request | blocking | snow-drafts-present | open | The gateway proxy request also needs a network firewall rule request, and none is drafted. |  | review/plan/1/f-no-firewall-request.yaml |

## Waivers

- POST /audit/events has no integration pattern. Rule interface-has-pattern (org), waived by avery on 2026-10-20: Audit calls stay direct until the audit gateway exists next quarter. (review/design/1/f-audit-no-pattern.yaml)

## Approvals (hand-off PRs)

- define: PR #1 https://git.example.com/forge/forge-metarepo/pull/1, merged, raised by pat 2026-10-19; approved by pat as product-owner (2026-10-19T11:00:00Z).
- design: PR #2 https://git.example.com/forge/forge-metarepo/pull/2, merged, raised by ari 2026-10-19; approved by avery as architect (2026-10-19T14:00:00Z).

Source: change.yaml handoffs

## Test trace

3 requirements, 4 stories, 6 trace rows of which 0 have a test; 0 test files found in the repos.

Gaps:

- endpoint-without-test: 5
- requirement-without-story: 1
- story-without-test: 4

Source: computed as `atticus trace` does, from specs/, stories/, tests/ and Run with AI records

## Service requests and manual steps

- Gateway proxy deployment: gw-northwind-v2: filed as SR-1042 on 2026-10-20 (snow.md:3)

| Step | System | What | State | Done by | Source |
| --- | --- | --- | --- | --- | --- |
| sd-gateway-route-gw-northwind-v2 | service-desk | File the gateway proxy deployment request for gw-northwind-v2 | done | bao 2026-10-20T11:00:00Z | steps/sd-gateway-route-gw-northwind-v2.yaml |

## Drift

Newest round 1 (2026-10-21T08:00:00Z): no open drift. Source: review/drift/1/

## AI run summaries

- run-20261020-0001: task-runner on mock, validated, 2026-10-20T13:00:00Z, 1200 in / 340 out tokens; context sha-256 `1ddb00eac2aa…` (tasks/1.3/runs/run-20261020-0001.yaml)
- design round 1, architecture lens: architecture-critic, ran; prompt sha-256 `6e19e04abee1…` (review/design/1/meta/round.yaml)

## Outcomes

- No transfer over a limit is accepted (brief.md:31): not measured yet
- Support reversals for drained accounts drop to zero (brief.md:31): not measured yet
