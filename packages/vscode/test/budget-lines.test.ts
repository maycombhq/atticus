import { describe, expect, it } from "vitest";
import { readNext } from "../src/atticus";
import { reasonFirst } from "../src/cli";
import { runStep } from "../src/runner";

/**
 * ADR 0210 part 5: a model run's first standard-error line is its budget ("Budget: ..."). The
 * extension never takes it for why a step stopped; on a budget stop, the stop is the reason.
 */
const PLAN =
  "Budget: The read of forge-ledger plans 3 sessions and about 21,554 tokens; limits: 1 session a run.";
const STOP =
  "This run would pass 1 session a run: 0 used and 3 planned. Nothing was sent. Confirm it at a terminal, run it with --yes, or raise budgets.limits in org-pack/runtime.yaml.";
const cancel = {
  token: {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  },
};

describe("the budget line on standard error", () => {
  it("puts every other line first", () => {
    expect(reasonFirst(`${PLAN}\n${STOP}\n`)).toBe(`${STOP}\n${PLAN}`);
    expect(reasonFirst(`${PLAN}\n`)).toBe(PLAN);
    expect(reasonFirst("")).toBe("");
  });

  it("a step stopped by its budget fails with the stop as its reason", async () => {
    const cli = async () => ({
      code: 2,
      stdout: "",
      stderr: `${PLAN}\n${STOP}\n`,
      cancelled: false,
    });
    const end = await runStep(
      ["map", "forge-ledger"],
      { root: "/nowhere", cli, model: async () => undefined },
      cancel.token as never,
    );
    expect(end).toMatchObject({ state: "failed", errors: [STOP] });
  });

  it("a read that refuses says why, not the budget line", async () => {
    const cli = async () => ({
      code: 2,
      stdout: "",
      stderr: `${PLAN}\nAnother catalog build is running.\n`,
      cancelled: false,
    });
    expect(await readNext(cli, "/nowhere")).toEqual({
      ok: false,
      message: "Another catalog build is running.",
    });
  });
});
