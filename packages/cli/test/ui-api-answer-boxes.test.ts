import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  Api,
  ignoredAnswer,
  raiseQuestions,
  readQuestion,
  TARGETS_ANOTHER_LABEL,
  TARGETS_STEP_ID,
  writeQuestion,
  type Question,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiTrustRoutes } from "../src/ui-api-trust.js";

/**
 * Beta.24 review: Map › Trust lists the boxes an answer's words made (a system of a profile, an
 * answer's words, or both), and puts one right: "It was 'ignore this'" (the answers become Ignore,
 * the system leaves its profile) or a rename to a real system, previewed first. On the invented
 * bank-shaped estate (fixtures/link-estate); files only, no network.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const AT = "2026-11-10T12:00:00.000Z";
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
const CICD = "ignore-this-its-cicd-related";
const PROXY_WORDS = "this is a proxy to send outbound webhook to merchants";

let root: string;
let srv: RunningServer;
let cicdQ: string;
let proxyQ: string;

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const draft = (path: string, line: number) => ({
  question: `Which repo or system answers POST ${path}, which payments-api calls?`,
  options: [
    { label: "forge-accounts", means: "it serves it", changes: "joins it" },
    { label: TARGETS_ANOTHER_LABEL, means: "the picker", changes: "name one" },
  ],
  evidence: [`src/main/java/forge/payments/HooksClient.java:${line}`],
  scope: "repo" as const,
});

/** As the app wrote an answer before the fix: the words, on file. */
const answeredWith = (q: Question, text: string): Question => ({
  ...q,
  state: "answered",
  answer: { text, by: "pat", at: AT, scope: { level: "repo", id: q.repo } },
});

