import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0065: the CLI registers the built-in model providers, so runtime.yaml
// adapters.model.type anthropic (and the others) works without a plugin install. These runs
// stop at the settings check, before anything is sent: no network.

async function metarepo(model: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-model-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    [
      "schemaVersion: 1",
      "assistants: { allowed: [copilot], default: copilot }",
      "modes: { allowed: [hand-off, model], default: hand-off }",
      `adapters:\n  model: ${model}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

const run = async (root: string) => {
  const { main } = await import("../src/main.js");
  const err: string[] = [];
  const code = await main(
    ["feature", "suggest-names", "--root", root, "--mode", "model"],
    { out: () => {}, err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, err: err.join("\n") };
};

describe("model providers through the CLI", { timeout: 60_000 }, () => {
  it("anthropic is installed: the settings are checked (here, the key variable is unset)", async () => {
    delete process.env.ATTICUS_CLI_TEST_UNSET_KEY;
    const r = await run(
      await metarepo(
        "{ type: anthropic, settings: { model: claude-opus-5-5, keyEnv: ATTICUS_CLI_TEST_UNSET_KEY } }",
      ),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "The anthropic model provider reads its key from the environment variable ATTICUS_CLI_TEST_UNSET_KEY, which isn't set",
    );
  });

  it("a literal key in runtime.yaml is refused", async () => {
    const r = await run(
      await metarepo(
        "{ type: openai-compatible, settings: { model: m, baseUrl: 'https://gw.example/v1', keyEnv: sk-abcdefghijklmnopqrstuvwx } }",
      ),
    );
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/looks like a key or token itself/);
    expect(r.err).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("a type without a provider keeps the plain message", async () => {
    const r = await run(await metarepo("{ type: vertex, settings: { model: m } }"));
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "No vertex model provider is installed. Add its plugin, or use hand-off mode.",
    );
  });
});
