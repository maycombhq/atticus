import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileJudgments,
  Judgment,
  judgmentKey,
  judgmentsRelOf,
  makeJudgment,
  memoryJudgments,
  overrideJudgment,
} from "../src/index.js";

/** ADR 0117: judgments/<kind>/<key>.yaml, the key a hash of the inputs. */

const AT = "2026-10-23T12:00:00Z";
const inputs = { v: 1, field: "renamedAt", criterion: "then renamedAt is the time of the rename" };

describe("the judgments store (ADR 0117)", () => {
  it("keys a judgment by its kind and inputs, in any key order", () => {
    const k = judgmentKey("covers-field", inputs);
    expect(k).toMatch(/^[0-9a-f]{24}$/);
    expect(
      judgmentKey("covers-field", { criterion: inputs.criterion, field: "renamedAt", v: 1 }),
    ).toBe(k);
    expect(judgmentKey("covers-field", { ...inputs, field: "renamedBy" })).not.toBe(k);
    expect(judgmentKey("states-value", inputs)).not.toBe(k);
    expect(() => judgmentKey("Not A Kind", inputs)).toThrow();
  });

  it("writes judgments/<kind>/<key>.yaml, reads it back, and lists what it can't read", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-judgments-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    expect(judgmentsRelOf(root)).toBe("judgments");
    const store = fileJudgments(root);
    const j = makeJudgment({
      kind: "covers-field",
      inputs,
      verdict: "yes",
      quotes: [{ of: "criterion", text: "renamedAt is the time" }],
      confirmedBy: { by: "ai", run: "run-20261023120000-0001" },
      at: AT,
    });
    await store.put(j);
    const text = await readFile(join(root, "judgments", "covers-field", `${j.key}.yaml`), "utf8");
    expect(text).toMatch(
      /^# A judgment \(ADR 0117\): covers-field, answered by run run-20261023120000-0001/,
    );
    expect(await store.get("covers-field", j.key)).toEqual(j);
    expect(await store.get("covers-field", "0".repeat(24))).toBeUndefined();
    expect(await store.get("../x", j.key)).toBeUndefined();
    await writeFile(join(root, "judgments", "covers-field", "bad.yaml"), "kind: [", "utf8");
    const all = await store.list();
    expect(all.judgments.map((x) => x.key)).toEqual([j.key]);
    expect(all.problems.map((p) => p.file)).toEqual(["judgments/covers-field/bad.yaml"]);
  });

  it("keeps a person's override over the model's verdict, with what it replaced", async () => {
    const store = memoryJudgments();
    const j = makeJudgment({
      kind: "covers-field",
      inputs,
      verdict: "no",
      confirmedBy: { by: "ai", run: "run-1" },
      at: AT,
    });
    await store.put(j);
    const o = await overrideJudgment(store, "covers-field", j.key, {
      verdict: "yes",
      name: "priya.nair",
      at: AT,
    });
    expect(o.confirmedBy).toEqual({ by: "person", name: "priya.nair" });
    expect(o.overrides).toEqual({ verdict: "no", confirmedBy: { by: "ai", run: "run-1" } });
    // A later model answer for the same inputs doesn't replace the person's.
    const back = await store.put({ ...j, verdict: "no" });
    expect(back.verdict).toBe("yes");
    expect(Judgment.parse(back)).toEqual(back);
    await expect(
      overrideJudgment(store, "covers-field", "f".repeat(24), {
        verdict: "yes",
        name: "a",
        at: AT,
      }),
    ).rejects.toThrow(/no judgment/);
  });
});
