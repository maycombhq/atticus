import { describe, expect, it } from "vitest";
import { safeMessage, withFileLock } from "../src/file-lock.js";

/** ADR 0174: one write at a time to a corrections file, and commit messages safe to paste. */
describe("withFileLock and safeMessage", () => {
  it("runs work on one file in turn, a failure not stopping the next", async () => {
    const order: string[] = [];
    const slow = (n: string, ms: number) => async () => {
      order.push(`${n} start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${n} end`);
    };
    const a = withFileLock("/x/forge.corrections.jsonl", slow("a", 30));
    const b = withFileLock("/x/forge.corrections.jsonl", async () => {
      throw new Error("boom");
    });
    const c = withFileLock("/x/forge.corrections.jsonl", slow("c", 1));
    await a;
    await expect(b).rejects.toThrow("boom");
    await c;
    expect(order).toEqual(["a start", "a end", "c start", "c end"]);
  });

  it("keeps a message's words and drops what a shell would run", () => {
    expect(safeMessage('profile: harbor publishes $(rm -rf ~) "x" `y`; ok')).toBe(
      "profile: harbor publishes (rm -rf ) x y ok",
    );
    expect(safeMessage("forge-billing: owner team-ledger, system ledger")).toBe(
      "forge-billing: owner team-ledger, system ledger",
    );
  });
});
