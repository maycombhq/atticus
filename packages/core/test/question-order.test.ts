import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOSTS_STEP,
  orderQuestions,
  questionFromDraft,
  questionsInFlight,
  questionWeights,
  writeQuestion,
  type Question,
} from "../src/index.js";

/**
 * Ask first what a change needs (ADR 0140, Q3): the questions a change in flight rests on come
 * first, then by how many calls each answer joins (a group's question counts all its calls), so a
 * lone /ping comes last.
 */

const AT = "2026-10-21T12:00:00.000Z";
const A = "a".repeat(40);

async function put(root: string, rel: string, text: string) {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}

const call = (id: string, file: string, line: number, path: string, host?: string) =>
  JSON.stringify({
    kind: "call",
    id,
    repo: "forge-portal-bff",
    commit: A,
    cite: { file, line, value: path },
    verified: "line",
    callType: "rest",
    method: "GET",
    path,
    ...(host ? { host } : {}),
  });

async function ask(
  root: string,
  o: { step?: string; repo?: string; question: string; evidence: string[]; at?: string },
): Promise<Question> {
  const q = questionFromDraft(
    { question: o.question, options: [], evidence: o.evidence, scope: "repo" },
    {
      step: o.step ?? "facts-targets",
      repo: o.repo ?? "forge-portal-bff",
      command: "atticus verify forge-portal-bff --write",
      rerun: "atticus verify forge-portal-bff --write",
      at: o.at ?? AT,
    },
  );
  await writeQuestion(root, q);
  return q;
}

/** A change in flight whose design round cites a question, and a released one that cites another. */
async function change(root: string, id: string, state: string, cites: string[]) {
  await put(
    root,
    `openspec/changes/${id}/change.yaml`,
    `schemaVersion: 1\nid: ${id}\ntitle: ${id}\ntype: standard\nstate: ${state}\n`,
  );
  for (const [i, q] of cites.entries())
    await put(
      root,
      `openspec/changes/${id}/review/design/2/f-${i}.yaml`,
      `id: f-${i}\nstate: open\nevidence:\n  - { source: manual, path: questions/${q}.yaml }\n`,
    );
  // An older round's citation is not what the change rests on now.
  await put(
    root,
    `openspec/changes/${id}/review/design/1/f-old.yaml`,
    `id: f-old\nstate: open\nevidence:\n  - { source: manual, path: questions/q-000000000000.yaml }\n`,
  );
}

async function estate() {
  const root = await mkdtemp(join(tmpdir(), "atticus-order-"));
  await put(
    root,
    "facts/forge-portal-bff.jsonl",
    [
      call("c1", "src/A.java", 3, "/accounts/{id}"),
      call("c2", "src/A.java", 9, "/accounts/{id}/limit"),
      call("c3", "src/A.java", 12, "/accounts/{id}/history"),
      call("c4", "src/P.java", 4, "/ping"),
      call("c5", "src/H.java", 5, "/status", "status.internal"),
      call("c6", "src/H.java", 8, "/health", "status.internal"),
    ].join("\n") + "\n",
  );
  const ping = await ask(root, {
    question: "Which repo or system answers GET /ping, which forge-portal-bff calls?",
    evidence: ["src/P.java:4"],
    at: "2026-10-20T12:00:00.000Z",
  });
  const group = await ask(root, {
    question: "Which repo or system answers the calls forge-portal-bff makes under /accounts?",
    evidence: ["src/A.java:3", "src/A.java:9", "src/A.java:12"],
  });
  const hosts = await ask(root, {
    step: HOSTS_STEP,
    question: "Which repo answers on status.internal?",
    evidence: ["src/H.java:5"],
  });
  const survey = await ask(root, {
    step: "scan-survey",
    question: "Is docs/ generated?",
    evidence: ["docs/index.md:1"],
  });
  const own = await ask(root, {
    step: "stage-design",
    repo: "add-transfer-limit",
    question: "Does the limit apply per day?",
    evidence: ["design.md:4"],
  });
  return { root, ping, group, hosts, survey, own };
}

describe("ask first what a change needs (ADR 0140, Q3)", () => {
  it("finds what each change in flight rests on: its own questions and those its newest round cites", async () => {
    const e = await estate();
    await change(e.root, "add-transfer-limit", "design", [e.ping.id]);
    await change(e.root, "old-change", "released", [e.hosts.id]);
    const m = await questionsInFlight(e.root);
    expect(Object.fromEntries(m)).toEqual({
      [e.ping.id]: ["add-transfer-limit"],
      [e.own.id]: ["add-transfer-limit"],
    });
  });

  it("counts the calls each answer joins: a group's every call, a host's every call to it", async () => {
    const e = await estate();
    const w = await questionWeights(e.root, [e.ping, e.group, e.hosts, e.survey]);
    expect(w.get(e.group.id)?.joins).toBe(3);
    expect(w.get(e.hosts.id)?.joins).toBe(2);
    expect(w.get(e.ping.id)?.joins).toBe(1);
    expect(w.get(e.survey.id)?.joins).toBe(0);
  });

  it("puts what a change rests on first, then the answers that join most, a lone /ping last", async () => {
    const e = await estate();
    await change(e.root, "add-transfer-limit", "design", [e.ping.id]);
    const qs = [e.ping, e.group, e.hosts, e.survey, e.own];
    const ordered = orderQuestions(qs, await questionWeights(e.root, qs));
    expect(ordered.map((q) => q.id)).toEqual([
      e.ping.id,
      e.own.id,
      e.group.id,
      e.hosts.id,
      e.survey.id,
    ]);
    // With no change in flight, the lone /ping goes behind the group and the host.
    const none = await estate();
    const qs2 = [none.ping, none.group, none.hosts];
    expect(orderQuestions(qs2, await questionWeights(none.root, qs2)).map((q) => q.id)).toEqual([
      none.group.id,
      none.hosts.id,
      none.ping.id,
    ]);
  });
});
