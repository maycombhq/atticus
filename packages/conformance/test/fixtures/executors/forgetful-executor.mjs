#!/usr/bin/env node
// Deliberately non-conforming step executor (command transport): it never remembers an
// idempotency key, so it runs the same write twice with different results, and reports no
// progress.
import { createInterface } from "node:readline";

let counter = Number(process.pid);
const rl = createInterface({ input: process.stdin });
rl.once("line", (line) => {
  const msg = JSON.parse(line);
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  if (msg.type === "ping")
    out({ type: "pong", name: "forgetful", version: "0.0.1", stepKinds: ["submit-request"] });
  else if (msg.type === "check")
    out({ type: "checked", idempotencyKey: msg.idempotencyKey, used: false });
  else if (msg.type === "run")
    out({
      type: "result",
      runId: msg.runId,
      status: "done",
      outputs: { requestNumber: `SR-${(counter += 7)}` },
    });
  rl.close();
});
