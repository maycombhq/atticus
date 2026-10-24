# Add transfer limit: where it sits

Each account gets a daily transfer limit; a transfer over it is refused.

## Features

- cap-transfers: Sending money between accounts is the feature that gains the limit.

## Flows

- Flow ledger.accept-transfer (changed): the limit is checked where Ledger accepts a transfer.
