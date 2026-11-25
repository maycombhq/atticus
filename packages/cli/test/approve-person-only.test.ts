import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * ADR 0210 part 7: the sweep found that outside an ACP session an assistant's terminal could pass
 * --approve to `change handoff`, `change sync` and `task run`, recorded under the Git user. An
 * approval is a person's (hard rule 6): refused there, as a waive is.
 */
const saved = {
  CLAUDECODE: process.env.CLAUDECODE,
  ATTICUS_ASSISTANT: process.env.ATTICUS_ASSISTANT,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const run = async (argv: string[]) => {
  const err: string[] = [];
  const code = await main(argv, { out: () => {}, err: (l) => err.push(l) });
  return { code, err: err.join("\n") };
};

describe("--approve is a person's", () => {
  it("is refused in a coding assistant's terminal, for every command that takes it", async () => {
    process.env.CLAUDECODE = "1";
    for (const argv of [
      ["change", "handoff", "add-wallets", "--approve"],
      ["change", "sync", "add-wallets", "--approve"],
      ["task", "run", "add-wallets", "t1", "--approve"],
    ]) {
      const r = await run([...argv, "--root", "/nowhere"]);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toMatch(/^Approve in a terminal of your own, or in the app/);
    }
    delete process.env.CLAUDECODE;
    process.env.ATTICUS_ASSISTANT = "copilot";
    expect(
      (await run(["change", "handoff", "add-wallets", "--approve", "--root", "/nowhere"])).err,
    ).toMatch(/^Approve in a terminal of your own/);
  });

  it("is not refused in a person's terminal (the command goes on to its own checks)", async () => {
    delete process.env.CLAUDECODE;
    delete process.env.ATTICUS_ASSISTANT;
    const r = await run(["change", "handoff", "add-wallets", "--approve", "--root", "/nowhere"]);
    expect(r.err).not.toMatch(/Approve in a terminal of your own/);
  });
});
