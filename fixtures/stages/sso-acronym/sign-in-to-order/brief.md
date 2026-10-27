# Sign in through single sign-on to place an order

## Change

Placing an order in forge-orders takes any caller today. It should take the order only from a
shopper signed in through single sign-on.

## Where

Placing an order (POST /orders in forge-orders).

## Done when

POST /orders refuses a shopper who hasn't signed in through single sign-on.
