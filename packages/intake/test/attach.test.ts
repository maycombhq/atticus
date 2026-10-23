import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { attachToChange, changeInputSources, readChangeInputs } from "../src/index.js";

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

  it("refuses a file already attached, by its bytes, and keeps a newer version beside the old", async () => {
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
    expect(again.added[0]).toMatchObject({
      path: "inputs/refund-rules-v2.md",
      version: "2",
      supersedes: "inputs/refund-rules-v1.md",
    });
    const index = await readChangeInputs(dir);
    expect(index.files.find((f) => f.path === "inputs/refund-rules-v1.md")?.supersededBy).toBe(
      "inputs/refund-rules-v2.md",
    );
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
    await attachToChange(
      dir,
      [
        file("refund-rules-v1.md"),
        file("refund-rules-v2.md"),
        file("refund-form.png"),
        file("partner-letter.pdf", join(HERE, "../../ingestors/test/fixtures/documents")),
      ],
      { by: "pat", at: AT },
    );
    const s = await changeInputSources(dir, REL);
    // The older version is left out; the picture is named, not read.
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
    expect(s[2]!.text).toMatch(/\[partner-letter\.pdf page 1\]/);
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
