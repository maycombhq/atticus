import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import {
  addHistory,
  changeNamed,
  cutText,
  historyEntry,
  listHistory,
  maskSecrets,
  pairTurns,
  readHistory,
  recordingOf,
} from "../src/history.js";
import { historyAddCli, historyCli, historyShowCli } from "../src/history-commands.js";
import { main } from "../src/main.js";

/**
 * ADR 0110: the prompt and response history. What a person types to their assistant in a
 * metarepo and what it answered, one record per line in .atticus/history/<yyyy-mm>.jsonl, kept
 * on this machine; `atticus history add` writes it from stdin, `atticus history` and `history
 * show` read it. Invented Forge data only (fixtures/history).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/history");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

/** A metarepo with two changes, and the fixtures' history when asked. */
async function metarepo(o: { history?: boolean; runtime?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-history-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    o.runtime ?? "schemaVersion: 1\nassistants:\n  allowed: [copilot]\n  default: copilot\n",
    "utf8",
  );
  for (const id of ["add-transfer-limit", "refunds-through-northwind-pay"]) {
    await mkdir(join(root, "openspec", "changes", id), { recursive: true });
    await writeFile(join(root, "openspec", "changes", id, "change.yaml"), `id: ${id}\n`, "utf8");
  }
  if (o.history) {
    await mkdir(join(root, ".atticus", "history"), { recursive: true });
    for (const f of ["2026-09.jsonl", "2026-10.jsonl"])
      await copyFile(join(FIXTURES, f), join(root, ".atticus", "history", f));
  }
  return root;
}

const at = new Date("2026-10-23T11:00:05.000Z");

describe("a record's text", () => {
  it("is cut at 64 KB on a character, and says how big it was", () => {
    const small = cutText("Which repos call forge-ledger?");
    expect(small).toEqual({ text: "Which repos call forge-ledger?", size: 30, truncated: false });
    const big = "é".repeat(40000); // 80,000 bytes
    const cut = cutText(big);
    expect(cut.truncated).toBe(true);
    expect(cut.size).toBe(80000);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(Api.HISTORY_TEXT_MAX_BYTES);
    expect(cut.text.endsWith("é")).toBe(true);
  });

  it("has what looks like a secret masked, and says so", () => {
    expect(maskSecrets("Call forge-ledger with token=abc123def456")).toEqual({
      text: "Call forge-ledger with token=***",
      masked: true,
    });
    expect(maskSecrets("Which repos call forge-ledger?")).toEqual({
      text: "Which repos call forge-ledger?",
      masked: false,
    });
    // A pasted blob of 90,000 key characters, judged by the same rule without the slow look-ahead.
    expect(maskSecrets(`key ${"aB3".repeat(30000)} end`)).toEqual({
      text: "key *** end",
      masked: true,
    });
    const plain = "x".repeat(90000);
    expect(maskSecrets(`log ${plain}`)).toEqual({ text: `log ${plain}`, masked: false });
  });

  it("names a change only when exactly one of the metarepo's changes is in it", () => {
    const ids = ["add-transfer-limit", "refunds-through-northwind-pay", "add-transfer"];
    expect(changeNamed("/atticus-needs add-transfer-limit", ids)).toBe("add-transfer-limit");
    expect(changeNamed("Compare add-transfer-limit and refunds-through-northwind-pay", ids)).toBe(
      undefined,
    );
    expect(changeNamed("not-add-transfer-limit-at-all", ids)).toBe(undefined);
    expect(changeNamed("Which repos call forge-ledger?", ids)).toBe(undefined);
  });
});

