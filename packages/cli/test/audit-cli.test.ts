import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAuditFile } from "@maycombhq/core";
import { auditCommand } from "../src/audit-commands.js";
import { main } from "../src/main.js";

/**
 * atticus verify audit <repo> (plan item P3, ADR 0148): a person confirms a reproducible random
 * sample of a repo's kept facts and its links, each shown with its cited lines; the answers go to
 * `<repo>.audit.yaml` beside the facts, and `--report` gives precision with the sample size and
 * a 95% interval. On the invented bank-shaped estate of fixtures/link-estate.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-audit-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FIX, "facts"), join(root, "facts"), { recursive: true });
  // Each repo's base clone, so the cited lines can be shown.
  for (const r of await readdir(join(FIX, "repos")))
    await cp(join(FIX, "repos", r), join(root, "workspace", r), { recursive: true });
  return root;
}

const NOW = () => new Date("2026-10-31T10:00:00.000Z");
const auditOf = async (root: string, repo: string) => {
  const r = parseAuditFile(await readFile(join(root, "facts", `${repo}.audit.yaml`), "utf8"));
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.file;
};

describe("atticus verify audit", { timeout: 30_000 }, () => {
  it("draws a reproducible sample, shows each item's lines, and records it unanswered off a terminal", async () => {
    const root = await metarepo();
    const c = capture();
    expect(
      await auditCommand(
        root,
        "forge-payments",
        { size: 3, seed: "s1", by: "tom", now: NOW },
        c.io,
      ),
    ).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out[0]).toBe(
      "Sample audit of forge-payments: 3 facts and 3 links drawn (seed s1, size 3; the same seed draws the same sample).",
    );
    // Each item with its id and its cited line as the checkout has it.
    expect(c.out.some((l) => /^\[1\/6\] fact /.test(l))).toBe(true);
    expect(c.out.some((l) => /^ {2}id fact:/.test(l))).toBe(true);
    expect(c.out.some((l) => /^ {2}src\/main\/java\/\S+:\d+ {2}\S/.test(l))).toBe(true);
    expect(c.out.some((l) => /^\[\d\/6\] link \(joined-by-[a-z]+\) forge-payments /.test(l))).toBe(
      true,
    );
    expect(c.out.some((l) => l.startsWith("Not on a terminal, so nothing was asked."))).toBe(true);
    expect(c.out).toContain(
      "Wrote facts/forge-payments.audit.yaml: 0 answered, 6 open. It is a person's record: commit it in a pull request (git add facts/forge-payments.audit.yaml); nothing was sent anywhere.",
    );
    const file = await auditOf(root, "forge-payments");
    expect(file.draws).toEqual([
      { seed: "s1", size: 3, commit: "c3c0006", at: "2026-10-31T10:00:00.000Z" },
    ]);
    expect(file.items).toHaveLength(6);

    // The same seed draws the same sample again, and adds nothing.
    const again = capture();
    await auditCommand(
      root,
      "forge-payments",
      { size: 3, seed: "s1", by: "tom", now: NOW },
      again.io,
    );
    expect((await auditOf(root, "forge-payments")).items.map((i) => i.id)).toEqual(
      file.items.map((i) => i.id),
    );
  });

  it("takes answers from a file and flags, points a wrong one to the correction flow, and reports precision", async () => {
    const root = await metarepo();
    const first = capture();
    await auditCommand(
      root,
      "forge-payments",
      { size: 3, seed: "s1", by: "tom", now: NOW, json: true },
      first.io,
    );
    const drawn = JSON.parse(first.out.join("\n")).drawn as { id: string; kind: string }[];
    const facts = drawn.filter((d) => d.kind === "fact").map((d) => d.id);
    const links = drawn.filter((d) => d.kind === "link").map((d) => d.id);
    await writeFile(
      join(root, "answers.yaml"),
      `${facts[0]}: right\n${facts[1]}: { answer: wrong, note: "It is a PUT" }\n${links[0]}: right\n`,
    );
    const c = capture();
    expect(
      await auditCommand(
        root,
        "forge-payments",
        {
          size: 3,
          seed: "s1",
          by: "tom",
          now: NOW,
          answers: "answers.yaml",
          unsure: [facts[2]!],
          wrong: [links[1]!],
          right: [links[2]!],
        },
        c.io,
      ),
    ).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out).toContain("  wrong: It is a PUT");
    expect(c.out).toContain(
      "  Correct it: the fact's Correct this on the Map (a line in facts/forge-payments.corrections.jsonl), then atticus verify forge-payments --write.",
    );
    expect(
      c.out.some((l) =>
        l.startsWith(
          "  Say so: on the Map, the link's Why is this linked? › This link is wrong corrects call ",
        ),
      ),
    ).toBe(true);
    const file = await auditOf(root, "forge-payments");
    expect(file.items.filter((i) => i.answer)).toHaveLength(6);
    expect(file.items.find((i) => i.id === facts[1])).toMatchObject({
      answer: "wrong",
      note: "It is a PUT",
      by: "tom",
    });

    const r = capture();
    expect(await auditCommand(root, "forge-payments", { report: true, by: "tom" }, r.io)).toBe(0);
    expect(r.out[0]).toBe(
      "Sample audit of forge-payments (facts/forge-payments.audit.yaml; 1 draw, seed s1):",
    );
    expect(r.out[1]).toBe(
      "Facts: precision 0.5, 1 of 2 right (95% interval 0.095 to 0.905); 1 unsure.",
    );
    expect(r.out).toContain("Links: precision 0.667, 2 of 3 right (95% interval 0.208 to 0.939).");
    expect(r.out).toContain(
      "5 answers in all: a sample this small says little, so read the interval, not the number. Draw more with another --seed.",
    );

    // The estate's summary: every repo audited, and the whole.
    const e = capture();
    expect(await auditCommand(root, undefined, { report: true, by: "tom", json: true }, e.io)).toBe(
      0,
    );
    const estate = JSON.parse(e.out.join("\n"));
    expect(estate.repos.map((x: { repo: string }) => x.repo)).toEqual(["forge-payments"]);
    expect(estate.estate.facts).toMatchObject({ right: 1, wrong: 1, unsure: 1, precision: 0.5 });
  });

  it("asks on a terminal: right, wrong with a note, skip and stop", async () => {
    const root = await metarepo();
    const said = ["r", "w", "Wrong path", "", "q"];
    const asked: string[] = [];
    const c = capture();
    await auditCommand(
      root,
      "forge-payments",
      {
        size: 2,
        seed: "s2",
        by: "tom",
        now: NOW,
        ask: async (q) => {
          asked.push(q);
          return said.shift();
        },
      },
      c.io,
    );
    expect(asked).toEqual([
      "Right, wrong or unsure? [r/w/u; Enter skips, q stops]",
      "Right, wrong or unsure? [r/w/u; Enter skips, q stops]",
      "What is wrong with it? (one line; Enter for none)",
      "Right, wrong or unsure? [r/w/u; Enter skips, q stops]",
      "Right, wrong or unsure? [r/w/u; Enter skips, q stops]",
    ]);
    const file = await auditOf(root, "forge-payments");
    expect(file.items.map((i) => i.answer ?? null)).toEqual(["right", "wrong", null, null]);
    expect(file.items[1]!.note).toBe("Wrong path");
  });

  it("refuses ids not in the sample, unverified facts, and a repo with no facts", async () => {
    const root = await metarepo();
    const c = capture();
    expect(
      await auditCommand(
        root,
        "forge-payments",
        { seed: "s", wrong: ["fact:nope"], by: "t" },
        c.io,
      ),
    ).toBe(2);
    expect(c.err[0]).toMatch(/^Not in this sample: fact:nope\./);
    const none = capture();
    expect(await auditCommand(root, "forge-nothing", { by: "t" }, none.io)).toBe(2);
    expect(none.err[0]).toMatch(/^forge-nothing has no facts to audit/);
    const text = await readFile(join(root, "facts", "forge-cards.jsonl"), "utf8");
    await writeFile(
      join(root, "facts", "forge-cards.jsonl"),
      text.replace('"verified":"line"', '"verified":"none"'),
    );
    const u = capture();
    expect(await auditCommand(root, "forge-cards", { by: "t" }, u.io)).toBe(2);
    expect(u.err[0]).toMatch(/aren't verified yet/);
    const r = capture();
    expect(await auditCommand(root, "forge-cards", { report: true, by: "t" }, r.io)).toBe(2);
    expect(r.err[0]).toBe(
      "forge-cards has no sample audit yet. Draw one: atticus verify audit forge-cards.",
    );
  });

  it("runs as atticus verify audit through the command line, flags and all", async () => {
    const root = await metarepo();
    const c = capture();
    const code = await main(
      [
        "verify",
        "audit",
        "forge-payments",
        "--size",
        "2",
        "--seed",
        "s9",
        "--json",
        "--root",
        root,
        "--by",
        "tom",
      ],
      c.io,
      { quiet: true },
    );
    expect(code).toBe(0);
    const r = JSON.parse(c.out.join("\n"));
    expect(r).toMatchObject({ repo: "forge-payments", seed: "s9", size: 2, wrote: true });
    const ids = (r.drawn as { id: string }[]).map((d) => d.id);
    const w = capture();
    expect(
      await main(
        [
          "verify",
          "audit",
          "forge-payments",
          "--size",
          "2",
          "--seed",
          "s9",
          "--right",
          ids.join(","),
          "--root",
          root,
          "--by",
          "tom",
        ],
        w.io,
        { quiet: true },
      ),
    ).toBe(0);
    const file = await auditOf(root, "forge-payments");
    expect(file.items.every((i) => i.answer === "right" && i.by === "tom")).toBe(true);
    const rep = capture();
    expect(
      await main(["verify", "audit", "--report", "--root", root], rep.io, { quiet: true }),
    ).toBe(0);
    expect(rep.out[0]).toBe("Sample audits across the estate: 1 repo audited.");
  });
});
