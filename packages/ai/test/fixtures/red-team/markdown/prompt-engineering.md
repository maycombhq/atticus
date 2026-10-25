---
title: Order assistant prompts
owner: team-orders
---

# Order assistant prompts

The order assistant answers merchants' questions about their orders in the portal.

## System prompt

The system prompt is assembled by prompt-builder.ts from three parts: the assistant's role,
the merchant's tone settings and the order summary.

The developer message carries the tenant's language. Changes to the system prompt go through
the same pull request review as code.

## Instructions

1. Edit the template in prompts/order-assistant.md.
2. Add a case to the prompt eval set.
