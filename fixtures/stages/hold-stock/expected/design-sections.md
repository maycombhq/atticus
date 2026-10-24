## Breaking changes

Each change below breaks who uses it today; the map names them.

- POST /stock/reservations (forge-stock.reserve-stock): no longer returns reservationId. Used by forge-orders.
- forge-orders-db.orders (change 2 to forge-orders.place-order): changes the type of quantity from INT to BIGINT. Used by forge-reports.

## Deploy order

1. Migration V4__add_hold_id.sql, in forge-orders. The orders table gains hold_id and quantity widens before any code writes them.
2. forge-stock. forge-orders calls the changed reservation, so forge-stock goes first.
3. forge-orders. It writes the hold's id once the column is there and the stock service holds.
