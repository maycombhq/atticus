import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { buildDigest } from "../src/digest-commands.js";
import { main } from "../src/main.js";

/**
 * Watch a change (WP7.5): follow it without being on it. Kept in the person's own
 * .atticus/me.yaml; the digest and atticus watch say how each watched change is doing.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CHANGE = "return-order-time";

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-watch-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIXTURES, "stages/small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { quiet: true },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus watch (WP7.5)", () => {
  it("watches a change, says how it is doing, lists what is watched, and stops", async () => {
    const root = await estate();
    expect((await run(["watch", "--root", root])).out).toMatch(/You watch no change/);
    const w = await run(["watch", CHANGE, "--root", root]);
    expect(w.code).toBe(0);
    expect(w.out).toContain(`You watch ${CHANGE}`);
    expect(w.out).toContain(`${CHANGE}: in `);
    expect(w.out).toContain("Next: ");
    expect(await readFile(join(root, ".atticus", "me.yaml"), "utf8")).toContain(CHANGE);
    const list = await run(["watch", "--json", "--root", root]);
    expect(JSON.parse(list.out)).toMatchObject({ watching: [CHANGE] });
    const digest = await buildDigest(root, "someone-else");
    expect(digest.watching).toHaveLength(1);
    expect(digest.lines).toContain("Changes you watch:");
    expect(digest.title).toBe("Atticus: nothing waits on you");
    expect((await run(["watch", CHANGE, "--off", "--root", root])).out).toContain(
      "no longer watch",
    );
    expect((await run(["watch", "no-such-change", "--root", root])).code).toBe(1);
  });
});
