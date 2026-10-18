# The executor protocol

Some steps of a procedure happen in systems nobody can integrate with directly: a form in a
portal, a console only a person can reach. Each such step is a manual step a person can do and
record. A step executor is an optional local program that can do the step instead, over one of
three transports ([C4](../contracts/c4-plugins-workspace-and-api.md#runrequest)).

## Transports

- `http`: `GET /ping`, `POST /run` (202 with a run id, or 200 with the result),
  `GET /runs/<id>` polled for progress and the result, `GET /idempotency/<key>`. Local addresses
  only, unless a procedure names the host.
- `command`: the program is started for each call; one JSON request line on standard input, JSON
  lines on standard output (progress, then one result, pong or answer).
- `mcp`: a Model Context Protocol server over standard input and output; a tool per step and a
  tool that answers idempotency checks.

## Messages

- `ping` → `pong`: the executor's name, version, the procedures and step kinds it can run, and
  whether it can fill a form without submitting it.
- `run` → any number of `progress` messages, then one `result`: `done`, `failed` or
  `needs-person`, with outputs and evidence.
- `check` → `checked`: whether an idempotency key was used.

## Safety

- A write step runs only with a person's approval carrying the sha-256 of exactly the inputs
  approved.
- The same write always carries the same idempotency key, so an executor refuses or repeats
  rather than doing it twice. Only an answer that the key is unused allows a retry without a new
  approval.
- Atticus never passes credentials: a started program gets an environment without anything that
  looks like a secret, and requests and results carry none.
- When an executor fails or times out, the step falls back to the person.

## Conformance

The conformance suite checks an executor over its own transport: it answers a ping, reports a
fresh key as unused, runs the reference case and answers for the same run id, reports the key as
used afterwards, doesn't produce a second, different result for the same write, and (when it says
it can) leaves a fill-only run to a person.
