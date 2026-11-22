import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * The review of b30/review2-fixes: when the AI runtime can't be made for `atticus review` (a
 * runtime.yaml that doesn't read, a provider that isn't set up), the note is its first line, as
 * a naysayer run's failure is, never a stack of lines, and the review exits 0. The runtime is
 * mocked: no model and no network (CLAUDE.md rule 5). Invented Forge names.
 */

vi.mock("@maycombhq/ai", async () => ({
  ...(await vi.importActual<object>("@maycombhq/ai")),
  runtimeForCli: () =>
    Promise.reject(new Error("runtime.yaml doesn't read\n  at adapters.model: unknown type")),
}));

const { reviewCommand, REVIEW_WORDS } = await import("../src/review-commands.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const NAYSAYER = "application-architect-naysayer";

describe("atticus review when the AI runtime can't be made", () => {
  it("notes the first line of why, and exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-cli-review-rt-"));
    await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, "openspec/changes"), { recursive: true });
    await mkdir(join(root, "org-pack/agents"), { recursive: true });
    await writeFile(
      join(root, "org-pack/agents", `${NAYSAYER}.md`),
      readFileSync(join(HERE, "../../assistant-files/starter/agents", `${NAYSAYER}.md`), "utf8"),
    );
    const file = join(root, "requirements.md");
    await writeFile(file, "# Shipped orders\n\n## Application architect\n\nThe ledger books it.\n");
    const out: string[] = [];
    const code = await reviewCommand(
      root,
      file,
      {},
      {
        out: (l) => out.push(l),
        err: (l) => out.push(l),
      },
    );
    expect(code).toBe(0);
    expect(out).toContain(REVIEW_WORDS.failed("runtime.yaml doesn't read"));
    expect(out.join("\n")).not.toContain("unknown type");
  }, 60_000);
});
