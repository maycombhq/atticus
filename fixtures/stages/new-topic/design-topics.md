## Topics this change adds

| Topic | Publisher | Format | Key | Fields | Settings | Listeners |
| --- | --- | --- | --- | --- | --- | --- |
| forge.orders.shipped | forge-orders.ship-order (forge-orders), on forge-hub | json, in schemas/forge.orders.shipped.json | orderId | orderId: string (internal), shippedAt: timestamp | partitions: 6, retention: 7d, deadLetter: forge.orders.shipped.dlq | forge-ledger.on-order-shipped (forge-ledger, read) |
