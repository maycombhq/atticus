import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Api,
  API_VERSION,
  DEFAULT_RUNTIME,
  ensureLocalIgnore,
  LOCAL_ONLY,
  openApiDocument,
  Runtime,
} from "../src/index.js";

/**
 * ADR 0110: the prompt and response history. The API's two read routes (additive, 2.10.0), the
 * record's shape, runtime.yaml's optional history.record, and history/ kept out of Git with the
 * machine's other local files.
 */

const doc = openApiDocument() as {
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, unknown> };
};

const record = {
  id: "h-20261023101500-a1b2c3",
  at: "2026-10-23T10:15:00.000Z",
  surface: "claude-code",
  session: "5f1d7c0e",
  kind: "prompt",
  text: "/atticus-needs add-transfer-limit",
  size: 33,
  change: "add-transfer-limit",
  command: "/atticus-needs",
};

describe("the prompt history API (ADR 0110)", () => {
  it("is in the OpenAPI document, from API 2.10.0", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major === 2 && minor! >= 10).toBe(true);
    expect(doc.paths["/api/history"]!.get!.operationId).toBe("listPromptHistory");
    expect(doc.paths["/api/history/{historyId}"]!.get!.operationId).toBe("getPromptHistoryRecord");
    for (const s of ["HistoryList", "HistoryEntry"])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("takes a record with its id, surface, session, kind, text, size, change and command", () => {
    expect(Api.HistoryRecord.parse(record)).toEqual(record);
    expect(Api.HistoryRecord.safeParse({ ...record, surface: "intellij" }).success).toBe(false);
    expect(Api.HistoryRecord.safeParse({ ...record, kind: "answer" }).success).toBe(false);
    expect(Api.HistoryRecord.safeParse({ ...record, id: "../../etc" }).success).toBe(false);
    expect(Api.HISTORY_TEXT_MAX_BYTES).toBe(65536);
  });

  it("pairs a prompt with its response in a turn, and says whether recording is on", () => {
    const list = Api.HistoryList.parse({
      turns: [
        {
          session: "5f1d7c0e",
          surface: "claude-code",
          at: record.at,
          change: "add-transfer-limit",
          prompt: record,
          response: { ...record, id: "h-20261023101530-d4e5f6", kind: "response", text: "Done." },
        },
      ],
      total: 1,
      recording: { on: false, offBy: "org-pack" },
    });
    expect(list.turns[0]!.response!.kind).toBe("response");
  });
});

describe("history in runtime.yaml and on this machine (ADR 0110)", () => {
  const base = { schemaVersion: 1, assistants: { allowed: ["copilot"], default: "copilot" } };

  it("is optional in runtime.yaml, so existing packs and the defaults are unchanged", () => {
    expect(Runtime.parse(base).history).toBeUndefined();
    expect(Runtime.parse(DEFAULT_RUNTIME).history).toBeUndefined();
    expect(Runtime.parse({ ...base, history: { record: false } }).history).toEqual({
      record: false,
    });
    expect(Runtime.parse({ ...base, history: {} }).history).toEqual({ record: true });
    expect(Runtime.safeParse({ ...base, history: { record: "no" } }).success).toBe(false);
    expect(Runtime.safeParse({ ...base, history: { keep: 3 } }).success).toBe(false);
  });

  it("keeps .atticus/history/ out of Git with the machine's other files", async () => {
    expect(LOCAL_ONLY).toContain("history/");
    const root = await mkdtemp(join(tmpdir(), "atticus-history-"));
    await ensureLocalIgnore(root);
    expect(await readFile(join(root, ".atticus/.gitignore"), "utf8")).toMatch(/^history\/$/m);
  });
});
