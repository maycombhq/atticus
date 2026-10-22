import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtticusApi, ApiFailed } from "../src/api";
import { appTokenFrom } from "../src/app-panel";

let srv: Server;
let url: string;
const seen: { path: string; token: string | undefined }[] = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    seen.push({ path: req.url ?? "", token: req.headers["x-atticus-token"] as string | undefined });
    if (req.method === "POST") {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ got: JSON.parse(body), type: req.headers["content-type"] }));
      });
      return;
    }
    if (req.url === "/api/specs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ repos: [{ repo: "forge-web", flows: 3 }] }));
    } else {
      res.writeHead(404, { "Content-Type": "application/problem+json" });
      res.end(
        JSON.stringify({ title: "Not found", status: 404, detail: "forge-ledger has no spec." }),
      );
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe("the app's API, as the sidebar reads it (ADR 0093)", () => {
  it("sends the session token and reads the JSON", async () => {
    const api = new AtticusApi(url, "tok-1");
    expect(await api.get<{ repos: unknown[] }>("/api/specs")).toEqual({
      repos: [{ repo: "forge-web", flows: 3 }],
    });
    expect(seen.at(-1)).toEqual({ path: "/api/specs", token: "tok-1" });
  });

  it("posts JSON with the token", async () => {
    const api = new AtticusApi(url, "tok-1");
    expect(await api.post("/api/findings/c/f1/action", { action: "ask", askedOf: "pat" })).toEqual({
      got: { action: "ask", askedOf: "pat" },
      type: "application/json",
    });
    expect(seen.at(-1)).toEqual({ path: "/api/findings/c/f1/action", token: "tok-1" });
  });

  it("says what the API said when a call fails", async () => {
    const api = new AtticusApi(url, "tok-1");
    const e = await api.get("/api/specs/forge-ledger").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiFailed);
    expect((e as ApiFailed).status).toBe(404);
    expect((e as Error).message).toBe("Not found: forge-ledger has no spec.");
  });

  it("hands back any status and body as they came, for the app in a panel (ADR 0097)", async () => {
    const api = new AtticusApi(url, "tok-1");
    expect(await api.request("GET", "/api/specs/forge-ledger")).toEqual({
      status: 404,
      body: { title: "Not found", status: 404, detail: "forge-ledger has no spec." },
    });
    expect(await api.request("POST", "/api/x", { a: 1 })).toEqual({
      status: 200,
      body: { got: { a: 1 }, type: "application/json" },
    });
  });

  it("says so when nothing answers", async () => {
    const api = new AtticusApi("http://127.0.0.1:1", "tok-1");
    await expect(api.get("/api/specs")).rejects.toThrow(/didn't answer/);
  });
});

describe("the session token", () => {
  it("is read from what atticus ui prints", () => {
    expect(appTokenFrom("For assistants and scripts, the session token is AbC-12_x\n")).toBe(
      "AbC-12_x",
    );
    expect(appTokenFrom("Atticus is running at http://127.0.0.1:1\n")).toBeUndefined();
  });
});
