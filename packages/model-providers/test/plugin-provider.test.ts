import { describe, expect, it } from "vitest";
import {
  ModelProviderConfigError,
  ModelProviderError,
  PluginProvider,
  type HttpRequest,
  type Transport,
  type Translate,
} from "../src/index.js";

/**
 * A provider from an org-pack plugin (ADR 0121 item 4). The plugin's code translates; Atticus
 * calls, over HTTPS to the manifest's hosts only, and adds the key itself, so the plugin never
 * sees it. Nothing here leaves the process: the transport is scripted, the translator a fake.
 */

const KEY = "test-key-NOT-real-7f3a9c";
const env = { NW_KEY: KEY };

const manifest = {
  id: "northwind-gateway",
  version: "1.0.0",
  settings: ["region"],
  hosts: ["{region}-llm.northwind.example"],
  auth: "bearer" as const,
};

function scripted(json: unknown) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (r) => {
    requests.push(r);
    return { status: 200, headers: new Headers(), text: JSON.stringify(json) };
  };
  return { requests, transport };
}

/** What the plugin's request and response would do, as plain functions. */
function translator(over: { request?: (i: Record<string, unknown>) => unknown } = {}) {
  const seen: { fn: string; arg: unknown }[] = [];
  const translate: Translate = async (fn, arg) => {
    seen.push({ fn, arg });
    const i = arg as Record<string, unknown>;
    if (fn === "request")
      return over.request
        ? over.request(i)
        : {
            url: `https://${(i.settings as { region: string }).region}-llm.northwind.example/v1/complete`,
            headers: { "x-northwind-trace": "atticus" },
            body: { model: i.model, system: i.system, prompt: i.prompt, max: i.maxOutputTokens },
          };
    const j = arg as { output: string; stop: string; usage: { in: number; out: number } };
    return {
      text: j.output,
      cutOff: j.stop === "length",
      inputTokens: j.usage.in,
      outputTokens: j.usage.out,
    };
  };
  return { seen, translate };
}

const input = {
  system: "You are the architect agent.",
  prompt: "Draft the design.",
  maxOutputTokens: 400,
};
const answer = { output: "Forge Pay calls Northwind Pay.", stop: "end", usage: { in: 12, out: 6 } };
const settings = { model: "nw-large", keyEnv: "NW_KEY", region: "eu-west" };

describe("a model provider from a plugin (ADR 0121)", () => {
  it("sends what the plugin builds, with the key added by Atticus, and reads the answer through it", async () => {
    const { requests, transport } = scripted(answer);
    const { seen, translate } = translator();
    const p = new PluginProvider(manifest, settings, { env, transport, translate });
    expect(p.model).toBe("nw-large");
    expect(await p.complete(input)).toEqual({
      text: "Forge Pay calls Northwind Pay.",
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    const r = requests[0]!;
    expect(r.url).toBe("https://eu-west-llm.northwind.example/v1/complete");
    expect(r.headers).toMatchObject({
      "x-northwind-trace": "atticus",
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(r.body)).toEqual({
      model: "nw-large",
      system: input.system,
      prompt: input.prompt,
      max: 400,
    });
    // The plugin never sees the key, or the name of its variable.
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(JSON.stringify(seen)).not.toContain("NW_KEY");
  });

  it("refuses a request to a host the manifest doesn't name, over http, or with its own key header", async () => {
    const bad = [
      { url: "https://elsewhere.example/v1/complete", body: {} },
      { url: "http://eu-west-llm.northwind.example/v1", body: {} },
      { url: "https://user:pw@eu-west-llm.northwind.example/v1", body: {} },
      {
        url: "https://eu-west-llm.northwind.example/v1",
        headers: { Authorization: "x" },
        body: {},
      },
    ];
    for (const b of bad) {
      const { requests, transport } = scripted(answer);
      const p = new PluginProvider(manifest, settings, {
        env,
        transport,
        translate: translator({ request: () => b }).translate,
      });
      await expect(p.complete(input)).rejects.toBeInstanceOf(ModelProviderError);
      expect(requests).toHaveLength(0);
    }
  });

  it("says when the answer was cut off", async () => {
    const { transport } = scripted({ ...answer, stop: "length" });
    const p = new PluginProvider(manifest, settings, {
      env,
      transport,
      translate: translator().translate,
    });
    await expect(p.complete(input)).rejects.toThrow(/cut off|limit/i);
  });

  it("refuses settings it doesn't take, a host part that isn't a plain name, and a missing key", () => {
    const make = (s: Record<string, string>, e: Record<string, string> = env) =>
      new PluginProvider(manifest, s, {
        env: e,
        transport: scripted({}).transport,
        translate: translator().translate,
        keys: { get: () => undefined },
      });
    expect(() => make({ ...settings, colour: "blue" })).toThrow(ModelProviderConfigError);
    expect(() => make({ ...settings, region: "evil.example/x" })).toThrow(/region/);
    expect(() => make({ model: "nw-large", keyEnv: "NW_KEY" })).toThrow(/region/);
    expect(() => make(settings, {})).toThrow(/NW_KEY/);
  });

  it("sends no key with auth none, and the named header with header:<name>", async () => {
    for (const [auth, header] of [
      ["none", undefined],
      ["x-api-key", "x-api-key"],
      ["header:x-northwind-key", "x-northwind-key"],
    ] as const) {
      const { requests, transport } = scripted(answer);
      const s = auth === "none" ? { model: "nw-large", region: "eu-west" } : settings;
      const p = new PluginProvider({ ...manifest, auth }, s, {
        env,
        transport,
        translate: translator().translate,
      });
      await p.complete(input);
      const h = requests[0]!.headers;
      expect(h.authorization).toBeUndefined();
      if (header) expect(h[header]).toBe(KEY);
      else expect(JSON.stringify(h)).not.toContain(KEY);
    }
  });
});