const systems = async () =>
  (parse(await readFile(join(root, ...PROFILE), "utf8")) as { systems: { id: string }[] }).systems;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-answer-boxes-"));
  await cp(join(FIX, "org-pack"), join(root, "org-pack"), { recursive: true });
  // The picker once added the words as a vendor: a system of the profile.
  const file = join(root, ...PROFILE);
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "environments:",
      `  - { id: ${CICD}, name: "ignore this, its cicd related", boundary: vendor, aliases: [] }\nenvironments:`,
    ),
  );
  const { raised } = await raiseQuestions(root, [draft("/build/hooks", 12), draft("/hooks", 20)], {
    step: TARGETS_STEP_ID,
    repo: "forge-payments",
    command: "atticus verify forge-payments --write",
    rerun: "atticus verify forge-payments --write",
    at: AT,
  });
  cicdQ = raised[0]!.id;
  proxyQ = raised[1]!.id;
  await writeQuestion(root, answeredWith(raised[0]!, CICD));
  await writeQuestion(root, answeredWith(raised[1]!, PROXY_WORDS));
  srv = await startServer({
    root,
    port: 0,
    user: "priya.nair",
    extend: (r, ctx) => uiTrustRoutes(r, ctx),
  });
});
afterAll(async () => {
  await srv?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("boxes made from an answer's words (beta.24 review)", () => {
  it("lists each on Map › Trust, a system of the profile and an answer's words alike", async () => {
    const r = await call("GET", "/api/trust");
    expect(r.status).toBe(200);
    const boxes = Api.TrustView.parse(r.body).answerBoxes!;
    expect(boxes.map((b) => b.id)).toEqual([
      CICD,
      "this-is-a-proxy-to-send-outbound-webhook-to-merchants",
    ]);
    expect(boxes[0]).toMatchObject({
      profile: "org-pack/profiles/forge/profile.yaml",
      questions: [{ id: cicdQ, repo: "forge-payments" }],
    });
    expect(boxes[1]).toMatchObject({ name: PROXY_WORDS, questions: [{ id: proxyQ }] });
    expect(boxes[1]!.profile).toBeUndefined();
    // A named system is never listed.
    expect(boxes.some((b) => b.id === "northwind-pay")).toBe(false);
  });

  it("previews, then makes 'It was ignore this' Ignore and takes the system out", async () => {
    const before = await readFile(join(root, ...PROFILE), "utf8");
    const look = await call("POST", "/api/trust/answer-boxes/ignore", { id: CICD, preview: true });
    expect(look.status).toBe(200);
    const p = Api.AnswerBoxResult.parse(look.body);
    expect(p.written).toBe(false);
    expect(p.answers).toEqual([
      expect.objectContaining({ id: cicdQ, was: CICD, now: expect.stringMatching(/^Ignore: /) }),
    ]);
    expect(p.profile?.changes.some((c) => c.was?.includes(CICD))).toBe(true);
    expect(await readFile(join(root, ...PROFILE), "utf8")).toBe(before);

    const w = await call("POST", "/api/trust/answer-boxes/ignore", { id: CICD });
    expect(w.status).toBe(200);
    expect(Api.AnswerBoxResult.parse(w.body)).toMatchObject({
      written: true,
      repos: ["forge-payments"],
    });
    expect((await systems()).some((s) => s.id === CICD)).toBe(false);
    const q = (await readQuestion(root, cicdQ))!;
    expect(ignoredAnswer(q)?.reason).toMatch(/It was 'ignore this'/);
    expect(q.answer?.by).toBe("priya.nair");
  });

  it("renames a box to a real system, refusing a sentence", async () => {
    const id = "this-is-a-proxy-to-send-outbound-webhook-to-merchants";
    const bad = await call("POST", "/api/trust/answer-boxes/rename", {
      id,
      name: "a proxy for the webhooks",
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("names no repo, component or system");
    // Beta.25: the write is the one previewed: a stamp of other files is refused, nothing written.
    const look = Api.AnswerBoxResult.parse(
      (
        await call("POST", "/api/trust/answer-boxes/rename", {
          id,
          name: "Northwind Hooks",
          preview: true,
        })
      ).body,
    );
    expect(look.stamp).toBeTruthy();
    const stale = await call("POST", "/api/trust/answer-boxes/rename", {
      id,
      name: "Northwind Hooks",
      stamp: "0000000000000000",
    });
    expect(stale.status).toBe(409);
    expect((await readQuestion(root, proxyQ))!.answer?.text).toBe(PROXY_WORDS);
    const w = await call("POST", "/api/trust/answer-boxes/rename", {
      id,
      name: "Northwind Hooks",
      stamp: look.stamp,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(Api.AnswerBoxResult.parse(w.body).answers[0]).toMatchObject({
      id: proxyQ,
      now: "northwind-hooks",
    });
    expect((await systems()).some((s) => s.id === "northwind-hooks")).toBe(true);
    expect((await readQuestion(root, proxyQ))!.answer?.text).toBe("northwind-hooks");
    const after = Api.TrustView.parse((await call("GET", "/api/trust")).body);
    expect(after.answerBoxes ?? []).toEqual([]);
    expect((await call("POST", "/api/trust/answer-boxes/ignore", { id })).status).toBe(404);
  });

  it("answers 422, in words, for a box whose system holds an anchor others use (beta.25)", async () => {
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    const box = "this-is-the-anchor-box";
    await writeFile(
      file,
      before.replace(
        "environments:",
        `  - { id: ${box}, name: "this is the anchor box", boundary: vendor, owner: &own team-harbor, aliases: [] }\n  - { id: northwind-relay, name: Northwind Relay, boundary: vendor, owner: *own, aliases: [] }\nenvironments:`,
      ),
    );
    const { raised } = await raiseQuestions(root, [draft("/anchor", 30)], {
      step: TARGETS_STEP_ID,
      repo: "forge-payments",
      command: "atticus verify forge-payments --write",
      rerun: "atticus verify forge-payments --write",
      at: AT,
    });
    await writeQuestion(root, answeredWith(raised[0]!, box));
    const r = await call("POST", "/api/trust/answer-boxes/ignore", { id: box, preview: true });
    expect(r.status).toBe(422);
    expect(Api.Problem.parse(r.body).detail).toMatch(/anchor &own.*by hand/);
    expect(await readFile(file, "utf8")).toContain("&own");
  });

  it("declares the files a 500 left written on the problem (beta.25)", () => {
    const p = Api.Problem.parse({
      type: "about:blank",
      title: "Atticus wrote only part of it",
      status: 500,
      written: [{ file: "questions/q-1.yaml" }, { repo: "forge-payments", file: "a.txt" }],
    });
    expect(p.written).toEqual([
      { file: "questions/q-1.yaml" },
      { repo: "forge-payments", file: "a.txt" },
    ]);
  });
});
