import { describe, expect, it } from "vitest";
import { PluginRunError, runTranslator, type TranslatorPlugin } from "../src/index.js";

/**
 * A model-provider plugin's code (ADR 0121 item 4) runs in the same sandbox as a scanner
 * plugin: no network, no require, no clock. It only turns data into data: a prompt into a
 * request, an answer into text.
 */

const plugin = (source: string): TranslatorPlugin => ({
  id: "northwind-gateway",
  version: "1.0.0",
  source,
  limits: { timeoutMs: 2000, memoryMb: 32 },
});

const GOOD = `export default {
  id: "northwind-gateway",
  version: "1.0.0",
  request(i) {
    return { url: "https://" + i.settings.region + "-llm.northwind.example/v1/complete",
      body: { model: i.model, system: i.system, prompt: i.prompt, max: i.maxOutputTokens } };
  },
  async response(j) { return { text: j.output, inputTokens: j.usage.in, outputTokens: j.usage.out }; },
};`;

describe("the translator sandbox (ADR 0121)", () => {
  it("calls request and response, with data in and data out", async () => {
    const p = plugin(GOOD);
    expect(
      await runTranslator(p, "request", {
        model: "nw-large",
        system: "s",
        prompt: "p",
        maxOutputTokens: 10,
        settings: { region: "eu" },
      }),
    ).toEqual({
      url: "https://eu-llm.northwind.example/v1/complete",
      body: { model: "nw-large", system: "s", prompt: "p", max: 10 },
    });
    expect(await runTranslator(p, "response", { output: "OK", usage: { in: 3, out: 1 } })).toEqual({
      text: "OK",
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  it("stops a plugin that reaches for the network, the process or an import", async () => {
    for (const body of ["fetch('https://x.example')", "process.env", "Date.now()"]) {
      const p = plugin(
        `export default { id: "northwind-gateway", version: "1.0.0", request() { return ${body}; } };`,
      );
      await expect(runTranslator(p, "request", {})).rejects.toThrow(/blocked/);
    }
    const imp = plugin(`import fs from "node:fs";\nexport default { id: "x", version: "1" };`);
    await expect(runTranslator(imp, "request", {})).rejects.toBeInstanceOf(PluginRunError);
  });

  it("refuses an entry that says it is another plugin, or lacks the function, or runs too long", async () => {
    await expect(
      runTranslator(plugin(GOOD.replace('"1.0.0"', '"2.0.0"')), "request", { settings: {} }),
    ).rejects.toThrow(/manifest says northwind-gateway 1.0.0/);
    await expect(
      runTranslator(
        plugin(`export default { id: "northwind-gateway", version: "1.0.0" };`),
        "request",
        {},
      ),
    ).rejects.toThrow(/no request function/);
    const slow = plugin(
      `export default { id: "northwind-gateway", version: "1.0.0", request() { for (;;) {} } };`,
    );
    await expect(
      runTranslator({ ...slow, limits: { timeoutMs: 300, memoryMb: 32 } }, "request", {}),
    ).rejects.toThrow(/time limit/);
  });
});
