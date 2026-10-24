import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";
import { stageCli } from "../src/stage-commands.js";
import { readNextState, nextSteps } from "../src/next-commands.js";

/**
 * ADR 0113 on the command line: `atticus change small` (the fast path), `atticus change attach`
 * (files into one change) and `atticus task context` (the task's context for an assistant).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-10-23T09:00:00Z");
const CHANGE = "return-order-time";
const ANSWER = readFileSync(join(FIXTURES, "stages/small/answer.yaml"), "utf8");

async function estate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-small-cli-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
    ...(parse(readFileSync(join(FIXTURES, "stages/catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error("bad fixture record");
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(FIXTURES, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIXTURES, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  await cp(join(FIXTURES, "stages/small", CHANGE), join(root, "openspec/changes", CHANGE), {
    recursive: true,
  });
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const mock = () =>
  new MockRuntime((req) => (req.agent.id.endsWith("-critic") ? "findings: []" : ANSWER), {
    now: () => NOW,
  });

describe("atticus change small", () => {
  it("is next for a small change, plans it in one step and prints the one PR", async () => {
    const root = await estate();
    const state = await readNextState(root);
    expect(state.changes.find((c) => c.id === CHANGE)?.fast).toBe(true);
    expect(state.changes.find((c) => c.id === "add-fraud-check")?.fast).toBeUndefined();
    // Past onboarding (this estate lists no repo), the change's step is the fast path's.
    const done = {
      id: "forge-orders",
      cloned: true,
      settings: true,
      scanned: true,
      verify: "done" as const,
      flows: 1,
      checked: true,
      findings: 0,
    };
    const next = nextSteps({ ...state, repos: [done], catalogRecords: 10, sources: [] });
    expect(next.find((s) => s.change === CHANGE)).toMatchObject({
      step: "small",
      command: `atticus change small ${CHANGE}`,
      slash: `/atticus-small ${CHANGE}`,
    });
    const o = io();
    const code = await stageCli(root, ["change", "small", CHANGE], {}, o.io, {
      runtime: mock(),
      now: NOW,
    });
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(o.out[0]).toMatch(/a small type: one step from brief to tasks/);
    expect(o.out).toContain(
      "The fast path stage is done after 1 draft (1 draft this run): nothing blocking is open and no question is waiting.",
    );
    expect(o.out.join("\n")).toContain("1 story and 1 task, from the target flows");
    expect(o.out.at(-1)).toBe(
      `Open the stage's pull request for a person to approve: atticus change handoff ${CHANGE} --approve`,
    );
  });

  it("refuses a standard change and names its path", async () => {
    const root = await estate();
    const o = io();
    const code = await stageCli(root, ["change", "small", "add-fraud-check"], {}, o.io, {
      runtime: mock(),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(o.err.join("\n")).toMatch(/Run atticus change feature add-fraud-check/);
  });
});

describe("atticus change attach", () => {
  it("copies the files into the change's inputs, says what each is, and refuses one already there", async () => {
    const root = await estate();
    const dir = await mkdtemp(join(tmpdir(), "atticus-attach-src-"));
    await writeFile(join(dir, "checkout-note.md"), "# Checkout\n\nShow the order time as HH:MM.\n");
    await writeFile(join(dir, "copy.md"), "# Checkout\n\nShow the order time as HH:MM.\n");
    const o = io();
    const code = await main(
      [
        "change",
        "attach",
        CHANGE,
        join(dir, "checkout-note.md"),
        join(dir, "copy.md"),
        "--by",
        "pat",
        "--root",
        root,
      ],
      o.io,
      { quiet: true },
    );
    expect(code).toBe(1);
    expect(o.out[0]).toBe(
      `Attached openspec/changes/${CHANGE}/inputs/checkout-note.md (document, markdown; read, cited by line).`,
    );
    expect(o.err).toEqual([
      "copy.md: not attached. It is already attached as inputs/checkout-note.md.",
    ]);
    const index = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "inputs/index.yaml"), "utf8"),
    );
    expect(index.files).toEqual([
      expect.objectContaining({ addedBy: "pat", name: "checkout-note.md" }),
    ]);
    const bad = io();
    expect(
      await main(
        ["change", "attach", "no-such-change", join(dir, "copy.md"), "--by", "pat", "--root", root],
        bad.io,
        { quiet: true },
      ),
    ).toBe(1);
    expect(bad.err[0]).toMatch(/There is no change no-such-change/);
    expect(await main(["change", "attach", CHANGE, "--root", root], io().io, { quiet: true })).toBe(
      2,
    );
  });

  it("keeps a file named like one attached beside it, and replaces it only with --replaces", async () => {
    const root = await estate();
    const dir = await mkdtemp(join(tmpdir(), "atticus-attach-src-"));
    await writeFile(join(dir, "checkout-note.md"), "# Checkout\n\nShow the order time as HH:MM.\n");
    await writeFile(join(dir, "checkout-note.txt"), "Show the order time as HH:MM:SS.\n");
    const run = async (...args: string[]) => {
      const o = io();
      const code = await main(
        ["change", "attach", CHANGE, ...args, "--by", "pat", "--root", root],
        o.io,
        {
          quiet: true,
        },
      );
      return { code, ...o };
    };
    expect((await run(join(dir, "checkout-note.md"))).code).toBe(0);
    const alike = await run(join(dir, "checkout-note.txt"));
    expect(alike.code).toBe(0);
    expect(alike.out.join("\n")).toContain(
      "checkout-note.txt has a name like inputs/checkout-note.md's: both are kept, and the steps read both. If it replaces that file, attach it again with --replaces inputs/checkout-note.md.",
    );
    const said = await run(join(dir, "checkout-note.txt"), "--replaces", "inputs/checkout-note.md");
    expect(said.code).toBe(0);
    expect(said.out[0]).toContain(", a newer version of inputs/checkout-note.md");
    const index = parse(
      await readFile(join(root, "openspec/changes", CHANGE, "inputs/index.yaml"), "utf8"),
    );
    expect(index.files[0]).toMatchObject({ supersededBy: "inputs/checkout-note.txt" });
    // --replaces takes one file.
    expect(
      (
        await run(
          join(dir, "checkout-note.md"),
          join(dir, "checkout-note.txt"),
          "--replaces",
          "inputs/x.md",
        )
      ).code,
    ).toBe(2);
  });
});

describe("atticus task context", () => {
  it("moves an attached file into general knowledge with --promote, and the change keeps it (ADR 0122)", async () => {
    const root = await estate();
    const dir = await mkdtemp(join(tmpdir(), "atticus-attach-src-"));
    await writeFile(join(dir, "limits-note.md"), "# Limits\n\nThe ledger owns every limit.\n");
    const by = ["--by", "pat", "--root", root];
    expect(
      await main(["change", "attach", CHANGE, join(dir, "limits-note.md"), ...by], io().io, {
        quiet: true,
      }),
    ).toBe(0);
    const o = io();
    expect(
      await main(["change", "attach", CHANGE, "--promote", "inputs/limits-note.md", ...by], o.io, {
        quiet: true,
      }),
    ).toBe(0);
    expect(o.out.join("\n")).toContain("inputs/inbox/limits-note.md");
    expect(await readFile(join(root, "inputs", "inbox", "limits-note.md"), "utf8")).toContain(
      "The ledger owns every limit.",
    );
    // The change keeps its copy.
    expect(
      await readFile(join(root, "openspec/changes", CHANGE, "inputs", "limits-note.md"), "utf8"),
    ).toContain("The ledger owns every limit.");
    // Once is enough: the same bytes are already in inputs/.
    const again = io();
    expect(
      await main(["change", "attach", CHANGE, "--promote", "limits-note.md", ...by], again.io, {
        quiet: true,
      }),
    ).toBe(1);
    expect(again.err.join("\n")).toMatch(/already in inputs/);
    const none = io();
    expect(
      await main(["change", "attach", CHANGE, "--promote", "inputs/nope.md", ...by], none.io, {
        quiet: true,
      }),
    ).toBe(1);
    expect(none.err.join("\n")).toMatch(/isn't attached/);
  });

  it("prints the task's context as Markdown, or as JSON", async () => {
    const root = await estate();
    await stageCli(root, ["change", "small", CHANGE], {}, io().io, { runtime: mock(), now: NOW });
    const md = io();
    expect(
      await main(["task", "context", CHANGE, "1.1", "--root", root], md.io, { quiet: true }),
    ).toBe(0);
    expect(md.out.join("\n")).toMatch(/^# Task 1\.1 of return-order-time: Change the respond step/);
    expect(md.out.join("\n")).toContain(
      "- forge-orders:src/main/java/forge/orders/OrderController.java:14: today's respond step (step 5), which this task changes",
    );
    const js = io();
    expect(
      await main(["task", "context", CHANGE, "1.1", "--json", "--root", root], js.io, {
        quiet: true,
      }),
    ).toBe(0);
    expect(JSON.parse(js.out.join("\n"))).toMatchObject({
      task: { id: "1.1", repo: "forge-orders" },
      criteria: [expect.stringContaining("createdAt")],
    });
    const none = io();
    expect(
      await main(["task", "context", CHANGE, "7.7", "--root", root], none.io, { quiet: true }),
    ).toBe(1);
    expect(none.err[0]).toMatch(/There is no task 7\.7/);
  });
});
