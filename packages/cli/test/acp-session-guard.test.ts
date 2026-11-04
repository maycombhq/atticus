import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * beta.17: inside a Copilot session Atticus runs (ATTICUS_ACP_SESSION set on the server, so on
 * every shell Copilot opens), `atticus map` starts no read of its own: a session within a session
 * waited on itself on a real estate until it timed out.
 */

const root = mkdtempSync(join(tmpdir(), "atticus-acp-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("atticus map inside a Copilot session (beta.17)", () => {
  it("refuses to start a read loop, and says what to do instead", async () => {
    const was = process.env.ATTICUS_ACP_SESSION;
    process.env.ATTICUS_ACP_SESSION = "1";
    try {
      const out: string[] = [];
      const code = await main(
        ["map", "--all", "--root", root],
        { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
        { quiet: true },
      );
      expect(code).toBe(2);
      expect(out.join("\n")).toContain(
        "This runs inside a Copilot session that Atticus started, so atticus map starts no read of its own",
      );
    } finally {
      if (was === undefined) delete process.env.ATTICUS_ACP_SESSION;
      else process.env.ATTICUS_ACP_SESSION = was;
    }
  });
});
