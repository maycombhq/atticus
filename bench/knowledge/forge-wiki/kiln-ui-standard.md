---
title: Kiln UI standard
space: PLATFORM
tags: [framework, kiln, security-standard]
owner: UI Platform team
last-updated: 2026-07-22
---

# Kiln UI standard

Kiln is the Forge UI framework. This page applies to every customer or staff screen, including the Forge portal.

## Building screens

- Screens use Kiln 2 components only; a team that needs a new component asks the UI Platform team.
- Every screen has an empty state, a loading state and an error state.
- Every screen meets WCAG 2.1 AA and passes the Kiln accessibility check in the pipeline.
- User-facing words come from the copy file, never from code.

## Calling the backend

- A UI calls only its own BFF; it never calls the gateway, another service or a vendor directly.
- The session lives in an HTTP-only cookie set by the BFF; tokens are never kept in browser storage.

## Personal data on screen

- Account numbers and card numbers are masked by default and show only the last 4 digits.

## Kiln 1

Kiln 1 is being retired; see Architecture decisions.
