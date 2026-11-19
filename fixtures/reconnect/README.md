# reconnect: calls joined to the wrong box, seven ways

An invented Forge estate for "it's connected to the wrong box" (beta.30, the owner's field report:
a call is joined to the wrong repo, and connecting its repo to the right one found nothing to pair).

`forge-orders` (A) makes seven calls. Each is joined to `forge-billing` (C) or to an outside system
by a different way, and each really goes to `forge-ledger` (B), which serves the same seven APIs:

| Way | Call                              | Why it goes to the wrong box                                                    |
| --- | --------------------------------- | ------------------------------------------------------------------------------- |
| a   | `GET /holds/{id}`                 | its host, `billing.forge.example`, is forge-billing's in the manifest           |
| b   | `POST /holds/{id}/release`        | the assistant's fact names forge-billing (`to`)                                 |
| c   | `GET /fees/{id}`                  | its host, `fees.forge.internal`, is asked about; the tests answer forge-billing |
| d   | `GET /entries/{id}`               | a deploy token for a host; the tests pair it with forge-billing as another user |
| e   | `POST /entries`                   | the same, paired with forge-billing by the person themselves                    |
| f   | `GET /billing/v1/statements/{id}` | it goes to the gateway `forge_billing_1-0`, whose route forwards to forge-billing |
| g   | `POST /charges`                   | the fact names the outside system Northwind Pay                                 |

`repos/` holds each repo's files as its facts cite them, `facts/` the facts as an assistant wrote
them, `org-pack/` the profile and the manifest. Used by `packages/cli/test/reconnect-estate.ts` and
the journey `packages/journeys/tests/37-connected-to-the-wrong-box.spec.ts`. Everything is invented
(CLAUDE.md rule 3).
