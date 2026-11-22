import { describe, expect, it } from "vitest";
import { claim, fact, run } from "./claims-helpers.js";

/**
 * ADR 0206, the review's blocker 2: a claimed value is written on the cited lines only as a word of its
 * own, never as a part of a longer one (`anvil` in `ledger-anvil`, `prod` in `production`).
 */

describe("a word on the cited lines (the review's blocker 2)", () => {
  const deploy = (platform: string, env: string, line: string) =>
    run(
      [claim("deployment", { platform, env })],
      [
        fact({
          kind: "deploy",
          id: "d-0",
          env,
          platform,
          resourceName: "ledger-anvil",
          cite: { file: "deploy/anvil.yaml", line: 1, value: "ledger-anvil", quote: line },
        }),
      ],
      { "deploy/anvil.yaml": [line] },
    ).claims[0]!;

  it("platform anvil isn't written on `name: ledger-anvil`", () => {
    const c = deploy("anvil", "prod", "name: ledger-anvil");
    expect(c.outcome).toBe("present");
    expect(c.why).toBe("The assistant's reading of deploy/anvil.yaml:1: platform anvil, env prod.");
  });

  it("env prod isn't written on `env: production`, and is on `env: prod`", () => {
    expect(deploy("anvil", "prod", "name: anvil # env: production").why).toBe(
      "Written on the cited lines: platform anvil. The assistant's reading of deploy/anvil.yaml:1: env prod.",
    );
    expect(deploy("anvil", "prod", "platform: anvil, env: prod").why).toBe(
      "Written on the cited lines: platform anvil, env prod.",
    );
  });

  it("a host isn't written on a longer host", () => {
    const r = run(
      [claim("route", { host: "anvil.forge.example" })],
      [
        fact({
          kind: "deploy",
          id: "d-0",
          platform: "anvil",
          host: "anvil.forge.example",
          resourceName: "ledger",
          cite: {
            file: "deploy/anvil.yaml",
            line: 1,
            value: "ledger",
            quote: "ledger: orders.anvil.forge.example",
          },
        }),
      ],
      { "deploy/anvil.yaml": ["ledger: orders.anvil.forge.example"] },
    ).claims[0]!;
    expect(r.why).toBe("The assistant's reading of deploy/anvil.yaml:1: host anvil.forge.example.");
  });
});
