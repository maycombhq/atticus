# Checkout: solution spec

Owner: Checkout team

Checkout takes an order from the Shop Graph and charges it through Tidewater.
The Orders Service calls the Payments Service through the gateway.
Payments Service calls Tidewater Payments directly.
The warehouse pipeline loads orders through the Orders API.

Service level: 99.95% monthly availability. Peak load: 120 requests per second.
