import { describe, expect, it, vi } from "vitest";
import { chatHandler } from "../src/chat";

/**
 * Beta.28.1 (the review's nit): `/verify <repo> --write` that left rejected facts out (exit 3)
 * wrote the rest: the chat says it applied, and offers to send those facts back to the
 * assistant, never that nothing was written.
 */
vi.mock("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    fire() {}
  },
  window: {},
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: <T>(_k: string, f: T) => f }),
  },
  lm: { selectChatModels: async () => [] },
}));

const said = async (code: number) => {
  const md: string[] = [];
  const buttons: string[] = [];
  const stream = {
    markdown: (t: string) => void md.push(t),
    button: (b: { title: string }) => void buttons.push(b.title),
    progress: () => undefined,
  };
  const svc = {
    root: "/metarepo",
    cli: () => async (args: string[]) =>
      args[0] === "verify"
        ? {
            code,
            stdout:
              "Applied to forge-ledger with 1 fact left out (rejected; none was in the catalog before):\n  left out: e-x (claim-not-on-line): fix it in facts/forge-ledger.jsonl, reading src/A.java:3 again\n",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" },
  };
  const handler = chatHandler(svc as never);
  await handler(
    { command: "verify", prompt: "forge-ledger --write", references: [] } as never,
    { history: [] } as never,
    stream as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
  );
  return { md: md.join("\n"), buttons };
};

describe("/verify --write that left facts out", () => {
  it("says it applied and offers to send the left-out facts back", async () => {
    const r = await said(3);
    expect(r.md).toMatch(
      /Applied: the kept facts are in the catalog; the facts left out are listed above/,
    );
    expect(r.buttons).toEqual(["Send the left-out facts back to the assistant"]);
  });
  it("a failure still offers the rejected facts back, and says nothing applied", async () => {
    const r = await said(1);
    expect(r.md).not.toMatch(/^Applied:/m);
    expect(r.buttons).toEqual(["Send the rejected facts back to the assistant"]);
  });
});
