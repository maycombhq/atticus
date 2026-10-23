# Return when an order was placed

## Change

The shop's checkout page wants to show when an order was placed. The response to a new order
returns the saved order without its creation time; it should return createdAt as well.

## Where

Placing an order (POST /orders in forge-orders).

## Done when

A new order's 201 response carries createdAt, the time the order was saved.
