import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { answerQuestion, listQuestions, parseRecord } from "@maycombhq/core";
import { buildAndWrite, buildWriteHooks } from "@maycombhq/scanner";
import { verifyAllCommand } from "../src/verify-commands.js";
import { seedReadersSlots, verifyConfirmed } from "./seed-slots.js";

/**
 * v31, one build for many repos: an answer one repo's questions open again (ADR 0162, F8) is no
 * answer for the build after it. Each repo's own Apply after the reopening one builds without it;
 * the one build had it, so the run builds the catalog again without it, and the catalog is what
 * the repos' own Applies leave. The invented two-repo Forge metarepo of map-render-cli.test.ts:
 * forge-ledger's POST /notify answered notify-api, then forge-notify read serving only GET /status.
 */
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const NOTIFY_HEAD = `0456def${"0".repeat(33)}`;
const made: string[] = [];
afterEach(() => {
  delete process.env.ATTICUS_APPLY_ONE_BUILD;
});
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
const quiet = () => {
  const out: string[] = [];
  return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) } };
};

async function estate(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atticus-one-build-answers-"));
  made.push(root);
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await seedReadersSlots(root, raw);
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"host":"notify.internal",',
      "",
    ),
  );
  // forge-ledger applied: its call with no host asked, and answered notify-api.
  const w = quiet();
  expect(
    await verifyConfirmed(
      root,
      "forge-ledger",
      { commit: "0123abc", dir: join(root, "workspace", "forge-ledger"), write: true },
      w.io,
    ),
    w.out.join("\n"),
  ).toBe(0);
  const q = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions.find(
    (x) => x.askedBy.step === "facts-targets",
  )!;
  await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-11-22T09:00:00Z" });
  // forge-notify read and applied, serving POST /notify and its GET routes: the answer joins.
  const clone = join(root, "workspace", "forge-notify");
  mkdirSync(join(clone, ".git"), { recursive: true });
  writeFileSync(join(clone, ".git", "HEAD"), `${NOTIFY_HEAD}\n`);
  await notifyRead(root, true);
  const n = quiet();
  expect(await verifyConfirmed(root, "forge-notify", { write: true }, n.io), n.out.join("\n")).toBe(
    0,
  );
  // Then read again without POST /notify (not applied): the answer misses once it is.
  await notifyRead(root, false);
  return root;
}

/** forge-notify's facts and clone: 30 GET routes, and POST /notify when `post`. */
async function notifyRead(root: string, post: boolean) {
  const routes = [
    ...Array.from({ length: 30 }, (_, k) => ["GET", `/status/${k}`, "GetMapping"] as const),
    ...(post ? [["POST", "/notify", "PostMapping"] as const] : []),
  ];
  const lines = ["class Routes {", ...routes.map(([, path, a]) => `  @${a}("${path}")`), "}"];
  const facts = routes.map(([method, path, a], k) =>
    JSON.stringify({
      kind: "entry",
      id: `e-${method.toLowerCase()}-${k}`,
      repo: "forge-notify",
      commit: "0456def",
      entryType: "rest",
      method,
      path,
      cite: { file: "src/Routes.java", line: k + 2, value: path, quote: `@${a}("${path}")` },
      verified: "line",
      by: "assistant",
      conf: "declared",
    }),
  );
  writeFileSync(join(root, "facts", "forge-notify.jsonl"), facts.join("\n") + "\n");
  const clone = join(root, "workspace", "forge-notify");
  mkdirSync(join(clone, "src"), { recursive: true });
  writeFileSync(join(clone, "src", "Routes.java"), lines.join("\n") + "\n");
}

const catalogOf = (root: string) => {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true }))
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else out.set(`${rel}/${e.name}`, readFileSync(join(root, rel, e.name), "utf8"));
  };
  walk("catalog");
  return out;
};

const differences = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => !p.startsWith("catalog/.") && a.get(p) !== b.get(p))
    .sort();

async function run(root: string, oneBuild: boolean) {
  if (!oneBuild) process.env.ATTICUS_APPLY_ONE_BUILD = "0";
  const c = quiet();
  const code = await verifyAllCommand(
    root,
    { write: true, only: ["forge-ledger", "forge-notify"] },
    c.io,
  );
  delete process.env.ATTICUS_APPLY_ONE_BUILD;
  return { code, out: c.out };
}

describe("one build for many repos and an answer opened again (v31)", () => {
  it("builds again without it: the catalog the next build makes, not one with the answer", async () => {
    const one = await estate();
    const each = await estate();
    const a = await run(one, true);
    const b = await run(each, false);
    expect(a.code, a.out.join("\n")).toBe(0);
    expect(b.code, b.out.join("\n")).toBe(0);
    // The answer was opened again, in both runs: by forge-ledger's questions after the one
    // build, by forge-notify's (the last repo) in the repos' own Applies.
    for (const r of [a, b])
      expect(
        r.out.some((l) => l.startsWith("Asked again ")),
        r.out.join("\n"),
      ).toBe(true);
    expect(a.out.join("\n")).toContain(
      "Built the catalog again without the answer this run opened again",
    );
    // The repos' own Applies leave the catalog built with the answer (the last repo opened it
    // again after its build); the next build drops it. The one build's run is that next build.
    const seq = catalogOf(each);
    await buildAndWrite(each, { command: "atticus catalog build" });
    const next = catalogOf(each);
    expect(
      differences(seq, next).length,
      "the repos' own Applies leave a stale catalog",
    ).toBeGreaterThan(0);
    expect(differences(catalogOf(one), next)).toEqual([]);
  }, 600_000);

  it("a refused build again is said with a command a person can run, and fails the run (the review of PR #10)", async () => {
    const root = await estate();
    // A person's edit of a record file while the run writes (the lock doesn't stop an editor):
    // made once, right after the one build's record files are written.
    buildWriteHooks.afterRecords = async () => {
      buildWriteHooks.afterRecords = undefined;
      const file = [...catalogOf(root).entries()].find(
        ([p, text]) => !p.startsWith("catalog/.") && p.endsWith(".yaml") && /^name: /m.test(text),
      )![0];
      const text = readFileSync(join(root, file), "utf8");
      writeFileSync(join(root, file), text.replace(/^name: .*$/m, "name: Renamed by hand"));
    };
    try {
      const a = await run(root, true);
      const said = a.out.join("\n");
      expect(a.code, said).toBe(1);
      expect(said).toContain(
        "building it again without the answer this run opened again was refused",
      );
      expect(said).toContain("atticus catalog build");
      expect(said).not.toContain("(answers opened again)");
    } finally {
      buildWriteHooks.afterRecords = undefined;
    }
  }, 600_000);
});
