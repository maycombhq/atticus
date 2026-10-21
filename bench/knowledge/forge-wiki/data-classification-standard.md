---
title: Data classification standard
space: SECURITY
tags: [security-standard]
owner: Data Protection Office
last-updated: 2026-05-19
---

# Data classification standard

## Levels

Forge data has four levels: Public, Internal, Confidential and Restricted. Data with no label is treated as Confidential.

## Personal data fields

| Field                    | Level        |
| ------------------------ | ------------ |
| Customer name            | Confidential |
| Email address            | Confidential |
| Postal address           | Confidential |
| Date of birth            | Confidential |
| Account number or IBAN   | Confidential |
| National identity number | Restricted   |
| Card number (PAN)        | Restricted   |
| Identity document image  | Restricted   |

## Rules

- A new field, column or event attribute that holds personal data needs a data classification review before it reaches production.
- Restricted data is stored only in the ledger database with column encryption or in the card vault.
- Restricted data never leaves Forge except to a vendor whose onboarding approved that field.
