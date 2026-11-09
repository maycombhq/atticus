import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startServer, type RunningServer } from "@maycombhq/server";
import { builtInModelProviders } from "@maycombhq/model-providers";
import { uiAiRoutes } from "../src/ui-api-ai.js";
import { confirmFor } from "./confirm-helpers.js";
import { sh } from "./run-helpers.js";

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
  // A person's comment inside the file, not only at the top: a save keeps it.
  const rt = join(root, "org-pack", "runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace(
      /^autonomy:/m,
      "# the autonomy caps are the platform team's\nautonomy:",
    ),
  );
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
    expect((r.body as { runs: string }).runs).toBe(
      "Hand-off to GitHub Copilot · headless Claude Code allowed",
    );
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
    const choices = {
      modes: { allowed: ["hand-off", "model"], default: "hand-off" },
      assistants: { allowed: ["copilot", "cursor"], default: "copilot" },
      model: {
        type: "anthropic",
        settings: { model: "claude-opus-5-5", keyEnv: "ATTICUS_MODEL_KEY" },
      },
    };
    // Review round 48 (ADR 0186): choosing the provider decides where its key goes, so it is the
    // person's confirmation from the app, never the session token alone.
    const bare = await call("PUT", "/api/settings/ai", choices);
    expect(bare.status).toBe(403);
    expect((parse(await runtimeFile()) as { adapters: object }).adapters).not.toHaveProperty(
      "model",
    );
    const r = await call("PUT", "/api/settings/ai", {
      ...choices,
      confirmation: await confirmFor(srv, "ai-model", "model"),
    });
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/Propose it for review/);
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
    expect(await runtimeFile()).toContain("# the autonomy caps are the platform team's");
    const after = (await call("GET", "/api/settings/ai")).body as { keySet: boolean };
    expect(after.keySet).toBe(true);
  });

  it("lifts a version 2 file to 3 when copilot-acp is chosen (UX review)", async () => {
    const rt = join(root, "org-pack", "runtime.yaml");
    const before = await readFile(rt, "utf8");
    await writeFile(rt, before.replace(/^schemaVersion: \d+/m, "schemaVersion: 2"));
    try {
      const r = await call("PUT", "/api/settings/ai", {
        modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const saved = parse(await readFile(rt, "utf8")) as Record<string, unknown>;
      expect(saved.schemaVersion).toBe(3);
      expect(saved.modes).toEqual({ allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" });
    } finally {
      await writeFile(rt, before);
    }
  });

  it("writes decide (ADR 0181, ninth UX walk): lifts a version 3 file to 4, keeps CRLF, and says an older file needs atticus upgrade", async () => {
    const rt = join(root, "org-pack", "runtime.yaml");
    const before = await readFile(rt, "utf8");
    const decide = { links: "auto", questions: "propose", minPrecision: 0.9 };
    try {
      await writeFile(
        rt,
        before.replace(/^schemaVersion: \d+/m, "schemaVersion: 3").replace(/\r?\n/g, "\r\n"),
      );
      const got = (await call("GET", "/api/settings/ai")).body as {
        decide: unknown;
        schemaVersion: number;
      };
      expect(got.decide).toEqual({ links: "propose", questions: "propose", minPrecision: 0.95 });
      expect(got.schemaVersion).toBe(3);
      const r = await call("PUT", "/api/settings/ai", { decide });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const text = await readFile(rt, "utf8");
      expect(text).toMatch(/\r\n/);
      expect(text.replace(/\r\n/g, "")).not.toMatch(/\n/);
      const saved = parse(text) as Record<string, unknown>;
      expect(saved.schemaVersion).toBe(4);
      expect(saved.decide).toEqual(decide);
      expect(((await call("GET", "/api/settings/ai")).body as { decide: unknown }).decide).toEqual(
        decide,
      );
      // A version 1 file needs the upgrade first: said, nothing written.
      await writeFile(rt, before.replace(/^schemaVersion: \d+/m, "schemaVersion: 1"));
      const old = await call("PUT", "/api/settings/ai", { decide });
      expect(old.status).toBe(422);
      expect(JSON.stringify(old.body)).toMatch(/atticus upgrade/);
      expect(await readFile(rt, "utf8")).toBe(
        before.replace(/^schemaVersion: \d+/m, "schemaVersion: 1"),
      );
    } finally {
      await writeFile(rt, before);
    }
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
    // Not committed (this metarepo has no Git history): Test is the person's confirmation.
    const bare = await call("POST", "/api/settings/ai/test", {});
    expect(bare.status).toBe(403);
    expect(asked).toHaveLength(0);
    const r = await call("POST", "/api/settings/ai/test", {
      confirmation: await confirmFor(srv, "ai-test", "model"),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, model: "claude-opus-5-5" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.length).toBeLessThan(200);
  });

  it("keyEnv names a model's key: ATTICUS_*, a provider's own, or one kept in the credential store (review round 48)", async () => {
    for (const name of [
      "GITHUB_TOKEN",
      "HOME",
      "AZURE_DEVOPS_EXT_PAT",
      "SYSTEM_ACCESSTOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      const r = await call("PUT", "/api/settings/ai", {
        model: { type: "anthropic", settings: { model: "m", keyEnv: name } },
        confirmation: await confirmFor(srv, "ai-model", "model"),
      });
      expect(r.status, name).toBe(422);
      expect(JSON.stringify(r.body)).toMatch(/ATTICUS_/);
      expect(await runtimeFile()).not.toContain(name);
    }
    kept.set("TEAM_GATEWAY_KEY", "kept-here");
    for (const name of ["ANTHROPIC_API_KEY", "ATTICUS_OTHER_KEY", "TEAM_GATEWAY_KEY"]) {
      const r = await call("PUT", "/api/settings/ai", {
        model: { type: "anthropic", settings: { model: "m", keyEnv: name } },
        confirmation: await confirmFor(srv, "ai-model", "model"),
      });
      expect(r.status, name).toBe(200);
    }
    // Only the model's own settings, not where its key goes: no confirmation needed.
    const same = await call("PUT", "/api/settings/ai", {
      model: { type: "anthropic", settings: { model: "m2", keyEnv: "TEAM_GATEWAY_KEY" } },
    });
    expect(same.status).toBe(200);
    // Its address: the person's confirmation.
    const moved = await call("PUT", "/api/settings/ai", {
      model: {
        type: "anthropic",
        settings: { model: "m2", keyEnv: "TEAM_GATEWAY_KEY", baseUrl: "https://elsewhere.example" },
      },
    });
    expect(moved.status).toBe(403);
    expect(await runtimeFile()).not.toContain("elsewhere.example");
  });
});

describe("the AI tab's Test never sends another secret to a model's address (review round 48)", () => {
  it("a hand-edited, committed runtime.yaml naming GITHUB_TOKEN sends nothing; uncommitted settings need the person", async () => {
    const seen: { url: string; auth: string }[] = [];
    const sink = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: {} }));
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
    const at = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/v1`;
    const dir = await mkdtemp(join(tmpdir(), "atticus-ui-ai-sink-"));
    await cp(FORGE, dir, { recursive: true });
    const rt = join(dir, "org-pack", "runtime.yaml");
    const model = (keyEnv: string, baseUrl = at) =>
      `  model:\n    type: openai-compatible\n    settings: { model: m, keyEnv: ${keyEnv}, baseUrl: "${baseUrl}" }\n`;
    await writeFile(
      rt,
      (await readFile(rt, "utf8")).replace(/^adapters:\n/m, `adapters:\n${model("GITHUB_TOKEN")}`),
    );
    sh(dir, "init", "-q");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "runtime");
    const env = { GITHUB_TOKEN: "ghp-not-for-a-model", ATTICUS_MODEL_KEY: "model-key" };
    const s = await startServer({
      root: dir,
      port: 0,
      user: "pat",
      watch: false,
      extend: (r, ctx) =>
        uiAiRoutes(r, ctx, {
          env,
          keys: { get: () => undefined, set() {}, forget() {} },
          provider: (type, settings) =>
            builtInModelProviders({ env })[type]?.(
              settings as Parameters<ReturnType<typeof builtInModelProviders>[string]>[0],
            ),
        }),
    });
    const post = async (body: unknown) => {
      const r = await fetch(`${s.url}/api/settings/ai/test`, {
        method: "POST",
        headers: { "X-Atticus-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    try {
      // Committed, but at an address the person never confirmed: round 50, HEAD isn't their yes.
      expect((await post({})).status).toBe(403);
      expect(seen).toEqual([]);
      // With their confirmation, the provider still refuses GITHUB_TOKEN.
      const r = await post({ confirmation: await confirmFor(s, "ai-test", "model") });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(String(r.body.error)).toMatch(/isn't read from the environment/);
      expect(seen).toEqual([]);
      // Changed since HEAD (to a model key, at the same sink): the person's confirmation first.
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace("keyEnv: GITHUB_TOKEN", "keyEnv: ATTICUS_MODEL_KEY"),
      );
      expect((await post({})).status).toBe(403);
      expect(seen).toEqual([]);
      const ok = await post({ confirmation: await confirmFor(s, "ai-test", "model") });
      expect(ok.body.ok, JSON.stringify(ok.body)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.auth).toBe("Bearer model-key");
      expect(JSON.stringify(seen)).not.toContain("ghp-not-for-a-model");
    } finally {
      await s.close();
      sink.close();
    }
  });
});
