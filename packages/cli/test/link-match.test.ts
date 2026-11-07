import { appendFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";
import { checkMatchAnswer, connectMatchCommand, matchBrief } from "../src/link-match.js";
import { uiLinkMatchRoutes } from "../src/ui-api-link-match.js";
import { candidatesOf } from "../src/ui-api-links.js";

/**
 * ADR 0178, part 2: Match with Copilot. On the invented Forge estate (fixtures/prototype-compare):
 * forge-billing's loose call `captureChargePath` against the partner gateway's routes. The
 * session is a fake runner that writes the answer file; nothing is a correction until a person
 * ticks it. Files only; no network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
const CAPTURE = "entry.post.partners-northwind-charges-chargeid-capture";

let srv: RunningServer;
let root: string;
const prompts: string[] = [];
let answer = "";
const runner: AcpStepRunner = async (s) => {
  prompts.push(s.line);
  expect(s.writeRoots).toEqual([join(root, "proposals/matching")]);
  await writeFile(
    join(root, "proposals/matching/forge-billing--repo-forge-partner-gateway.yaml"),
    answer,
  );
  return { stopReason: "end_turn", runId: "r1" } as never;
};

const LOOSE = JSON.stringify({
  kind: "call",
  id: "call.post.capture-charge",
  repo: "forge-billing",
  commit: "aaa1111",
  callType: "rest",
  method: "POST",
  path: "captureChargePath",
  cite: {
    file: "src/main/java/forge/billing/PartnerClient.java",
    line: 31,
    value: "captureChargePath",
    quote: "post(captureChargePath, body) // see PartnerRoutes.CAPTURE",
  },
  verified: "line",
  by: "assistant",
  conf: "declared",
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-match-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  await appendFile(join(root, "facts/forge-billing.jsonl"), `${LOOSE}\n`);
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    extend: (r, ctx) => uiLinkMatchRoutes(r, ctx, { runner }),
  });
});
afterAll(() => srv?.close());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(srv.url + path, {
    method,
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("the brief and the answer", () => {
  it("fences every line from files as data, names the one file to write, and checks the answer against the boxes", async () => {
    const { view, facts } = await candidatesOf(root, "forge-billing", {
      repo: "forge-partner-gateway",
    });
    const quotes = new Map(
      facts.filter((f) => f.kind === "call").map((f) => [f.id, f.cite.quote] as const),
    );
    const brief = matchBrief({ view, quotes, answer: "proposals/matching/x.yaml" });
    expect(brief).toContain("call call.post.capture-charge: POST captureChargePath");
    expect(brief).toContain("the line: post(captureChargePath, body)");
    expect(brief).toContain(`api ${CAPTURE}:`);
    // The data block's fence is longer than any run of backticks inside it.
    const fences = brief.match(/^`{3,}$/gm) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(4);
    expect(brief).toContain("Write proposals/matching/x.yaml (YAML) and nothing else");
    const c = checkMatchAnswer(
      [
        "pairs:",
        `  - call: call.post.capture-charge`,
        `    api: ${CAPTURE}`,
        "    why: CAPTURE is the capture route",
        "    lines: [src/main/java/forge/billing/PartnerRoutes.java:12, not a line]",
        "  - call: call.post.capture-charge",
        "    api: entry.get.nope",
        "  - call: call.nope",
        `    api: ${CAPTURE}`,
        "none:",
        "  - call: call.nope",
        "    why: x",
      ].join("\n"),
      view,
    );
    expect(c).toEqual({
      proposals: [
        {
          call: "call.post.capture-charge",
          api: CAPTURE,
          why: "CAPTURE is the capture route",
          lines: ["src/main/java/forge/billing/PartnerRoutes.java:12"],
        },
      ],
      none: [],
      rejected: [
        "entry.get.nope isn't an API of forge-partner-gateway.",
        "call.nope isn't one of forge-billing's loose calls.",
        "call.nope isn't one of forge-billing's loose calls.",
      ],
    });
    // One sloppy line never loses the good ones; a file that isn't a map at all is refused.
    expect(checkMatchAnswer("pairs: 3", view)).toEqual({ proposals: [], none: [], rejected: [] });
    expect(
      checkMatchAnswer(
        `pairs:\n  - call: call.post.capture-charge\n    api: ${CAPTURE}\n    why: 7\n    lines: nope\n`,
        view,
      ),
    ).toMatchObject({ proposals: [{ call: "call.post.capture-charge", why: "7", lines: [] }] });
    expect(checkMatchAnswer("- a list", view)).toMatchObject({
      error: expect.stringContaining("shape"),
    });
    expect(checkMatchAnswer("pairs: [", view)).toMatchObject({
      error: expect.stringContaining("YAML"),
    });
  });
});

describe("Match with Copilot from the panel", () => {
  it("is idle before, running while the session goes, and done with checked proposals after; nothing is a correction", async () => {
    const idle = Api.MatchLinksView.parse(
      (await call("GET", "/api/links/match?from=forge-billing&to=forge-partner-gateway")).body,
    );
    expect(idle.state).toBe("idle");
    answer = `pairs:\n  - call: call.post.capture-charge\n    api: ${CAPTURE}\n    why: the route constant\n    lines: [src/main/java/forge/billing/PartnerRoutes.java:12]\n`;
    const started = await call("POST", "/api/links/match", {
      from: "forge-billing",
      to: { repo: "forge-partner-gateway" },
    });
    expect(started.status).toBe(202);
    expect(Api.MatchLinksView.parse(started.body).state).toBe("running");
    await until(async () => {
      const v = Api.MatchLinksView.parse(
        (await call("GET", "/api/links/match?from=forge-billing&to=forge-partner-gateway")).body,
      );
      return v.state === "done";
    });
    const done = Api.MatchLinksView.parse(
      (await call("GET", "/api/links/match?from=forge-billing&to=forge-partner-gateway")).body,
    );
    expect(done.state).toBe("done");
    expect(done.brief).toBe("proposals/matching/forge-billing--repo-forge-partner-gateway.md");
    expect(done.proposals).toEqual([
      {
        call: "call.post.capture-charge",
        api: CAPTURE,
        why: "the route constant",
        lines: ["src/main/java/forge/billing/PartnerRoutes.java:12"],
      },
    ]);
    expect(prompts[0]).toContain("# Match forge-billing's calls with forge-partner-gateway's APIs");
    // The corrections file is untouched: a proposal isn't a correction.
    const corr = await readFile(join(root, "facts/forge-billing.corrections.jsonl"), "utf8").catch(
      () => "",
    );
    expect(corr).not.toContain(CAPTURE);
    expect((await call("POST", "/api/links/match", { from: "forge-billing", to: {} })).status).toBe(
      400,
    );
  });

  it("the command reads the answer back with --read, and hands the brief to the assistant when asked", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`! ${l}`) };
    const code = await connectMatchCommand(
      root,
      "forge-billing",
      {
        to: "forge-partner-gateway",
        read: true,
        candidates: (from, to) => candidatesOf(root, from, to),
      },
      io,
    );
    expect(code).toBe(0);
    // The answer on file from the session before is read back.
    expect(out.join("\n")).toContain(`call.post.capture-charge → ${CAPTURE}: the route constant`);
    expect(out.join("\n")).toContain("Nothing is written");
    // A hand-off writes a fresh brief and drops the old answer, so nothing stale reads as done.
    const h: string[] = [];
    expect(
      await connectMatchCommand(
        root,
        "forge-billing",
        {
          to: "forge-partner-gateway",
          mode: "hand-off",
          candidates: (from, to) => candidatesOf(root, from, to),
        },
        { out: (l: string) => h.push(l), err: (l: string) => h.push(`! ${l}`) },
      ),
    ).toBe(0);
    expect(h.join("\n")).toContain(
      "read proposals/matching/forge-billing--repo-forge-partner-gateway.md",
    );
    expect(
      Api.MatchLinksView.parse(
        (await call("GET", "/api/links/match?from=forge-billing&to=forge-partner-gateway")).body,
      ).state,
    ).toBe("handoff");
    expect(
      await connectMatchCommand(
        root,
        undefined,
        { candidates: (f, t) => candidatesOf(root, f, t) },
        io,
      ),
    ).toBe(2);
  });
});
