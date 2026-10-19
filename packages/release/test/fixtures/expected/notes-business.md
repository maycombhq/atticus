# Release notes: Add a daily transfer limit

For business readers. Change `add-transfer-limit`, generated 2026-10-21 from the change folder; every line says where it came from.

## Why

Portal customers can send any amount in one day. Two accounts were drained last month before anyone noticed, and support had to reverse the transfers by hand.

Source: brief.md:3

## What changes

- Ledger keeps a daily transfer limit per account and refuses transfers that would exceed it.
- Ledger asks Northwind Pay's velocity check about unusual transfers before applying the limit.
- Support changes to a limit are recorded, and refused transfers are sent to Audit.
- The Portal shows how much of today's limit is left.

Source: proposal.md:7

## Who it affects

- Ledger (modified): checks and stores the limit
- Portal (modified): shows the remaining limit and audits refusals
- Audit (modified): receives limit-refused events
- Northwind Pay (modified): answers velocity checks

Source: proposal.md:21

## Not included

- Limits per payee, and customers changing their own limit

Source: brief.md:14

## Known limitations

_No critic round has run yet, so no finding is waived._

## Still open

- What is the default limit for existing accounts? (product owner)

Source: brief.md:33
