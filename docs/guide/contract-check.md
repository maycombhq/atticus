# The contract check on every link

Atticus joins each call to the entry that serves it. The contract check (ADR 0164) then asks whether the two sides agree on the payload: for every REST call, every hop through a gateway, every topic's publisher and listeners, and every call to an outside system whose spec you took in.

```
atticus join contracts          # every link's mismatches, then the unconfirmed
atticus join contracts --json   # the same, for a script
```

In the app it is **Map › Mismatches** (linked from the Trust tab's count). A link with a finding shows a warning on the estate canvas, and **Why is this linked?** lists the findings under each call. The canvas draws its picture first and asks for the check after, saying "Joining the estate…" while it runs, so a first check on a big estate never holds the picture back. The check and the estate join it rests on are kept in `.atticus/cache/` (never committed) under a stamp of the files they read, so a restart of `atticus ui` or another page reuses them until a file of `facts/`, the inputs, the org pack, the questions or the curated catalog changes. It reads files only.

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

## Where a field sits

Your assistant records each class's fields by their own names, in the class's own file: `depot`, not `receipt.stamps[].depot`. The check works out the path itself, from the facts on file: a field whose type names a class (`List<Stamp> stamps`) holds that class's fields, `[]` for a list, through as many levels as the body has. A class two fields hold is at both places. Classes nothing holds that hold others (a body and an error body, a base class and the class that extends it) are each a root.

**How fields are matched.** The same path on both sides, first. A field whose place is sure (its path was built from a root class that the other side bears out, or it is a spec's) matches only there, or a field whose parent was recorded under another name at the same depth. A field whose place isn't sure (a class recorded without what holds it, or a flat class) may match a deeper field with the same ending, or the one field of that name.

A difference is a **mismatch** whenever it doesn't depend on where the field sits: a field the other side has under no name at all, or a type compared with the only field of that name. One fact that differs the same way at several places (a shared `Money` class) is one finding that lists the places. A difference is **unconfirmed**, and its line says why, only where the facts can't tell:

| It says                                                                 | Means                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `X is not reached from the response's fields`                           | No recorded field holds class X, and the other side has that name in more than one place               |
| `X is reached only from classes it holds itself`                        | The classes hold each other and nothing else holds them                                                |
| `N fields of … are named status, and nothing on record says which`      | The other side has several fields of that name and nothing says which this one is                      |
| `a field of that name is only at …`                                     | The field's place is known and the other side has that name only somewhere else                        |
| `matched under another parent name (…)`                                 | The pair differs only in a parent's name, so a type that differs on it isn't certain                   |
| `… lists nothing inside details`                                        | The other side names that part and lists no field inside it: unknown, not different                    |
| `what the items of tags are isn't recorded for …`                       | The other side has that list, and its reader keeps no item type                                        |
| `…'s request fields on record don't start at the payload's root`        | Only fields from inside the body were recorded, so a required field around them can't be called unsent |
| `… has no fields on record inside payload`                              | The call names that part and nothing inside it was read                                                |
| `X is held in a map` / `held inside Page<…>`                            | Its keys are data, or the wrapper's own fields weren't read: no path can be named                      |
| `a mapping puts it inside data and its class X is held by …`            | An envelope mapping and the field's type name different parents                                        |
| `its name a.b doesn't start where its class X sits`                     | A dotted name the reader wrote that doesn't fit the path built for its class                           |
| `X is at more places than the 64 compared` / `more than 10 levels deep` | Further than the check follows                                                                         |
| `X is held in too many ways to follow`                                  | The classes are too tangled to place                                                                   |

`atticus verify <repo>` lists the classes it can't place (`fieldsUnplaced` in `facts/<repo>.verify.yaml`), as a note: the repo still verifies. To put one right, have your assistant add the field that holds the class (with its `type` as declared) to the repo's facts and verify again; a new read does it by itself, since `/atticus-map` now asks for those fields. You don't need to do either for the false mismatches to go: the check reads the facts you already have, so **Apply** is enough.

## Wrapping

Nothing is configured: the check follows the mappings the code shows, each a cited field fact.

- An **envelope** every answer shares (`Response<T>` with `data`): the fields inside it are `mappedTo` the envelope's field, `transform: envelope ...`.
- A **mapper** (MapStruct, AutoMapper, a converter) that renames a field: `mappedTo` the field it becomes.
- A **gateway policy** that reshapes the payload (AssignMessage, JavaScript, XSL): the route's field `mappedTo` the forwarding call's.

A field a policy or converter writes that nobody traced is **unconfirmed**, never a mismatch, and so is a field the other side lacks while such an untraced field there matched nothing: the converter may have renamed it (`acctBal`, written by a serializer, read as `balance`). Repos read before this check need reading again for their DTOs, mappers and policies: `atticus map --all --stale` tops them up, reading only those files for the new rules (ADR 0167).
