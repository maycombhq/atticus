---
title: The legacy warehouse link
owner: Stock team
updated: 2026-05-02
---
# The legacy warehouse link

## TLS on the warehouse link

Exception WVR-2291, approved by the Security Architecture board on 2026-05-02: the warehouse link stays on TLS 1.2 until 2027-03-31. It is an exception to the security standard "Internal calls use TLS 1.3".

- forge-stock calls the warehouse over TLS 1.2 with mutual authentication until the warehouse is replaced.
