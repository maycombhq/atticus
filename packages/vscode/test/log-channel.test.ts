import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "../src/app-panel";
import { guardChannel, hideInLog, maskSecrets, timeOf } from "../src/log-channel";

/** A stand-in for VS Code's output channel: what it was given, line by line. */
const fakeChannel = () => {
  const text: string[] = [];
  return {
    text,
    name: "Atticus",
    append: (v: string) => text.push(v),
    appendLine: (v: string) => text.push(v),
    show: () => undefined,
  };
};

async function fakeAtticus(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-fake-ui-"));
  const f = join(dir, "bin.js");
  await writeFile(f, body);
  return f;
}

describe("the Atticus output channel", () => {
  it("starts each line with the time, to the millisecond", () => {
    const ch = fakeChannel();
    const log = guardChannel(ch, () => new Date(2026, 9, 27, 9, 5, 7, 42));
    log.appendLine("> atticus ui --port 0");
    log.appendLine("one\ntwo");
    expect(ch.text).toEqual([
      "[09:05:07.042] > atticus ui --port 0",
      "[09:05:07.042] one\n[09:05:07.042] two",
    ]);
    expect(timeOf(new Date(2026, 0, 1, 23, 59, 59, 999))).toBe("23:59:59.999");
    // The channel's other methods are the channel's own.
    expect(log.name).toBe("Atticus");
    expect(() => log.show()).not.toThrow();
  });

  it("never writes the session token, said by the app or given to it", () => {
    hideInLog("tok-given-by-the-extension-0123456789");
    expect(maskSecrets("For assistants and scripts, the session token is abc123")).toBe(
      "For assistants and scripts, the session token is (hidden)",
    );
    expect(maskSecrets("x tok-given-by-the-extension-0123456789 y")).toBe("x (hidden) y");
  });
});

describe("the app's session token stays out of the channel", { timeout: 60_000 }, () => {
  it("gives the app its token, which this Atticus never prints with --embed", async () => {
    // The app as this release runs it: it takes the editor's token and says it isn't printed.
    const bin = await fakeAtticus(
      `console.log("Atticus is running at http://127.0.0.1:4997 (Ctrl+C stops it).");
       console.log("The session token isn't printed: the editor that started the app has it.");
       console.log("debug " + process.env.ATTICUS_UI_TOKEN);
       setInterval(() => {}, 1000);`,
    );
    const ch = fakeChannel();
    const log = guardChannel(ch);
    const app = await startApp({ atticusPath: bin, cwd: tmpdir(), log: (l) => log.appendLine(l) });
    expect(app.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await new Promise((r) => setTimeout(r, 200));
    const stopped = new Promise<void>((r) => app.onExit(() => r()));
    app.stop();
    await stopped;
    const all = ch.text.join("\n");
    expect(all).toContain("debug (hidden)");
    expect(all).not.toContain(app.token);
  });

  it("masks the token an older atticus prints, and still uses it", async () => {
    const bin = await fakeAtticus(
      `console.log("Atticus is running at http://127.0.0.1:4996 (Ctrl+C stops it).");
       console.log("For assistants and scripts, the session token is tok-older-cli-printed-it");
       setInterval(() => {}, 1000);`,
    );
    const ch = fakeChannel();
    const log = guardChannel(ch);
    const app = await startApp({ atticusPath: bin, cwd: tmpdir(), log: (l) => log.appendLine(l) });
    expect(app.token).toBe("tok-older-cli-printed-it");
    const stopped = new Promise<void>((r) => app.onExit(() => r()));
    app.stop();
    await stopped;
    expect(ch.text.join("\n")).not.toContain("tok-older-cli-printed-it");
  });
});
