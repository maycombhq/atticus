import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addressRefusal,
  asTheApp,
  confirmedAddress,
  guardModelAddress,
  recordConfirmedAddress,
  whereKeyGoes,
  whoStarts,
} from "../src/model-address.js";
import { userStateDir } from "../src/user-state.js";
import { main } from "../src/main.js";

/**
 * Review round 50 (ADR 0186 addendum): where a model's key goes is the person's. The address
 * they last confirmed is kept outside the metarepo; a run the app or a Copilot session starts
 * sends the key only there (or, with nothing confirmed yet, to the provider's own address).
 */

const sink = {
  type: "anthropic",
  settings: { model: "m", keyEnv: "ANTHROPIC_API_KEY", baseUrl: "http://127.0.0.1:9" },
};
const own = { type: "anthropic", settings: { model: "m", keyEnv: "ANTHROPIC_API_KEY" } };

let root: string;
let was: string | undefined;
beforeEach(async () => {
  was = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "atticus-addr-state-"));
  root = await mkdtemp(join(tmpdir(), "atticus-addr-"));
});
afterEach(() => {
  process.env.XDG_STATE_HOME = was;
});

describe("the confirmed address", () => {
  it("is kept in the user's state folder, never the metarepo", async () => {
    expect(userStateDir({ XDG_STATE_HOME: "/s" }, "linux")).toBe(join("/s", "atticus"));
    expect(userStateDir({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe(
      join("C:\\L", "atticus", "state"),
    );
    expect(await confirmedAddress(root)).toBeUndefined();
    await recordConfirmedAddress(root, sink);
    expect(await confirmedAddress(root)).toBe(whereKeyGoes(sink));
    expect(whereKeyGoes(sink)).not.toBe(whereKeyGoes(own));
    // The model's name isn't where the key goes.
    expect(whereKeyGoes({ ...own, settings: { ...own.settings, model: "x" } })).toBe(
      whereKeyGoes(own),
    );
  });

  it("refuses an address that isn't the confirmed one; with none, takes only a provider's own", async () => {
    expect(await addressRefusal(root, own)).toBeUndefined();
    expect(
      await addressRefusal(root, { type: "bedrock", settings: { region: "eu-west-1" } }),
    ).toBeUndefined();
    expect(await addressRefusal(root, sink)).toMatch(/127\.0\.0\.1:9.*AI settings/s);
    // A provider with no address of its own, a CA of the settings' choosing, a plugin: asked.
    for (const m of [
      { type: "openai-compatible", settings: { baseUrl: "https://llm.example/v1" } },
      { type: "anthropic", settings: { caFile: "/tmp/ca.pem" } },
      { type: "northwind-gateway", settings: { model: "nw" } },
    ])
      expect(await addressRefusal(root, m), m.type).toMatch(/confirm/);
    expect(await addressRefusal(root, { type: "mock", settings: {} })).toBeUndefined();
    await recordConfirmedAddress(root, sink);
    expect(await addressRefusal(root, sink)).toBeUndefined();
    // Once one is confirmed, the provider's own is a change too.
    expect(await addressRefusal(root, own)).toMatch(/confirm/);
  });
});

describe("who started the run", () => {
  it("is the app inside a request, a Copilot session by its variable, else the terminal", async () => {
    expect(whoStarts({}, true)).toBe("person");
    expect(whoStarts({}, false)).toBe("unattended");
    expect(whoStarts({ ATTICUS_ACP_SESSION: "1" }, true)).toBe("session");
    expect(await asTheApp(async () => whoStarts({}, true))).toBe("app");
  });

  it("refuses the app and a session, records a person's at the terminal, leaves the rest", async () => {
    const o = { root, ...sink };
    await expect(asTheApp(() => guardModelAddress(o, {}, true))).rejects.toThrow(/AI settings/);
    await expect(guardModelAddress(o, { ATTICUS_ACP_SESSION: "1" }, false)).rejects.toThrow(
      /AI settings/,
    );
    // A script or CI (no terminal, no session, not the app): as before, nothing kept.
    await guardModelAddress(o, {}, false);
    expect(await confirmedAddress(root)).toBeUndefined();
    // The person running the step in their own terminal sends it there: that is their yes.
    await guardModelAddress(o, {}, true);
    expect(await confirmedAddress(root)).toBe(whereKeyGoes(sink));
    await asTheApp(() => guardModelAddress(o, {}, true));
  });

  it("a step a Copilot session runs in model mode exits 2 and sends nothing", async () => {
    const got: string[] = [];
    const sinkSrv = createServer((req, res) => {
      got.push(String(req.headers["x-api-key"] ?? ""));
      res.writeHead(500);
      res.end("{}");
    });
    await new Promise<void>((r) => sinkSrv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(sinkSrv.address() as { port: number }).port}`;
    const forge = join(fileURLToPath(new URL("../../../fixtures/forge", import.meta.url)));
    await cp(join(forge, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    await writeFile(
      join(root, "org-pack/runtime.yaml"),
      `schemaVersion: 1
assistants: { allowed: [copilot], default: copilot }
editors: [vscode]
modes: { allowed: [hand-off, model], default: hand-off }
autonomy: { default: draft }
adapters:
  model: { type: anthropic, settings: { model: m, keyEnv: ANTHROPIC_API_KEY, baseUrl: "${url}", maxRetries: 0 } }
`,
    );
    const prev = { s: process.env.ATTICUS_ACP_SESSION, k: process.env.ANTHROPIC_API_KEY };
    process.env.ATTICUS_ACP_SESSION = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const err: string[] = [];
    let code: number;
    try {
      code = await main(["knowledge", "scan", "--mode", "model", "--root", root], {
        out: () => undefined,
        err: (l) => err.push(l),
      });
    } finally {
      if (prev.s === undefined) delete process.env.ATTICUS_ACP_SESSION;
      else process.env.ATTICUS_ACP_SESSION = prev.s;
      if (prev.k === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev.k;
      sinkSrv.close();
    }
    expect(err.join("\n")).toMatch(/haven't confirmed.*AI settings/s);
    expect(code).toBe(2);
    expect(got).toEqual([]);
  });
});
