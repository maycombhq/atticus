import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourcesSync } from "../src/knowledge-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const RED_TEAM = join(HERE, "../../ai/test/fixtures/red-team");

describe("atticus sources sync with ingested-content defences", () => {
  it("prints a high-risk page as a problem, marks a medium one, and exits 1", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-cli-defences-"));
    const root = join(base, "metarepo");
    await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
    await cp(join(FORGE, "inputs/wiki"), join(base, "inputs/wiki"), { recursive: true });
    await cp(
      join(RED_TEAM, "markdown/wiki-hidden-comment.md"),
      join(base, "inputs/wiki/handover.md"),
    );
    await cp(join(RED_TEAM, "markdown/visible-note.md"), join(base, "inputs/wiki/portal-note.md"));
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(await sourcesSync(root, io, {})).toBe(1);
    const text = out.join("\n");
    expect(text).toMatch(/forge-wiki: 5 pages read, 0 skipped/);
    expect(text).toMatch(/ {2}! .*handover\.md is held back from every AI step/);
    expect(text).toMatch(/Flagged .*portal-note\.md: medium risk, Visible instruction-like text/);
    expect(text).not.toMatch(/agrees with the catalog/);
  });
});
