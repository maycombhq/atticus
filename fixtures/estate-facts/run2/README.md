# The second stories bench run's places (B-run2-fixes)

Invented Forge facts for `packages/planner/test/run2-fixes.test.ts` (ADR 0124 addendum
B-run2-fixes), added to the C-join estate in `../facts/` (and `../places/`) without changing it:

- `forge-customers.jsonl`: a validator that cites one field of POST /api/customers' request in
  passing (`EmailDomainValidator.java`), and an optional `phone` field in the request DTO.
- `forge-web.jsonl`: the new-customer screen's form fields also cited in an edit form
  (`edit-customer.component.ts`), so the screen's field schema is shared by two screens' files;
  and the customer page's shown email also cited in a list (`customer-list.component.html`).
- `forge-ledger.jsonl`: the accounts table's columns declared in its schema file, in the entity
  mapped to it (`Account.java`) and in a base class that also declares a column of another table
  (`BaseEntity.java`, with a `transfers` table read by the ledger), and in a superclass that
  declares one of its columns only (`Audited.java`).

With `schema.sql` in place of the Flyway migration (the test's `ledgerSchemaFile` variant), the
ledger has no migrations, so the files that declare the accounts table's columns change in place.
