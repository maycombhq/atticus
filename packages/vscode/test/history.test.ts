import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRunner } from "../src/cli";
import {
  ChatSessions,
  HISTORY_HASH,
  promptText,
  recordChat,
  recordingStream,
} from "../src/history";
import type { Cli } from "../src/types";

/**
 * ADR 0110: every @atticus request and the reply the extension streamed go to the prompt history
 * through `atticus history add`, the text on stdin; the extension writes no file itself. Copilot's
 * other chats aren't reachable from an extension, so they aren't recorded.
 */

const BIN = join(__dirname, "../../cli/dist/bin.js");

describe("an @atticus request in the history", () => {
  it("is written as the person typed it, with its slash command", () => {
    expect(promptText({ command: "stories", prompt: "add-transfer-limit" })).toBe(
      "@atticus /stories add-transfer-limit",
    );
    expect(promptText({ prompt: "  what next?  " })).toBe("@atticus what next?");
    expect(promptText({ command: "next", prompt: "" })).toBe("@atticus /next");
  });

  it("keeps one session while a chat goes on, and starts another with a new chat", () => {
    let n = 0;
    const s = new ChatSessions(
      () => new Date("2026-10-23T09:15:00Z"),
      () => `00000${++n}`,
    );
    const first = { command: "stories", prompt: "add-transfer-limit" };
    const a = s.sessionFor(first, []);
    expect(a).toBe("vscode-20261023091500-000001");
    const turns = [{ command: "stories", prompt: "add-transfer-limit", participant: "atticus" }];
    expect(s.sessionFor({ prompt: "and the next?" }, turns)).toBe(a);
    expect(s.sessionFor({ prompt: "and then?" }, [...turns, { response: [] }])).toBe(a);
    // A new chat: no history.
    expect(s.sessionFor({ command: "next", prompt: "" }, [])).toBe("vscode-20261023091500-000002");
    // The first chat goes on.
    expect(s.sessionFor({ prompt: "once more" }, turns)).toBe(a);
  });

  it("collects what the reply streamed, and passes every call on", () => {
    const seen: string[] = [];
    const stream = {
      markdown: (v: string | { value: string }) =>
        seen.push(`md:${typeof v === "string" ? v : v.value}`),
      progress: (v: string) => seen.push(`progress:${v}`),
      button: (b: { title: string }) => seen.push(`button:${b.title}`),
    };
    const r = recordingStream(stream);
    r.stream.progress("Reading the metarepo (atticus next)...");
    r.stream.markdown("**Next: survey forge-ledger**");
    r.stream.button({ title: "Run it" });
    r.stream.markdown({ value: "\n1 more after this one." });
    expect(seen).toEqual([
      "progress:Reading the metarepo (atticus next)...",
      "md:**Next: survey forge-ledger**",
      "button:Run it",
      "md:\n1 more after this one.",
    ]);
    expect(r.text()).toBe("**Next: survey forge-ledger**\n1 more after this one.");
  });

  it("records the prompt, then the response, through atticus history add", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const cli: Cli = async (args, _token, input) => {
      calls.push({ args, ...(input !== undefined ? { input } : {}) });
      return { code: 0, stdout: "", stderr: "", cancelled: false };
    };
    await recordChat(cli, "C:/forge-meta", {
      session: "vscode-20261023091500-7a7a7a",
      command: "/stories",
      prompt: "@atticus /stories add-transfer-limit",
      response: Promise.resolve("**Done: 4 stories written.**"),
    });
    const head = ["history", "add", "--surface", "vscode", "--kind"];
    const tail = ["--session", "vscode-20261023091500-7a7a7a", "--command", "/stories"];
    expect(calls).toEqual([
      {
        args: [...head, "prompt", ...tail, "--root", "C:/forge-meta"],
        input: "@atticus /stories add-transfer-limit",
      },
      {
        args: [...head, "response", ...tail, "--root", "C:/forge-meta"],
        input: "**Done: 4 stories written.**",
      },
    ]);
  });

  it("records nothing empty, and never fails the chat when the command line can't", async () => {
    const calls: string[][] = [];
    const cli: Cli = async (args) => {
      calls.push(args);
      throw new Error("atticus isn't installed");
    };
    await expect(
      recordChat(cli, "C:/forge-meta", {
        session: "s",
        prompt: "@atticus /next",
        response: Promise.resolve("   "),
      }),
    ).resolves.toBeUndefined();
    expect(calls.map((a) => a[5])).toEqual(["prompt"]);
  });

  it("opens the app's Prompt history screen", () => {
    expect(HISTORY_HASH).toBe("#/history");
  });
});

describe("the command line's stdin, from the extension", () => {
  it("gives a command its input, and closes stdin for one that gets none", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-vscode-history-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(
      join(root, "org-pack", "runtime.yaml"),
      "schemaVersion: 1\nassistants:\n  allowed: [copilot]\n  default: copilot\n",
    );
    const cli = cliRunner({ atticusPath: BIN, cwd: root });
    const r = await cli(
      [
        "history",
        "add",
        "--surface",
        "vscode",
        "--kind",
        "prompt",
        "--session",
        "s1",
        "--command",
        "/stories",
        "--root",
        root,
      ],
      undefined,
      "@atticus /stories add-transfer-limit",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Recorded h-\d{14}-[0-9a-f]{6} \(prompt, 36 bytes\)\./);
    const [file] = await import("node:fs/promises").then((f) =>
      f.readdir(join(root, ".atticus", "history")),
    );
    const rec = JSON.parse(
      (await readFile(join(root, ".atticus", "history", file!), "utf8")).trim(),
    ) as { text: string; surface: string; command: string };
    expect(rec).toMatchObject({
      text: "@atticus /stories add-transfer-limit",
      surface: "vscode",
      command: "/stories",
    });
    // No input: stdin is closed at once, so a command that reads it doesn't wait.
    const none = await cli([
      "history",
      "add",
      "--surface",
      "vscode",
      "--kind",
      "prompt",
      "--root",
      root,
    ]);
    expect(none.stdout.trim()).toBe("Nothing to record: the text is empty.");
  }, 30000);
});
