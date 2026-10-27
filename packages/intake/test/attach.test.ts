import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  attachToChange,
  changeInputSources,
  citedParts,
  heldOutInputs,
  readChangeInputs,
} from "../src/index.js";

/** ADR 0113: files attached to one change, read with intake's readers, cited by file and line or page. */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures/attach");
const file = (name: string, from = FIX) => ({
  name,
  bytes: new Uint8Array(readFileSync(join(from, name))),
});
const REL = "openspec/changes/refund-window";
const AT = "2026-10-23T09:00:00Z";

async function changeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atticus-attach-"));
}

describe("attaching files to a change", () => {
  it("copies each file into inputs/, says what it is, and records who and when", async () => {
    const dir = await changeDir();
    const r = await attachToChange(
      dir,
      [file("refund-rules-v1.md"), file("support-thread.eml"), file("refund-form.png")],
      { by: "pat", at: AT },
    );
    expect(r.refused).toEqual([]);
    expect(r.added.map((a) => [a.path, a.kind, a.format, a.read])).toEqual([
      ["inputs/refund-rules-v1.md", "document", "markdown", "text"],
      ["inputs/support-thread.eml", "document", "email", "text"],
      ["inputs/refund-form.png", "image", "image", "needs-reading"],
    ]);
    const index = await readChangeInputs(dir);
    expect(index.files.every((f) => f.addedBy === "pat" && f.addedAt === AT)).toBe(true);
    expect(await readFile(join(dir, "inputs/refund-rules-v1.md"), "utf8")).toBe(
      readFileSync(join(FIX, "refund-rules-v1.md"), "utf8"),
    );
    // The index is a file a person can read in the change's PR.
    const yaml = parse(await readFile(join(dir, "inputs/index.yaml"), "utf8"));
    expect(yaml.schemaVersion).toBe(1);
    expect(yaml.files[0]).toMatchObject({ path: "inputs/refund-rules-v1.md", addedBy: "pat" });
  });

  it("refuses a file already attached, by its bytes, and never takes a file for another's newer version by its name", async () => {
    const dir = await changeDir();
    await attachToChange(dir, [file("refund-rules-v1.md")], { by: "pat", at: AT });
    const again = await attachToChange(
      dir,
      [{ name: "copy.md", bytes: file("refund-rules-v1.md").bytes }, file("refund-rules-v2.md")],
      { by: "sam", at: "2026-10-23T10:00:00Z" },
    );
    expect(again.refused).toEqual([
      { name: "copy.md", why: "It is already attached as inputs/refund-rules-v1.md." },
    ]);
    // Both are kept and both are read: which one replaces which is a person's to say.
    expect(again.added[0]).toMatchObject({ path: "inputs/refund-rules-v2.md", version: "2" });
    expect(again.added[0]!.supersedes).toBeUndefined();
    expect(again.notes.join("\n")).toContain(
      "refund-rules-v2.md has a name like inputs/refund-rules-v1.md's: both are kept, and the steps read both. If it replaces that file, attach it again with --replaces inputs/refund-rules-v1.md.",
    );
    expect((await readChangeInputs(dir)).files.every((f) => !f.supersededBy)).toBe(true);
    // A file whose name says nothing of a version (a .txt beside a .md) is never a replacement.
    const txt = await attachToChange(
      dir,
      [{ name: "refund-rules.txt", bytes: new TextEncoder().encode("Refunds within 14 days.\n") }],
      { by: "sam", at: "2026-10-23T11:00:00Z" },
    );
    expect(txt.added[0]!.supersedes).toBeUndefined();
    expect((await changeInputSources(dir, REL)).map((s) => s.id)).toEqual([
      "inputs/refund-rules-v1.md",
      "inputs/refund-rules-v2.md",
      "inputs/refund-rules.txt",
    ]);
  });

  it("replaces a file only when a person says so, also for a file already attached", async () => {
    const dir = await changeDir();
    await attachToChange(dir, [file("refund-rules-v1.md"), file("refund-rules-v2.md")], {
      by: "pat",
      at: AT,
    });
    // Attached before the person said: the same bytes with --replaces mark it, nothing is copied.
    const said = await attachToChange(dir, [file("refund-rules-v2.md")], {
      by: "pat",
      at: AT,
      replaces: "inputs/refund-rules-v1.md",
    });
    expect(said.refused).toEqual([]);
    expect(said.added[0]).toMatchObject({
      path: "inputs/refund-rules-v2.md",
      supersedes: "inputs/refund-rules-v1.md",
    });
    const index = await readChangeInputs(dir);
    expect(index.files.find((f) => f.path === "inputs/refund-rules-v1.md")?.supersededBy).toBe(
      "inputs/refund-rules-v2.md",
    );
    expect((await changeInputSources(dir, REL)).map((s) => s.id)).toEqual([
      "inputs/refund-rules-v2.md",
    ]);
    // A file that isn't attached can't be replaced.
    const none = await attachToChange(dir, [file("refund-form.png")], {
      by: "pat",
      at: AT,
      replaces: "inputs/nothing.md",
    });
    expect(none.refused).toEqual([
      {
        name: "refund-form.png",
        why: "inputs/nothing.md isn't attached to this change, so it can't be replaced.",
      },
    ]);
  });

  it("never reads a file outside the change's inputs/read/, whatever index.yaml says", async () => {
    const dir = await changeDir();
    await attachToChange(dir, [file("refund-rules-v1.md")], { by: "pat", at: AT });
    const index = parse(await readFile(join(dir, "inputs/index.yaml"), "utf8"));
    index.files[0].readAs = "inputs/read/../../secret.env";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "inputs/index.yaml"), JSON.stringify(index));
    await writeFile(join(dir, "secret.env"), "TOKEN=abc\n");
    const s = await changeInputSources(dir, REL);
    expect(s.map((x) => x.text).join("\n")).not.toContain("TOKEN");
    expect((await readChangeInputs(dir)).files).toEqual([]);
  });

  it("names a file that is already in the metarepo's inputs, and still attaches it", async () => {
    const dir = await changeDir();
    const r = await attachToChange(dir, [file("refund-rules-v1.md")], {
      by: "pat",
      at: AT,
      elsewhere: (sha) => (sha === r0Sha() ? "inputs/inbox/refund-rules-v1.md" : undefined),
    });
    expect(r.added).toHaveLength(1);
    expect(r.notes).toEqual([
      "refund-rules-v1.md is also in the metarepo's inputs as inputs/inbox/refund-rules-v1.md.",
    ]);
  });

  it("gives the steps each current file's text, every line or page cited", async () => {
    const dir = await changeDir();
    await attachToChange(dir, [file("refund-rules-v1.md")], { by: "pat", at: AT });
    await attachToChange(dir, [file("refund-rules-v2.md")], {
      by: "pat",
      at: AT,
      replaces: "inputs/refund-rules-v1.md",
    });
    await attachToChange(
      dir,
      [
        file("refund-form.png"),
        file("partner-letter.pdf", join(HERE, "../../ingestors/test/fixtures/documents")),
      ],
      { by: "pat", at: AT },
    );
    const s = await changeInputSources(dir, REL);
    // The version a person said it replaces is left out; the picture is named, not read. Each
    // part is cited by the file's path in the change folder: the id the steps' data block has.
    expect(s.map((x) => x.id)).toEqual([
      "inputs/refund-rules-v2.md",
      "inputs/refund-form.png",
      "inputs/partner-letter.pdf",
    ]);
    expect(s[0]!.origin).toBe(`${REL}/inputs/refund-rules-v2.md`);
    expect(s[0]!.text).toBe(
      readFileSync(join(FIX, "expected/refund-rules-v2.read.md"), "utf8").replace(/\r\n/g, "\n"),
    );
    expect(s[1]!.text).toMatch(/a picture; Atticus doesn't read pictures/);
    expect(s[2]!.text).toMatch(/\[inputs\/partner-letter\.pdf page 1\]/);
    // What was read is kept beside the file, for the index and for people.
    expect(await readFile(join(dir, "inputs/read/refund-rules-v2.md.md"), "utf8")).toBe(s[0]!.text);
  });

  it("keeps a file that hides instructions out of every step, as data a person decides on", async () => {
    const dir = await changeDir();
    const r = await attachToChange(
      dir,
      [file("ledger-handover.md", join(HERE, "fixtures/defences/inputs/inbox"))],
      { by: "pat", at: AT },
    );
    expect(r.added[0]!.defences?.risk).toBe("high");
    const s = await changeInputSources(dir, REL);
    expect(s).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/kept out of every AI step/);
  });

  it("reads back each cited part of what was read, and names the files held out (ADR 0113 addendum, 2026-10-26)", async () => {
    const dir = await changeDir();
    await attachToChange(
      dir,
      [
        file("refund-rules-v1.md"),
        file("ledger-handover.md", join(HERE, "fixtures/defences/inputs/inbox")),
      ],
      { by: "pat", at: AT },
    );
    const [s] = await changeInputSources(dir, REL);
    const parts = citedParts(s!.text);
    const lines = readFileSync(join(FIX, "refund-rules-v1.md"), "utf8").split(/\r?\n/);
    // Every non-blank line of the file is a part, cited by its own line, with its words.
    expect(parts.length).toBe(lines.filter((l) => l.trim()).length);
    for (const p of parts) {
      const n = Number(/:(\d+)$/.exec(p.cite)![1]);
      expect(p.cite).toBe(`inputs/refund-rules-v1.md:${n}`);
      expect(p.text).toBe(lines[n - 1]);
      expect(s!.text.split("\n")[p.readLine - 1]).toBe(`[${p.cite}] ${p.text}`);
    }
    expect(await heldOutInputs(dir)).toEqual([
      { path: "inputs/ledger-handover.md", reason: expect.any(String) },
    ]);
  });

  it("refuses a name that would leave inputs/, and an empty file", async () => {
    const dir = await changeDir();
    const r = await attachToChange(
      dir,
      [
        { name: "../change.yaml", bytes: new Uint8Array([1]) },
        { name: "empty.txt", bytes: new Uint8Array() },
      ],
      { by: "pat", at: AT },
    );
    expect(r.added).toEqual([]);
    expect(r.refused.map((x) => x.why)).toEqual([
      "A file name can't hold a folder: give the file's own name.",
      "It is empty.",
    ]);
  });
});

function r0Sha(): string {
  return createHash("sha256").update(file("refund-rules-v1.md").bytes).digest("hex");
}
