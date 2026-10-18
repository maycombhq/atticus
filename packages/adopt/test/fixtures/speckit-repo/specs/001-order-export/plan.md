# Implementation Plan: Order export

**Branch**: `001-order-export` | **Date**: 2026-08-21 | **Spec**: specs/001-order-export/spec.md

## Summary

Add `GET /exports/orders?day=` returning CSV.

## Technical Context

**Language/Version**: Node 22
**Primary Dependencies**: express
**Storage**: orders database (read only)
**Testing**: vitest
