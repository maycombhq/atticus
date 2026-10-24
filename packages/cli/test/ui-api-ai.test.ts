import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiAiRoutes } from "../src/ui-api-ai.js";

/**
 * The AI tab (ADR 0121): how AI runs here, read and written through the local API. A write is
 * checked against the Runtime schema, refuses anything that looks like a key, keeps what it
 * doesn't change, and says to commit it. Test asks the configured provider once, through a fake.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
let srv: RunningServer;
let root: string;
const asked: string[] = [];
const kept = new Map<string, string>();

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-ai-"));
  await cp(FORGE, root, { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    watch: false,
    extend: (r, ctx) =>
      uiAiRoutes(r, ctx, {
        env: { ATTICUS_MODEL_KEY: "set" },
        keys: {
          get: (n) => kept.get(n),
          set: (n, v) => void kept.set(n, v),
          forget: (n) => void kept.delete(n),
        },
        provider: (type, settings) => ({
          model: String(settings.model ?? type),
          complete: async ({ prompt }) => {
            asked.push(prompt);
            return { text: "OK", usage: { inputTokens: 5, outputTokens: 1 } };
          },
        }),
      }),
  });
});
afterAll(() => srv?.close());

const runtimeFile = () => readFile(join(root, "org-pack", "runtime.yaml"), "utf8");

describe("the AI tab's API (ADR 0121)", () => {
  it("says how AI runs here: modes, assistants by name, and the providers with their settings", async () => {
    const r = await call("GET", "/api/settings/ai");
    expect(r.status).toBe(200);
    const b = r.body as {
      ai: string;
      modes: { allowed: string[]; default: string };
      assistants: { id: string; name: string; allowed: boolean; default: boolean }[];
      providers: { type: string; settings: string[] }[];
      model: unknown;
      path: string;
    };
    expect(b.ai).toBe("on");
    expect(b.modes.default).toBe("hand-off");
    expect(b.assistants.map((a) => a.id)).toEqual(
      expect.arrayContaining(["copilot", "claude-code", "cursor", "agents-md"]),
    );
    expect(b.assistants.find((a) => a.id === "copilot")).toMatchObject({
      name: "GitHub Copilot",
      allowed: true,
      default: true,
    });
    expect(b.providers.map((p) => p.type)).toEqual(
      expect.arrayContaining(["anthropic", "openai-compatible", "azure-openai", "bedrock"]),
    );
    expect(b.providers.find((p) => p.type === "anthropic")!.settings).toEqual(
      expect.arrayContaining(["model", "keyEnv"]),
    );
    expect(b.model).toBeNull();
    expect(b.path).toBe("org-pack/runtime.yaml");
  });

  it("writes the choices to runtime.yaml, keeps what it doesn't change, and says to commit it", async () => {
    const r = await call("PUT", "/api/settings/ai", {
      modes: { allowed: ["hand-off", "model"], default: "hand-off" },
      assistants: { allowed: ["copilot", "cursor"], default: "copilot" },
      model: {
        type: "anthropic",
        settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/pull request/);
    const saved = parse(await runtimeFile()) as Record<string, unknown>;
    expect(saved.modes).toEqual({ allowed: ["hand-off", "model"], default: "hand-off" });
    expect(saved.assistants).toEqual({ allowed: ["copilot", "cursor"], default: "copilot" });
    expect((saved.adapters as Record<string, unknown>).model).toEqual({
      type: "anthropic",
      settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
    });
    // What the tab didn't touch stays as it was.
    expect(saved.autonomy).toMatchObject({ capPerRepo: { "forge-gateway": "plan-only" } });
    expect((saved.adapters as Record<string, unknown>).gitHost).toEqual({ type: "mock" });
    const after = (await call("GET", "/api/settings/ai")).body as { keySet: boolean };
    expect(after.keySet).toBe(true);
  });

  it("refuses a key typed where a variable's name goes, and a setting that doesn't read", async () => {
    const key = await call("PUT", "/api/settings/ai", {
      model: { type: "anthropic", settings: { model: "m", keyEnv: "sk-abcdefghijklmnopqrstuvwx" } },
    });
    expect(key.status).toBe(422);
    expect(JSON.stringify(key.body)).toMatch(/looks like a key/);
    expect(await runtimeFile()).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    const bad = await call("PUT", "/api/settings/ai", {
      modes: { allowed: ["hand-off"], default: "model" },
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toMatch(/default mode must be allowed/);
  });

  it("keeps a key in this machine's credential store, never in runtime.yaml or the answer", async () => {
    const key = "sk-abcdefghijklmnopqrstuvwx";
    const r = await call("POST", "/api/settings/ai/key", { name: "OTHER_KEY", value: key });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(key);
    expect(kept.get("OTHER_KEY")).toBe(key);
    expect(await runtimeFile()).not.toContain(key);
    const bad = await call("POST", "/api/settings/ai/key", { name: "not a name", value: key });
    expect(bad.status).toBe(422);
  });

  it("asks the provider once, with nothing from the estate, and says whether it answered", async () => {
    const r = await call("POST", "/api/settings/ai/test", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, model: "claude-opus-5-5" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.length).toBeLessThan(200);
  });
});
