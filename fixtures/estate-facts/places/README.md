# The places a change goes into (B-places)

Invented Forge facts for `packages/planner/test/story-places.test.ts` (ADR 0124 addendum
B-places), added to the C-join estate in `../facts/` without changing it:

- `forge-web.screens.jsonl`: the web front end's form fields (the form group in
  `new-customer.component.ts`) and the fields its customer page shows (the card it renders,
  `customer-card.component.html`), as field facts with `side: screen` owned by each screen's
  entry fact. The model type the calls send and receive
  (`customer.ts`) is already in `../facts/forge-web.jsonl`, as the calls' request and response
  fields.

The test adds a customer's birth date across the estate: the form and the model in forge-web,
the API's request and a new Flyway migration in forge-customers (whose `V1__customers.sql` the
column facts cite, so the catalog knows its migrations), and a ledger variant whose columns are
cited in `schema.sql` (no migrations, so the schema file is changed in place).
