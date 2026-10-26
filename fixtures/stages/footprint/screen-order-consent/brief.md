# Screen consenting customers' orders for fraud

## Problem

Stolen cards are used to place orders, and support agents place orders for customers without
being asked to.

## Outcome

Every order of a customer who consented to fraud screening is screened by Northwind Pay before
stock is reserved, and only the customer's own token may place an order.

## Scope

In scope: the screen, the consent check and who may place an order.
Out of scope: orders already placed.
