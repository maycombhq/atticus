import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { callsOfQuestion, HOSTS_STEP, repoReadOf, type Fact, type Question } from "../src/index.js";

/** ADR 0140 (P4): how far a repo's read can be trusted, and the calls a link question asks about. */

const A = "a".repeat(40);
const B = "b".repeat(40);

async function put(root: string, rel: string, text: string) {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}

const call = (id: string, file: string, line: number, extra: Record<string, unknown> = {}) => ({
  kind: "call",
  id,
  repo: "forge-portal-bff",
  commit: A,
  cite: { file, line, value: "/accounts" },
  verified: "line",
  callType: "rest",
  method: "GET",
  path: "/accounts",
  ...extra,
});

async function metarepo(o: { head?: string; report?: string; facts?: unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-reads-"));
  await put(root, ".atticus/metarepo.yaml", "schemaVersion: 1\n");
  const facts = o.facts ?? [call("c1", "src/A.java", 3)];
  await put(
    root,
    "facts/forge-portal-bff.jsonl",
    facts.map((f) => JSON.stringify(f)).join("\n") + "\n",
  );
  if (o.report !== undefined) await put(root, "facts/forge-portal-bff.verify.yaml", o.report);
  if (o.head) await put(root, "workspace/forge-portal-bff/.git/HEAD", `${o.head}\n`);
  return root;
}

const REPORT = `accepted: 1\nrejected: 0\ncommit: ${A}\ncoverage: { ratio: 1, read: 1, unknown: [] }\n`;

describe("a repo's read (ADR 0140)", () => {
  it("is read when its facts are verified at the checkout's commit and every file was read", async () => {
    const r = await repoReadOf(await metarepo({ head: A, report: REPORT }), "forge-portal-bff");
    expect(r.state).toBe("read");
    expect(r.why).toEqual([]);
    expect(r.facts).toHaveLength(1);
  });

  it("is stale when the checkout moved past the commit its facts were read at", async () => {
    const r = await repoReadOf(await metarepo({ head: B, report: REPORT }), "forge-portal-bff");
    expect(r.state).toBe("stale");
    expect(r.why[0]).toBe("its facts were read at aaaaaaa and the checkout is at bbbbbbb");
    expect(r.next).toBe("atticus map forge-portal-bff");
  });

  it("is incomplete when facts were rejected or files went unread, or nobody verified it", async () => {
    const report = `accepted: 1\nrejected: 2\ncommit: ${A}\ncoverage: { ratio: 0.5, unknown: [src/B.java] }\n`;
    const r = await repoReadOf(await metarepo({ head: A, report }), "forge-portal-bff");
    expect(r.state).toBe("incomplete");
    expect(r.why).toEqual(["the verifier rejected 2 facts", "1 file wasn't read"]);
    const none = await repoReadOf(await metarepo({ head: A }), "forge-portal-bff");
    expect(none.state).toBe("incomplete");
    expect(none.why).toEqual(["nobody has run the verifier on its facts"]);
    expect(none.next).toBe("atticus verify forge-portal-bff");
  });

  it("is not read when it has no facts and no report", async () => {
    const r = await repoReadOf(await metarepo(), "forge-ledger");
    expect(r).toEqual({ repo: "forge-ledger", state: "not-read", why: [], facts: [] });
  });
});

const q = (step: string, question: string, evidence: string[]) =>
  ({ askedBy: { step }, repo: "forge-portal-bff", question, evidence }) as unknown as Question;

describe("the calls a link question asks about (ADR 0140)", () => {
  const facts = new Map<string, Fact[]>([
    [
      "forge-portal-bff",
      [
        call("c1", "src/A.java", 3),
        call("c2", "src/A.java", 9, { path: "/accounts/{id}" }),
        call("c3", "src/P.java", 4, { host: "ping.internal", path: "/ping" }),
      ] as Fact[],
    ],
    ["forge-reports", [call("c4", "src/R.java", 2, { host: "ping.internal" })] as Fact[]],
  ]);

  it("a targets question's calls are the ones on the lines it cites: a group's every call", () => {
    const one = callsOfQuestion(q("facts-targets", "Which?", ["src/A.java:3"]), facts);
    expect(one.map((f) => f.id)).toEqual(["c1"]);
    const group = callsOfQuestion(
      q("facts-targets", "Which?", ["src/A.java:3", "src/A.java:9"]),
      facts,
    );
    expect(group.map((f) => f.id)).toEqual(["c1", "c2"]);
  });

  it("a hosts question's calls are every call to its host, in every repo", () => {
    const h = callsOfQuestion(
      q(HOSTS_STEP, "Which repo answers on ping.internal?", ["src/P.java:4"]),
      facts,
    );
    expect(h.map((f) => f.id).sort()).toEqual(["c3", "c4"]);
  });

  it("a question that isn't about a link asks about no call", () => {
    expect(
      callsOfQuestion(q("scan-survey", "Is docs/ generated?", ["src/A.java:3"]), facts),
    ).toEqual([]);
  });
});
