# Integration standards

## Outbound calls

Every call to another service or a vendor states its timeout and its retries.

A call that can't be answered in time degrades: the caller says what it does instead.

## Vendor calls

Calls to a vendor go through the partner gateway, never straight to the vendor's host.

The gateway holds the vendor's credentials; a service never keeps them.

## File transfer

Batch files to a partner go through the managed file transfer route, never by email.
