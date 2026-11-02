# The contract check on every link

Atticus joins each call to the entry that serves it. The contract check (ADR 0164) then asks whether the two sides agree on the payload: for every REST call, every hop through a gateway, every topic's publisher and listeners, and every call to an outside system whose spec you took in.

```
atticus join contracts          # every link's mismatches, then the unconfirmed
atticus join contracts --json   # the same, for a script
```

In the app it is **Map › Mismatches** (linked from the Trust tab's count). A link with a finding shows a warning on the estate canvas, and **Why is this linked?** lists the findings under each call. It reads files only.

## What it compares

| Finding                           | Means                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Read, never sent                  | A caller reads a response field, or a listener a message field, the other side never gives                                    |
| Sent, not taken                   | A request or message field the other side doesn't take; or a field a service returns that its published spec doesn't document |
| Required, not sent                | The receiving side requires a field nothing sends                                                                             |
| Required on one side only         | A spec says always there, the service may leave it out (or the other way for a request)                                       |
| Types differ                      | A string on one side, a number on the other                                                                                   |
| Field number reused               | Two copies of a `.proto` give one number to different fields: every reader of one breaks on the other                         |
| Error not listed / never answered | A status one side answers that the other doesn't list or handle                                                               |

A side that says nothing about a payload is unknown, never different.

## Where the payloads come from

- **The code**: the fields your assistant records when it reads a repo (`/atticus-map`): a request or response body's fields with their types and whether they are required, a message's fields, and the message type a publish or listener names.
- **A repo's own specs**: `atticus verify <repo> --write` reads the checkout for OpenAPI, `.proto`, Avro (`.avsc`), JSON Schema and AsyncAPI files, in any folder, as they are at the commit the facts were read at (files committed there; an uncommitted edit or a file never added isn't read), and keeps them in `facts/<repo>.specs.yaml`. An OpenAPI operation the repo's own entries serve is its published contract (a gateway proxy's spec); another is the repo's copy of an API it calls.
- **Another team's or a vendor's**: `atticus intake add <file>` takes an OpenAPI spec, a `.proto` or an `.avsc`. The newest is compared, and the system's Outside systems page marks what a new version brought.

## Wrapping

Nothing is configured: the check follows the mappings the code shows, each a cited field fact.

- An **envelope** every answer shares (`Response<T>` with `data`): the fields inside it are `mappedTo` the envelope's field, `transform: envelope ...`.
- A **mapper** (MapStruct, AutoMapper, a converter) that renames a field: `mappedTo` the field it becomes.
- A **gateway policy** that reshapes the payload (AssignMessage, JavaScript, XSL): the route's field `mappedTo` the forwarding call's.

A field a policy or converter writes that nobody traced is **unconfirmed**, never a mismatch, and so is a field the other side lacks while such an untraced field there matched nothing: the converter may have renamed it (`acctBal`, written by a serializer, read as `balance`). Repos read before this check need reading again for their DTOs, mappers and policies: `atticus map --all --stale`.
