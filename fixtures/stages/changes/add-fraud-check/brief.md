# Screen orders for fraud

## Problem

Stolen cards are used to place orders, and the stock is shipped before anyone notices.

## Outcome

Before stock is reserved, each order is screened by Northwind Pay's fraud screen. An order the
screen rejects is refused with a clear message, and nothing is reserved.

## Scope

In scope: screening every new order, refusing rejected ones, and keeping the screen's verdict
with the order.
Out of scope: screening orders already placed.
