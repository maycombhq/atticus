---
title: Vendor onboarding
space: CHANGE
tags: [change-process, integration-patterns]
owner: Vendor Management
last-updated: 2026-06-30
---

# Vendor onboarding

## When this applies

Any change that makes a Forge system exchange data with a vendor host that is not already in the approved vendor register.

A new endpoint on a vendor that is already registered does not need onboarding again, but a new host name does.

## Steps

1. Vendor Management adds the vendor to the approved vendor register.
2. Security Architecture runs the third-party risk assessment.
3. If the vendor will receive personal data, the Data Protection Office runs a data classification review.
4. The Network team opens the firewall for the vendor host (Network firewall rule request).
5. The Gateway team configures the route on the partner gateway.

## How to request it

Raise the Vendor onboarding item in the service desk. It is handled by Vendor Management.

The request needs: the vendor's legal name, every vendor host and port, the data exchanged and its classification, the business owner, and the contract reference.

## Lead time

Allow 30 working days from the vendor register entry to the first production call.

## Approved vendor register (extract)

| Vendor                  | Service           | Hosts                   |
| ----------------------- | ----------------- | ----------------------- |
| Northwind Pay           | Outbound payments | api.northwind.example   |
| Tidewater Card Services | Card issuing      | cards.tidewater.example |
| Bluefin KYC             | Identity checks   | verify.bluefin.example  |
