import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appUrlFrom, diagramHash, panelHtml, startApp, stopChild } from "../src/app-panel";
import { commandText } from "../src/cli";

/** A stand-in for `atticus ui`: a .js file the extension runs with node. */
async function fakeAtticus(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-fake-ui-"));
  const f = join(dir, "bin.js");
  await writeFile(f, body);
  return f;
}

describe("the link @atticus /diagram opens (ADR 0091; the Map's canvas since Phase D)", () => {
  it("opens a repo by its name, as the estate names it", () => {
    expect(diagramHash("nadiengine")).toBe("#/canvas?node=repo%3Anadiengine");
    expect(diagramHash("Forge-Notes")).toBe("#/canvas?node=repo%3Aforge-notes");
  });

  it("opens a flow of a repo on the Flows screen, by its id or by words to find it", () => {
    expect(diagramHash("nadiengine nadiengine-api.save-horoscope")).toBe(
      "#/flows?repo=nadiengine&flow=nadiengine-api.save-horoscope",
    );
    expect(diagramHash("nadiengine save horoscope")).toBe(
      "#/flows?repo=nadiengine&q=save%20horoscope",
    );
    expect(diagramHash("Forge-Web flows")).toBe("#/flows?repo=forge-web");
  });

  it("takes a node id as it is, and the estate when nothing is named", () => {
    expect(diagramHash("system:payments")).toBe("#/canvas?node=system%3Apayments");
    expect(diagramHash("  ")).toBe("#/canvas");
  });
});

describe("the app's address", () => {
  it("is read from what atticus ui prints", () => {
    expect(appUrlFrom("Atticus is running at http://127.0.0.1:53211 (Ctrl+C stops it).\n")).toBe(
      "http://127.0.0.1:53211",
    );
    expect(appUrlFrom("You are pat.\n")).toBeUndefined();
  });
});

describe("the panel's page", () => {
  it("frames the app from 127.0.0.1 only, and runs no script of its own", () => {
    const html = panelHtml("http://127.0.0.1:53211/#/architecture?node=repo%3Anadiengine");
    expect(html).toContain(
      '<iframe src="http://127.0.0.1:53211/#/architecture?node=repo%3Anadiengine"',
    );
    expect(html).toMatch(/default-src 'none'/);
    expect(html).toMatch(/frame-src http:\/\/127\.0\.0\.1:\*/);
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('title="Atticus"');
  });

  it("escapes the address it frames", () => {
    expect(panelHtml('http://127.0.0.1:1/#"><b>')).toContain(
      'src="http://127.0.0.1:1/#&quot;>&lt;b>"',
    );
  });
});

describe("starting the app for the panel", { timeout: 60_000 }, () => {
  it("starts atticus ui on a free port for a VS Code panel, gives its address, and stops it", async () => {
    const bin = await fakeAtticus(
      `console.log("Atticus is running at http://127.0.0.1:4999 (Ctrl+C stops it).");
       console.log("For assistants and scripts, the session token is tok-9");
       console.log("args " + JSON.stringify(process.argv.slice(2)));
       setInterval(() => {}, 1000);`,
    );
    const lines: string[] = [];
    const app = await startApp({ atticusPath: bin, cwd: tmpdir(), log: (l) => lines.push(l) });
    expect(app.url).toBe("http://127.0.0.1:4999");
    expect(app.token).toBe("tok-9");
    expect(lines[0]).toBe(
      `> ${commandText(["ui", "--port", "0", "--embed", "vscode", "--root", tmpdir()])}`,
    );
    const stopped = new Promise<void>((r) => app.onExit(() => r()));
    app.stop();
    await stopped;
  });

  it("starts it with --full when the setting atticus.fullUi asks for every page (Phase D)", async () => {
    const bin = await fakeAtticus(
      `console.log("Atticus is running at http://127.0.0.1:4998 (Ctrl+C stops it).");
       console.log("For assistants and scripts, the session token is tok-8");
       setInterval(() => {}, 1000);`,
    );
    const lines: string[] = [];
    const app = await startApp(
      { atticusPath: bin, cwd: tmpdir(), log: (l) => lines.push(l) },
      { full: true },
    );
    expect(lines[0]).toBe(
      `> ${commandText(["ui", "--port", "0", "--embed", "vscode", "--full", "--root", tmpdir()])}`,
    );
    const stopped = new Promise<void>((r) => app.onExit(() => r()));
    app.stop();
    await stopped;
  });

  it("says why when atticus ui stops before it serves", async () => {
    const bin = await fakeAtticus(
      `console.error("--embed takes vscode (the app in a VS Code panel), not x."); process.exit(2);`,
    );
    await expect(startApp({ atticusPath: bin, cwd: tmpdir() })).rejects.toThrow(
      /--embed takes vscode/,
    );
  });
});

describe("stopping the app", { timeout: 60_000 }, () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const closed = (c: ReturnType<typeof spawn>) =>
    new Promise<number | null>((r) => c.once("close", (code) => r(code)));

  it("closes the app's stdin, which atticus ui --embed vscode takes as the sign to stop", async () => {
    const c = spawn(process.execPath, [
      "-e",
      `process.stdin.on("end", () => process.exit(7)); process.stdin.resume(); setInterval(() => {}, 1000);`,
    ]);
    const code = closed(c);
    stopChild(c, 30_000);
    expect(await code).toBe(7);
  });

  it.skipIf(process.platform !== "win32")(
    "kills the whole tree on Windows, so a server under cmd.exe doesn't outlive the window",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-stop-"));
      const server = join(dir, "server.js");
      await writeFile(server, `console.log("pid " + process.pid); setInterval(() => {}, 1000);`);
      const c = spawn(`"${process.execPath}"`, [`"${server}"`], { shell: true, windowsHide: true });
      const pid = await new Promise<number>((r) =>
        c.stdout!.setEncoding("utf8").on("data", (d: string) => {
          const m = /pid (\d+)/.exec(d);
          if (m) r(Number(m[1]));
        }),
      );
      expect(alive(pid)).toBe(true);
      const code = closed(c);
      stopChild(c);
      await code;
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    },
  );
});
