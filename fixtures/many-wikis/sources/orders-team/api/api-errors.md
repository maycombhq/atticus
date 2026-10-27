---
title: Error responses in forge-orders
owner: Orders team
updated: 2026-04-02
---
# Error responses in forge-orders

## The error body

Every REST endpoint answers an error with an application/problem+json body.

- The body has the fields type, title, status, detail and code.
- The status field in the body is optional.
- The detail field never carries a stack trace or an internal class name.
