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
      "The anthropic model provider reads its key from ATTICUS_CLI_TEST_UNSET_KEY, which is set neither in the environment nor in this machine's credential store",
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

describe("a model-provider plugin through the CLI (ADR 0121 item 4)", { timeout: 120_000 }, () => {
  const cli = async (root: string, ...args: string[]) => {
    const { main } = await import("../src/main.js");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [...args, "--root", root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("adds Vertex to the org pack, tests it in the sandbox, and won't use it until it is pinned", async () => {
    const root = await metarepo(
      "{ type: vertex, settings: { model: claude-opus-5-5, project: forge-platform, region: europe-west1, keyEnv: ATTICUS_CLI_TEST_VERTEX } }",
    );
    const add = await cli(root, "plugin", "add", "vertex");
    expect(add.code, add.err).toBe(0);
    expect(add.out).toMatch(/review/i);
    expect(add.out).toContain("atticus plugin pin vertex");
    expect((await cli(root, "plugin", "add", "vertex")).code).toBe(1);

    const test = await cli(root, "plugin", "test", "vertex");
    expect(test.code, test.out + test.err).toBe(0);
    expect(test.out).toContain("pass  claude");
    expect(test.out).toContain("pass  gemini");
    expect(test.out).toMatch(/isn't pinned/);

    // Not pinned: model mode refuses it, before anything is sent.
    process.env.ATTICUS_CLI_TEST_VERTEX = "test-token-NOT-real";
    try {
      const unpinned = await run(root);
      expect(unpinned.code).toBe(2);
      expect(unpinned.err).toMatch(/isn't pinned/);
    } finally {
      delete process.env.ATTICUS_CLI_TEST_VERTEX;
    }

    expect((await cli(root, "plugin", "pin", "vertex")).code).toBe(0);
    const pinned = await cli(root, "plugin", "test", "vertex");
    expect(pinned.out).toContain("The pin matches index.js.");
  });

  it("builds a working provider from the pinned plugin, which never sees the key", async () => {
    const root = await metarepo("{ type: vertex, settings: {} }");
    expect((await cli(root, "plugin", "add", "vertex")).code).toBe(0);
    expect((await cli(root, "plugin", "pin", "vertex")).code).toBe(0);
    const { loadOrgPack, orgPackDirOf } = await import("@maycombhq/core");
    const { pluginProviderFactory } = await import("../src/model-plugins.js");
    const op = await loadOrgPack(orgPackDirOf(root));
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const make = await pluginProviderFactory(op.modelProviders[0]!, {
      env: { VERTEX_TOKEN: "test-token-NOT-real" },
      transport: async (r) => {
        sent.push(r);
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        };
      },
    });
    const p = make({
      model: "claude-opus-5-5",
      project: "forge-platform",
      region: "europe-west1",
      keyEnv: "VERTEX_TOKEN",
    });
    expect(await p.complete({ system: "s", prompt: "Reply OK.", maxOutputTokens: 10 })).toEqual({
      text: "OK",
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    expect(sent[0]!.url).toBe(
      "https://europe-west1-aiplatform.googleapis.com/v1/projects/forge-platform/locations/europe-west1/publishers/anthropic/models/claude-opus-5-5:rawPredict",
    );
    expect(sent[0]!.headers.authorization).toBe("Bearer test-token-NOT-real");
  });
});
