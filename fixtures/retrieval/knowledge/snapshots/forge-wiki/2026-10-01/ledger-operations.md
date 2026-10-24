# Ledger operations

How the ledger team runs the ledger day to day. Owned by team-ledger.

## Words we use

The daily limit is the most a customer may transfer out of one account in a calendar day.

The account holder is the person or business an account belongs to.

## Month end

### Reconciliation

Reconciliation compares every entry the ledger booked during the month with the statements the clearing banks and Northwind Pay send back. It runs on the first working day after the month closes and usually takes most of the morning. The run is started by the on-duty ledger engineer from the operations console, never by a scheduler, because the clearing files arrive at slightly different times each month and somebody has to check that all of them are present before the comparison starts.

The comparison works account by account. For each account the run totals the debits and credits the ledger holds for the month, totals the same for the clearing statement, and compares the two. An account whose totals agree is marked reconciled and needs nothing more. An account whose totals disagree is opened entry by entry: the run pairs each ledger entry with a statement line by amount, date and reference, and lists what it could not pair. Most months fewer than twenty accounts need this second pass.

Pairing tolerates a few known differences. A clearing bank may report a transfer a day later than the ledger posted it, so a date that differs by one working day still pairs. Northwind Pay rounds currency conversions to the cent before the ledger does, so an amount that differs by one cent on a converted payment still pairs, and the difference is booked to the rounding account. References are compared without spaces or leading zeros, because two of the clearing banks strip them.

Entries that still do not pair are reviewed by a person the same day. The reviewer looks at the transfer's history in the operations console, the customer's recent contacts and the clearing file itself. Usually the cause is a transfer that was reversed by the clearing bank after the statement was cut, or a duplicate statement line. The reviewer records what they found against the entry, and the run is started again for that account.

Unmatched entries older than five days are moved to the suspense account and the reconciliation desk is paged, so that money is never left sitting against a customer's account without an explanation. The desk then has two working days to clear the suspense account before finance is told.

At the end of the run the ledger engineer exports the reconciliation report, attaches it to the month-end ticket and tells finance it is ready. The report lists every account that needed a second pass, what was paired by tolerance and what went to suspense.

### Closing the books

Once reconciliation is signed off, finance closes the month in the general ledger. The ledger refuses back-dated entries into a closed month; a correction goes into the open month with a reference to the original entry.

## Northwind Pay

### Retries

A payment to Northwind Pay that times out is retried three times, two, four and eight seconds apart, with the same idempotency key, so a retry never pays twice. After the third failure the transfer is marked failed and the customer is told.

### Cut-over windows

Northwind Pay takes its API down for maintenance on the first Sunday of each month between 01:00 and 03:00. Payments during the window are queued and sent when it ends.
