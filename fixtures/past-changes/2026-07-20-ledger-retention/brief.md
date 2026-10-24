# Keep ledger entries for seven years

## Change

Ledger entries are purged after five years; the retention rule now says seven. The nightly
purge job keeps entries younger than seven years.

## Where

The ledger purge job in forge-ledger and the ledger-db entries table.

## Done when

An entry six years old survives the nightly purge.
