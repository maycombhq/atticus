import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider, OpenAiCompatibleProvider } from "../src/index.js";

// The real transport (undici, proxy selection) against servers on 127.0.0.1 inside this test.
// Nothing here reaches another host.

const KEY = "local-test-key-not-real";
const input = { system: "sys", prompt: "hello", maxOutputTokens: 100 };

let model: Server;
let modelPort = 0;
const seen: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];

let proxy: Server;
let proxyPort = 0;
const tunnels: { target: string; auth?: string }[] = [];
const sockets = new Set<Socket>();

const listen = (s: Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  model = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/slow")) return; // never answers
      if (req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "from the local server" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 4 },
          }),
        );
        return;
      }
      if (req.url === "/v1/messages") {
        if (req.headers["x-api-key"] !== KEY) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "anthropic shape" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  model.on("connection", (s) => sockets.add(s));
  modelPort = await listen(model);

  // A CONNECT proxy that wants Basic credentials jdoe:hunter2-proxy.
  proxy = createServer();
  proxy.on("connection", (s) => sockets.add(s));
  proxy.on("connect", (req, client: Socket, head) => {
    const auth = req.headers["proxy-authorization"];
    tunnels.push({ target: req.url ?? "", ...(auth ? { auth } : {}) });
    if (auth !== `Basic ${Buffer.from("jdoe:hunter2-proxy").toString("base64")}`) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => model.close(r));
  await new Promise((r) => proxy.close(r));
});

describe("the real transport, on this machine only", () => {
  it("calls an OpenAI-compatible server directly", async () => {
    const p = new OpenAiCompatibleProvider(
      { model: "local-llm", baseUrl: `http://127.0.0.1:${modelPort}/v1` },
      { env: {} },
    );
    expect(await p.complete(input)).toEqual({
      text: "from the local server",
      usage: { inputTokens: 5, outputTokens: 4 },
    });
    const last = seen.at(-1)!;
    expect(last.url).toBe("/v1/chat/completions");
    expect(last.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(last.body).model).toBe("local-llm");
  });

  it("goes through HTTP_PROXY with the proxy's credentials, and NO_PROXY skips it", async () => {
    const env = {
      ATTICUS_MODEL_KEY: KEY,
      HTTP_PROXY: `http://jdoe:hunter2-proxy@127.0.0.1:${proxyPort}`,
    };
    const before = tunnels.length;
    const p = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        baseUrl: `http://127.0.0.1:${modelPort}`,
      },
      { env },
    );
    expect((await p.complete(input)).text).toBe("anthropic shape");
    expect(tunnels.length).toBe(before + 1);
    expect(tunnels.at(-1)!.target).toBe(`127.0.0.1:${modelPort}`);

    const direct = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        baseUrl: `http://127.0.0.1:${modelPort}`,
      },
      { env: { ...env, NO_PROXY: "localhost,127.0.0.1" } },
    );
    expect((await direct.complete(input)).text).toBe("anthropic shape");
    expect(tunnels.length).toBe(before + 1);
  });

  it("a proxy that wants credentials says so, without printing any", async () => {
    const p = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        baseUrl: `http://127.0.0.1:${modelPort}`,
        maxRetries: 0,
      },
      {
        env: {
          ATTICUS_MODEL_KEY: KEY,
          HTTP_PROXY: `http://jdoe:wrong-pass@127.0.0.1:${proxyPort}`,
        },
      },
    );
    const msg = await p.complete(input).catch((e: Error) => e.message);
    expect(msg).toBe(
      `The proxy http://127.0.0.1:${proxyPort} refused to connect Atticus to 127.0.0.1:${modelPort} (HTTP 407). Check HTTPS_PROXY, the proxy's credentials (HTTP 407 means it wants them) and that it allows 127.0.0.1:${modelPort}; or add 127.0.0.1:${modelPort} to NO_PROXY.`,
    );
    expect(msg).not.toContain("wrong-pass");
    expect(msg).not.toContain(KEY);
  });

  it("a wrong key is a 401 that names the variable", async () => {
    const p = new AnthropicProvider(
      {
        model: "claude-opus-5-5",
        keyEnv: "ATTICUS_MODEL_KEY",
        baseUrl: `http://127.0.0.1:${modelPort}`,
      },
      { env: { ATTICUS_MODEL_KEY: "wrong-key-for-test" } },
    );
    await expect(p.complete(input)).rejects.toThrow(
      /refused the credentials \(HTTP 401\). Check that the environment variable ATTICUS_MODEL_KEY/,
    );
  });

  it("nothing listening: says it couldn't reach the host", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise((r) => closed.close(r));
    const p = new OpenAiCompatibleProvider(
      { model: "m", baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 },
      { env: {} },
    );
    await expect(p.complete(input)).rejects.toThrow(
      new RegExp(`couldn't reach 127.0.0.1:${port} \\(ECONNREFUSED\\)`),
    );
  });

  it("times out on a server that never answers", async () => {
    const p = new OpenAiCompatibleProvider(
      { model: "m", baseUrl: `http://127.0.0.1:${modelPort}/slow`, timeoutMs: 1000, maxRetries: 0 },
      { env: {} },
    );
    await expect(p.complete(input)).rejects.toThrow(/didn't answer within 1 second./);
  });
});
