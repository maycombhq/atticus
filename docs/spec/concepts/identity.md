# Identity rules

The same fact found in several places must become one record. Identity rules decide which
records are the same; ids are derived from identity so they are stable across scans.

## Ids

An id is a lowercase slug of letters, digits, `.`, `_` and `-`, at most 120 characters, safe as
a file name on every operating system. Ids never change because a scan ran again; they change
only when the identity of the fact changes.

## Conventions by kind

| Kind              | Id                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System, Component | the name from the profile or repo manifest                                                                                                                                    |
| Endpoint (REST)   | `<component>.<method>-<last fixed path segment, singular>`, with a short hash of the path when two would collide                                                              |
| Endpoint (other)  | `<component>.<type prefix>.<name>`, for example `<component>.graphql.query.account`, `<component>.grpc.<package.service.method>`, `<component>.function.<function>.<trigger>` |
| Topic             | `topic.<topic>`                                                                                                                                                               |
| Interface         | `if-` and a hash of caller, callee, method and normalized path                                                                                                                |
| Table, Column     | `<store>.<table>`, `<table>.<column>`                                                                                                                                         |
| Setting           | `<component>[.<env>].<key>`                                                                                                                                                   |
| Deployment        | `<component>.<env>`                                                                                                                                                           |
| Unresolved        | `<owner>.<loose-end kind>.<hash of what it says and where>`                                                                                                                   |

## Normalized paths

HTTP paths are normalized before they are compared: path parameters in any style (`{id}`,
`:id`, `<id>`, `${id}`) become `{}`, query strings and fragments are dropped, and repeated or
trailing slashes are removed. A caller's `/accounts/42` template and a server's
`/accounts/{accountId}` route meet as `/accounts/{}`.

## Merging

Records with the same identity merge: their evidence is unioned, the stronger confidence is kept,
and fields one record leaves empty are filled from the other. REST endpoints merge by component,
method and normalized path; topics by name; endpoints of the other types (GraphQL, gRPC,
WebSocket, server-sent events, webhooks, functions, transactions) by id, because two services can
serve the same field or path name.