describe("atticus history add", () => {
  it("appends one record to this month's file, with its change, command and size", async () => {
    const root = await metarepo();
    const r = await addHistory(root, {
      surface: "claude-code",
      kind: "prompt",
      session: "5f1d7c0e",
      text: "/atticus-needs add-transfer-limit",
      now: at,
      random: () => "abcdef",
    });
    expect(r).toEqual({
      record: {
        id: "h-20261023110005-abcdef",
        at: "2026-10-23T11:00:05.000Z",
        surface: "claude-code",
        session: "5f1d7c0e",
        kind: "prompt",
        text: "/atticus-needs add-transfer-limit",
        size: 33,
        change: "add-transfer-limit",
        command: "/atticus-needs",
      },
    });
    const lines = (await readFile(join(root, ".atticus/history/2026-10.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([r.record]);
    // Kept out of Git with the machine's other files.
    expect(await readFile(join(root, ".atticus/.gitignore"), "utf8")).toMatch(/^history\/$/m);
  });

  it("takes the change from the branch change/<id> when the text names none", async () => {
    const root = await metarepo();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/change/add-transfer-limit\n");
    const r = await addHistory(root, {
      surface: "vscode",
      kind: "response",
      session: "s1",
      command: "/stories",
      text: "Done: 4 stories written.",
      now: at,
      random: () => "000001",
    });
    expect(r.record).toMatchObject({ change: "add-transfer-limit", command: "/stories" });
  });

  it("keeps a reply told twice in a row once, and the same words after another prompt again", async () => {
    const root = await metarepo();
    const add = (kind: "prompt" | "response", text: string, n: number) =>
      addHistory(root, {
        surface: "claude-code",
        kind,
        session: "5f1d7c0e",
        text,
        now: new Date(at.getTime() + n * 1000),
        random: () => `00000${n}`,
      });
    await add("prompt", "Scan forge-ledger", 1);
    await add("response", "Done.", 2);
    const again = await add("response", "Done.", 3);
    expect(again.record!.id).toBe("h-20261023110007-000002");
    await add("prompt", "And forge-web?", 4);
    await add("response", "Done.", 5);
    expect((await readHistory(root)).map((r) => r.kind)).toEqual([
      "prompt",
      "response",
      "prompt",
      "response",
    ]);
  });

  it("writes nothing when the org pack or this machine turned recording off", async () => {
    const off = await metarepo({
      runtime:
        "schemaVersion: 1\nassistants:\n  allowed: [copilot]\n  default: copilot\nhistory:\n  record: false\n",
    });
    expect(await recordingOf(off)).toEqual({ on: false, offBy: "org-pack" });
    const c = capture();
    expect(
      await historyAddCli(off, { surface: "cli", kind: "prompt" }, async () => "hello", c.io),
    ).toBe(0);
    expect(c.out).toEqual([
      "Recording is off (runtime.yaml history.record is false); nothing was recorded.",
    ]);
    expect(await readdir(join(off, ".atticus")).catch(() => [])).not.toContain("history");

    const mine = await metarepo();
    const m = capture();
    expect(await main(["history", "off", "--root", mine], m.io)).toBe(0);
    expect(await recordingOf(mine)).toEqual({ on: false, offBy: "local" });
    expect(await readFile(join(mine, ".atticus/me.yaml"), "utf8")).toMatch(/record: false/);
    expect(await main(["history", "on", "--root", mine], m.io)).toBe(0);
    expect(await recordingOf(mine)).toEqual({ on: true });
  });

  it("refuses a surface or kind it doesn't know, and records nothing empty", async () => {
    const root = await metarepo();
    const c = capture();
    expect(
      await historyAddCli(root, { surface: "intellij", kind: "prompt" }, async () => "x", c.io),
    ).toBe(2);
    expect(c.err[0]).toMatch(/--surface is claude-code, vscode or cli/);
    expect(
      await historyAddCli(root, { surface: "cli", kind: "answer" }, async () => "x", c.io),
    ).toBe(2);
    expect(c.err[1]).toMatch(/--kind is prompt or response/);
    const e = capture();
    expect(
      await historyAddCli(root, { surface: "cli", kind: "prompt" }, async () => "  \n", e.io),
    ).toBe(0);
    expect(e.out).toEqual(["Nothing to record: the text is empty."]);
    expect((await readHistory(root)).length).toBe(0);
  });

  it("marks a cut or masked record", async () => {
    const root = await metarepo();
    const c = capture();
    await historyAddCli(
      root,
      { surface: "cli", kind: "prompt", session: "s2" },
      async () => `password: hunter2hunter2 ${"x".repeat(70000)}`,
      c.io,
    );
    const [r] = await readHistory(root);
    expect(r).toMatchObject({ truncated: true, masked: true, session: "s2" });
    expect(r!.text.startsWith("password: ***")).toBe(true);
    expect(c.out[0]).toMatch(
      /^Recorded h-\d{14}-[0-9a-f]{6} \(prompt, 70\d+ bytes; cut at 64 KB; parts that looked like a secret were masked\)\.$/,
    );
  });
});

describe("atticus history", () => {
  it("reads every month's file, oldest first, and skips a line that isn't a record", async () => {
    const root = await metarepo({ history: true });
    const all = await readHistory(root);
    expect(all.map((r) => r.id)).toEqual([
      "h-20260930160000-0c0c0c",
      "h-20260930160200-0d0d0d",
      "h-20261023091500-111111",
      "h-20261023091610-222222",
      "h-20261023101500-a1b2c3",
      "h-20261023101530-d4e5f6",
      "h-20261023102000-0a0b0c",
    ]);
  });

  it("pairs each prompt with the response that followed it in the same session, newest first", async () => {
    const turns = pairTurns(await readHistory(await metarepo({ history: true })));
    expect(turns.map((t) => [t.prompt?.id, t.response?.id, t.change])).toEqual([
      ["h-20261023102000-0a0b0c", undefined, undefined],
      ["h-20261023101500-a1b2c3", "h-20261023101530-d4e5f6", "add-transfer-limit"],
      ["h-20261023091500-111111", "h-20261023091610-222222", "add-transfer-limit"],
      ["h-20260930160000-0c0c0c", "h-20260930160200-0d0d0d", "refunds-through-northwind-pay"],
    ]);
  });

  it("filters by change, session and words, and limits the turns", async () => {
    const root = await metarepo({ history: true });
    const ids = async (o: Parameters<typeof listHistory>[1]) =>
      (await listHistory(root, o)).turns.map((t) => t.prompt?.id);
    expect(await ids({ change: "add-transfer-limit" })).toEqual([
      "h-20261023101500-a1b2c3",
      "h-20261023091500-111111",
    ]);
    expect(await ids({ session: "9e9e9e9e" })).toEqual(["h-20260930160000-0c0c0c"]);
    expect(await ids({ filter: "NORTHWIND firewall" })).toEqual(["h-20261023101500-a1b2c3"]);
    const limited = await listHistory(root, { limit: 1 });
    expect(limited.turns).toHaveLength(1);
    expect(limited.total).toBe(4);
    expect(limited.recording).toEqual({ on: true });
  });

  it("prints the turns by session, and JSON for an editor", async () => {
    const root = await metarepo({ history: true });
    const c = capture();
    expect(await historyCli(root, { change: "add-transfer-limit" }, c.io)).toBe(0);
    expect(c.out).toEqual([
      "Recording is on: prompts and responses in this metarepo are kept in .atticus/history/, on this machine only.",
      "",
      "Session 5f1d7c0e (claude-code)",
      "  2026-10-23 10:15  you: /atticus-needs add-transfer-limit  [add-transfer-limit]  h-20261023101500-a1b2c3",
      "                    reply: add-transfer-limit needs a firewall rule to Northwind Pay and a Kafka topic for the refusals.  h-20261023101530-d4e5f6",
      "",
      "Session vscode-20261023091500-7a7a7a (vscode)",
      "  2026-10-23 09:15  you: @atticus /stories add-transfer-limit  [add-transfer-limit]  h-20261023091500-111111",
      "                    reply: Running `atticus plan stories add-transfer-limit --handoff` with Copilot's model. …  h-20261023091610-222222",
    ]);
    const j = capture();
    expect(await main(["history", "--session", "5f1d7c0e", "--json", "--root", root], j.io)).toBe(
      0,
    );
    const list = Api.HistoryList.parse(JSON.parse(j.out.join("\n")));
    expect(list.turns).toHaveLength(2);
    expect(list.turns[0]!.response).toBeUndefined();
  });

  it("says when there is nothing yet, and what is and isn't recorded", async () => {
    const c = capture();
    expect(await historyCli(await metarepo(), {}, c.io)).toBe(0);
    expect(c.out.at(-1)).toBe(
      "No prompts yet. Claude Code's (with the Atticus plugin) and @atticus's in VS Code are recorded here; Copilot's other chats can't be.",
    );
  });

  it("shows one record with its pair, and says when there is none", async () => {
    const root = await metarepo({ history: true });
    expect(await historyEntry(root, "h-20261023101530-d4e5f6")).toMatchObject({
      record: { kind: "response" },
      pair: { id: "h-20261023101500-a1b2c3" },
    });
    const c = capture();
    expect(await historyShowCli(root, "h-20260930160200-0d0d0d", {}, c.io)).toBe(0);
    expect(c.out).toEqual([
      "h-20260930160200-0d0d0d: response, claude-code, session 9e9e9e9e, 2026-09-30 16:02, 131 bytes",
      "Parts that looked like a secret were masked (***) before it was kept.",
      "  The brief is in openspec/changes/refunds-through-northwind-pay/brief.md. The sandbox key I used was api_key=***.",
      "In answer to h-20260930160000-0c0c0c:",
      "  Draft the brief for refunds-through-northwind-pay",
    ]);
    const bad = capture();
    expect(await historyShowCli(root, "h-20991231000000-ffffff", {}, bad.io)).toBe(2);
    expect(bad.err).toEqual([
      "There is no record h-20991231000000-ffffff. atticus history lists them.",
    ]);
    expect(await historyShowCli(root, "../../etc/passwd", {}, bad.io)).toBe(2);
  });
});
