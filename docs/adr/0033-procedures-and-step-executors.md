# 0033. Procedures and pluggable step executors

- Status: accepted (direction from the product owner, 2026-10-18); contract in M3, UI in M4
- Date: 2026-10-18

## Context

Many steps outside Atticus are multi-step procedures in other systems (raising a ServiceNow request, creating ADO items, a gateway onboarding form). Where no API is available (ADR 0032), teams build their own automation for them, often running locally on a developer's machine (scripts, RPA, browser automation, AI agents). Atticus should be able to hand a detected procedure to such a tool without building or owning the automation itself.

## Decision

1. **Procedures are data.** A procedure is a named, ordered list of steps, each with typed inputs and outputs (JSON Schema), the system it acts on, whether it writes, and its evidence. Procedures are drafted from the organisation's knowledge the same way as manual-step templates (ADR 0032 point 5: how-to pages, uploads, past tickets), reviewed by a person and kept in the org pack (`process/procedures/<id>.yaml`, a new C6 file kind, additive). Every manual step Atticus creates names its procedure and fills its inputs.

2. **Executors plug in through one small protocol (a new C4 contract file, version 1).** An executor declares a name, the procedures or step kinds it can run, and a transport:
   - `http`: a service on the person's machine at `127.0.0.1` (never a remote host unless the org pack allows it), called with `POST /run`, then polled or notified for progress and result;
   - `command`: a local program Atticus starts, with the request as JSON on stdin and results as JSON lines on stdout;
   - `mcp`: an MCP server whose tools map to steps, for tools that already speak the Model Context Protocol.

   A run request carries the procedure and step id, the inputs, the change and task it belongs to, an idempotency key, and the approval (who approved, when, what exactly). The executor reports progress, and finishes with outputs (for example the request number), evidence (screenshot or page reference, timestamps) and a status: done, failed, or needs-person (it stopped and a person must finish). Atticus validates the outputs against the step's schema and records them in the change, exactly as if the person had entered them (ADR 0032 point 2).

3. **Safety rules (not configurable).** Executors are off unless the org pack allowlists them by name. Every write step needs a person's approval in Atticus before the call, per run, showing the exact inputs; the person can choose "fill but don't submit" when the executor supports it. Atticus never passes credentials to an executor and never stores the executor's: the tool runs under its owner's own session and the organisation's own rules for that tool. Results are attributed to the approving person and the executor by name. A failed or timed-out run falls back to the manual step; nothing is retried without a new approval unless the executor confirms the idempotency key was not used.

4. **Where it shows.** In the UI each manual step gets "Run with <executor>" next to "I did it myself"; the CLI gets `atticus todo run <step> --with <executor>`. `atticus executors check` lists configured executors, pings them and shows which procedures each covers.

## Consequences

Teams can automate their own systems with whatever tool they are allowed to use, and Atticus calls it through a stable contract while keeping approvals, audit and fallbacks. Atticus does not ship UI automation and takes no position on whether a given tool is permitted: that stays the organisation's decision through the allowlist. Cost: a new C4 contract file, three transports with contract tests (and a reference executor used in tests), and procedure drafting from knowledge.
