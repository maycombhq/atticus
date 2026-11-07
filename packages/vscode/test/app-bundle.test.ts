import { describe, expect, it } from "vitest";
import { answerApp, bundledHtml, saveFromApp } from "../src/app-bundle";

/**
 * ADR 0097: the app's own files, shipped in the extension, loaded straight into a VS Code panel:
 * no page on 127.0.0.1 to frame. The panel's calls come to the extension, which answers them from
 * the local API.
 */

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="atticus-token" content="" />
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <title>Atticus</title>
    <script type="module" crossorigin src="./assets/index-DV4tVQje.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-JG0xtGK8.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe("the app's page in a panel (ADR 0097)", () => {
  const html = bundledHtml(INDEX, {
    base: "https://file+.vscode-resource.vscode-cdn.net/ext/media/app/",
    cspSource: "https://file+.vscode-resource.vscode-cdn.net",
    nonce: "n0nce",
    hash: "#/flows?repo=nadiengine&flow=nadiengine-api.save-horoscope",
  });

  it("loads the app's files from the extension, under a strict policy", () => {
    // No <base>: with one, the app's own links (#/architecture) would leave the page, and a
    // panel refuses that, so clicking them did nothing. The files get their full address instead.
    expect(html).not.toContain("<base");
    expect(html).toContain(
      'src="https://file+.vscode-resource.vscode-cdn.net/ext/media/app/assets/index-DV4tVQje.js"',
    );
    expect(html).toContain(
      'href="https://file+.vscode-resource.vscode-cdn.net/ext/media/app/assets/index-JG0xtGK8.css"',
    );
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce' https://file+.vscode-resource.vscode-cdn.net");
    expect(csp).toContain("worker-src blob:");
    expect(csp).not.toMatch(/127\.0\.0\.1|unsafe-eval|connect-src [^;]*\*/);
    expect(html).toContain('<script nonce="n0nce" type="module" crossorigin src="https://');
  });

  it("opens on the view asked for, and holds no session token", () => {
    expect(html).toContain(
      '<script nonce="n0nce">location.hash = "#/flows?repo=nadiengine&flow=nadiengine-api.save-horoscope";</script>',
    );
    expect(html).not.toContain("atticus-token");
  });

  it("refuses a view that isn't one of the app's screens", () => {
    const bad = bundledHtml(INDEX, {
      base: "b/",
      cspSource: "c",
      nonce: "n",
      hash: '"</script><script>alert(1)</script>',
    });
    expect(bad).not.toContain("alert(1)");
    // The app's Home, one of its six entries (ADR 0124 addendum D-app).
    expect(bad).toContain('location.hash = "#/home";');
  });
});

describe("answering the app's calls", () => {
  const calls: unknown[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    return { status: 200, body: { ok: true } };
  };

  it("answers an API call with the local API's status and body", async () => {
    expect(
      await answerApp(
        { type: "api", id: 7, method: "PUT", path: "/api/graph/layout/x", body: { a: 1 } },
        call,
      ),
    ).toEqual({ type: "api-reply", id: 7, status: 200, body: { ok: true } });
    expect(calls.at(-1)).toEqual(["PUT", "/api/graph/layout/x", { a: 1 }]);
  });

  it("refuses anything but a call to the local API", async () => {
    const before = calls.length;
    expect(
      await answerApp({ type: "api", id: 1, method: "GET", path: "https://example.com/x" }, call),
    ).toMatchObject({
      type: "api-reply",
      id: 1,
      status: 400,
    });
    expect(
      await answerApp({ type: "api", id: 2, method: "TRACE", path: "/api/x" }, call),
    ).toMatchObject({ status: 400 });
    expect(
      await answerApp({ type: "api", id: 3, method: "GET", path: "/api/../../etc" }, call),
    ).toMatchObject({ status: 400 });
    expect(await answerApp({ type: "hello" }, call)).toBeUndefined();
    expect(calls.length).toBe(before);
  });

  it("says so when the local API doesn't answer", async () => {
    const r = await answerApp(
      { type: "api", id: 4, method: "GET", path: "/api/specs" },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    expect(r).toMatchObject({ type: "api-reply", id: 4, status: 503 });
    expect((r as { body: { detail: string } }).body.detail).toContain("ECONNREFUSED");
  });
});

describe("a file the app asks to save (a canvas export in a panel)", () => {
  it("writes what the page sent where the person picks, and says so", async () => {
    const got: { name: string; text: string }[] = [];
    const save = async (name: string, bytes: Uint8Array) => {
      got.push({ name, text: Buffer.from(bytes).toString("utf8") });
      return "saved" as const;
    };
    const png = Buffer.from("png-bytes").toString("base64");
    expect(
      await saveFromApp(
        { type: "save-file", id: 3, name: "estate.png", data: png, encoding: "base64" },
        save,
      ),
    ).toEqual({ type: "save-reply", id: 3, state: "saved" });
    expect(got).toEqual([{ name: "estate.png", text: "png-bytes" }]);
    expect(await saveFromApp({ type: "api", id: 1 }, save)).toBeUndefined();
  });

  it("refuses a name with a folder in it, and answers a cancel", async () => {
    const save = async () => "cancelled" as const;
    for (const name of ["../x.svg", "a/b.svg", "C:\\\\x.svg", ".env"])
      expect(
        await saveFromApp({ type: "save-file", id: 1, name, data: "x", encoding: "utf8" }, save),
      ).toMatchObject({ state: "failed" });
    expect(
      await saveFromApp(
        { type: "save-file", id: 2, name: "estate.svg", data: "<svg/>", encoding: "utf8" },
        save,
      ),
    ).toEqual({ type: "save-reply", id: 2, state: "cancelled" });
  });
});
