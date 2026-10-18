# The catalog query language

`atticus query "<query>"` finds records in the catalog. The same language will drive the search box in the UI. A query is a list of terms separated by spaces, and a record must match every term.

| Term                    | Matches records where                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `field:value`           | the field equals the value (for a list, any item does). Case doesn't matter. |
| `field:a,b`             | the field is `a` or `b`                                                      |
| `field:pre*`            | the field starts with `pre`; `*` stands for any run of characters            |
| `a.b:value`             | a nested field, e.g. `pattern.code:S.GW.SOR`                                 |
| `has:field`             | the field is set (a list: not empty)                                         |
| `missing:field`         | the field isn't set                                                          |
| `refs:id`               | the record refers to `id` in any reference field                             |
| `refby:id`              | the record `id` refers to this one                                           |
| `word` or `"two words"` | the id or name contains the text                                             |
| `-term`                 | any term, negated                                                            |

Two fields are special. `kind` matches record kinds by name in any case (`kind:interface`). `system` matches the system a record belongs to: a component's system, the caller's system for an interface, the owning component's system for a table, its table's system for a column.

Field names are the C1 field names (see `schema/catalog/*.json` from `atticus schema export`).

## Examples

| Question                                  | Query                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| Gateway calls with no integration pattern | `kind:interface via:gateway missing:pattern`             |
| Calls only seen at one end                | `kind:interface confidence:inferred`                     |
| Who reads the entry table?                | `refby:ledger-db.entry kind:component`                   |
| Everything that refers to ledger-api      | `refs:ledger-api`                                        |
| Columns holding personal data in Ledger   | `kind:column system:ledger classification:personal*`     |
| Loose ends held by portal-bff             | `kind:unresolved owner:portal-bff`                       |
| Settings of the BFF except timeouts       | `kind:setting component:portal-bff -settingKind:timeout` |

Add `--json` for full records and `--limit n` for more than 100 rows. `atticus impact <id>` answers the follow-on question, "what does a change to this reach?".
