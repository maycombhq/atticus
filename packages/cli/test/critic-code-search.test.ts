import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { criticCodeSearch } from "../src/code-tools.js";

/**
 * W1: the code search the command line gives the critic, to check a name a lens's finding says
 * is missing. A name is in the code by its declaration in a source file (or as a file), never by
 * a word in a document (ADR 0118 addendum). Invented Forge Chat repo.
 */

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-critic-search-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, "workspace", rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  }
  return root;
}

describe("the critic's code search (W1)", () => {
  it("finds a class and a React component by their declarations, and a file by its name", async () => {
    const root = await workspace({
      "forge-chat/api/src/main/java/forge/chat/MessageGuard.java":
        "package forge.chat;\n\npublic class MessageGuard {\n  boolean ownMessage() { return true; }\n}\n",
      "forge-chat/web/src/surfaces/chats/Thread.jsx":
        "export default function Thread() {\n  return <button>Delete</button>;\n}\n",
      "forge-chat/docs/PLAN.md": "We will add a ReactionPicker later.\n",
    });
    const found = await criticCodeSearch(root, [
      "MessageGuard",
      "Thread",
      "Thread.jsx",
      "ReactionPicker",
    ]);
    expect(found.get("MessageGuard")).toBe(
      "forge-chat:api/src/main/java/forge/chat/MessageGuard.java:3",
    );
    expect(found.get("Thread")).toBe("forge-chat:web/src/surfaces/chats/Thread.jsx:1");
    expect(found.get("Thread.jsx")).toBe("forge-chat:web/src/surfaces/chats/Thread.jsx");
    // Only a plan in docs/ names it: not code.
    expect(found.has("ReactionPicker")).toBe(false);
  });
});
