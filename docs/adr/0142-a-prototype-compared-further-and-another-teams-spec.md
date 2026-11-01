# 0142. A prototype compared further, and another team's spec as their system

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0124 (facts the assistant writes; addenda C-join, F3, O1), 0125 (a Schema field says whether it is required), 0130 (a vendor's operations), 0133 (a prototype compared with the estate)

## Context

ADR 0133 compared a prototype's calls with the estate by fields, scopes and auth. It left out enums, error responses and headers, and it said a **new** call (nothing in the estate serves it) is the architecture stage's to place, without giving that stage the list.

ADR 0130 read a vendor's spec and matched the external gateway's forwarding calls to its operations. F3 made every profile system no estate repo belongs to count as outside, and O1 lets a hosts question add such a system with the host as its alias. Another team's API (boundary `internal`) is such a system. Two things still assumed a vendor:

- the prototype comparison read only specs of systems with `boundary: vendor`;
- the match read only a gateway's forwarding calls, but an estate service calls another team's API itself.

## Decision

### 1. Enums, headers and errors, from what the facts already say

The facts file is unchanged. Each comes from a field the facts already carry:

| What        | Where it is read from                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enum values | a field fact's `type` when it lists them: a union of quoted literals (`"captured" \| "failed"`), a named list (`ChargeStatus(CAPTURED\|FAILED)`, `enum(EUR, USD)`), the values alone (`EUR\|USD`); a spec's `enum` |
| Headers     | a `request` or `response` field named as a header (`X-…`, a header every client knows, or hyphenated words each starting upper case: `Idempotency-Key`); a spec's `in: header` parameter                           |
| Errors      | the HTTP statuses (4xx, 5xx) a flow fact's `errors` name (`when`, `then`), for the flows an entry starts and, for a prototype's call, the flows with a step that makes it; a spec's 4xx and 5xx responses          |

Chosen over new fields (an `enum` on a field fact, a `header` side, a `status` on an error path) because each would be a facts contract change with a migration, while these readings work on facts already written. The cost: a Java enum the facts name only by its class (`ChargeStatus`) lists no values, and is unknown, not compared.

`comparePrototype` (core `facts-join-prototype.ts`) adds five differences, each cited on both sides:

- `field-enum`: a value the prototype sends that the estate doesn't take; one it expects that the estate never returns; one the estate may return that the prototype doesn't list. Values match whatever their case.
- `header-missing`: a header the prototype sends or reads that the estate doesn't. Headers are compared apart from body fields, so a header is never a missing body field.
- `header-required`: a header the estate requires that the prototype doesn't send.
- `error-missing`: an error the prototype expects that the estate never answers.
- `error-unhandled`: an error the estate answers that the prototype doesn't handle.

ADR 0125's rule holds for each: a side that lists no values, no headers or no errors is unknown, not different. `header-required` is said only where the prototype names some request headers.

Intake's `readVendorSpec` gives an operation's `errors` (each 4xx or 5xx status, citing its line), so a vendor's or a team's operation is compared the same way.

### 2. The new calls, for the architecture stage

The attached comparison (`inputs/prototype-<repo>.md`) ends with a section, **New calls, for the architecture stage** (`prototypeArchitectureSection`, core): each new call with the fields it sends and reads, cited. The architecture stage reads it back from every attached comparison (`readPrototypeArchitecture`, core; `prototypeNewCallsSource`, planner), each line cited by the attached file's line, and its drafter is told to place every call: the entry that will serve it, in a new or changed target flow, or why it isn't built in this change (`PROTOTYPE_NEW_RULE`).

The footprint still gains nothing from a new call: where it goes is that stage's to decide.

### 3. Another team's spec as their system (O2)

- **Which specs.** The prototype comparison reads the spec of every outside system (`outsideProfileSystems`, scanner: every vendor, and every system no estate repo belongs to), not only a vendor's. `intake impact` already took any linked system.
- **Hosts.** A system's aliases that read as hosts (`hostAliases`: O1 writes one) are its hosts too, beside its spec's servers.
- **Direct calls.** `JoinVendor` gains `boundary`. For `internal`, `joinVendorOperations` also matches a service's own call (not a gateway's forwarding call) by the same rules (an answer, its `to`, its host), marked `direct`, with `route` the entry it is made under. A vendor's direct calls are still left alone, so ADR 0130's results are unchanged.
- **The impact.** `vendorImpact` makes a direct match its own caller: the field it sends or reads, the entry it is made under, and who calls that, up the chain. Its Interface is the one the projection gives a call to an outside system. The command prints it as "called directly by".
- **The prototype.** A call only another team publishes is in the **vendor** group, with `vendor.boundary: internal`, and said as theirs: the change calls it as they publish it, and the repos that call it already are named. Those repos aren't added to the footprint as changing; the team's system is.

## Contract notes

- **The facts file:** unchanged.
- **C1, C2, C3, C5, C6:** unchanged.
- **C4:** 2.33.0, additive: the five difference kinds, a difference's `value` and `status`, and `vendor.boundary` on a prototype's call.
- **`facts-join-vendor.ts`:** `JoinVendor.boundary` and `VendorCallMatch.direct`, both optional. Without `boundary`, the match is as ADR 0130 has it.

## Consequences

- A prototype's comparison says where enums, headers and errors part, from facts already written.
- The architecture draft gets the prototype's new calls as a list to place.
- Another team's published API is read, matched and checked as a vendor's is, including the calls services make to it directly.

**Not done here:**

- The reading rules (`FACT_RULES`) don't yet ask the assistant to list an enum's values in a field's `type`, to record headers as fields, or to name an error path's status. Facts that do are compared; facts that don't are unknown.
- A vendor's response headers aren't read from its spec, and `oneOf` and `anyOf` bodies aren't compared.
- The vendor-diff (ADR 0130) doesn't compare error responses between two versions.
- The UI's group label stays "Only a vendor"; another team's call is marked "Another team" on its line.
- Other places that read `boundary: vendor` alone (a target question's options, the footprint's outside systems, the risk and release checks) aren't changed here.
