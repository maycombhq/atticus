# Sign in with SSO to place an order

## Change

Placing an order in forge-orders takes any caller today. It should take only a caller signed in
with Forge SSO, and read who the caller is from the SSO token.

## Where

Placing an order (POST /orders in forge-orders).

## Done when

POST /orders refuses a caller without a valid Forge SSO token, and takes the caller's sub and
email from the token.
