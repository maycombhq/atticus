# Loose ends

A scan reads one repository at a time, so it often sees only one end of an interaction: a call
whose server is in another repository, a message published to a topic consumed elsewhere, a
query against a table another component owns. Such an end is recorded as a loose end: an
`Unresolved` record with an `owner` (the component holding it), an `unresolvedKind` and a `raw`
string in a fixed grammar. Merging all repositories' records resolves loose ends into interfaces,
readers and writers; whatever can't be resolved stays as a loose end with its owner, so nothing
is silently dropped.

## Grammar

| `unresolvedKind`   | `raw`                                           | Resolves to                                                                                                                       |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `http-call`        | `METHOD URL`                                    | an Interface to the component the host names (or, through a gateway route whose base path matches, to the route's target)         |
| `event-publish`    | `topic`                                         | Interfaces from the publisher to every subscriber of the topic                                                                    |
| `event-subscribe`  | `topic`                                         | (the other side of `event-publish`)                                                                                               |
| `db-access`        | `read table` or `write table`                   | the owner added to the table's readers or writers                                                                                 |
| `db-connection`    | `URL`                                           | which data store the owner connects to                                                                                            |
| `graphql-call`     | `QUERY Query.field` (or MUTATION, SUBSCRIPTION) | an Interface to the one component serving a `graphql` endpoint with that operation and field name; subscriptions are asynchronous |
| `grpc-call`        | `package.Service` or `package.Service/Method`   | an Interface to the one component serving that service (by full name, or by short name when no package is given)                  |
| `webhook-callback` | `METHOD /path REGISTRAR`                        | an Interface from the system behind the registrar (a URL or a name) to the owner, `via: webhook`, at the owner's webhook endpoint |

When more than one component could be the other end, a loose end resolves only if exactly one of
them is in the caller's own system; otherwise it stays unresolved rather than guessing.

## Confidence of what they become

An interface made from a loose end is verified when the other end is seen in code or in a
published specification, and inferred otherwise.

## Service mesh

A direct synchronous call between two components that both run in a service mesh goes through
their sidecars. A component's mesh membership is a Setting with key `mesh` (its value names the
mesh); merging marks such calls `via: mesh` instead of `direct`. Calls through a gateway keep
`via: gateway`.
