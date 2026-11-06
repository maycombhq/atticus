import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";
import {
  effectiveRules,
  orgRulesLacking,
  readingRulesText,
  ruleId,
  ruleIds,
  ruleMatches,
} from "../src/reading-rules.js";
import {
  draftPrompt,
  rulesAddCommand,
  rulesDraftCommand,
  rulesImportCommand,
  rulesListCommand,
  rulesSetCommand,
  rulesTryCommand,
  tryDiff,
} from "../src/rules-commands.js";

/**
 * G4 (ADR 0176): reading rules the organisation owns, in layers (imported, org, type, repo), with
 * a later layer switching an earlier rule off; the commands that write them, Copilot's drafts and
 * tries (a stand-in session here), and a pinned import from another team's metarepo. On an
 * invented Forge metarepo; no network, no Copilot.
 */

const temps: string[] = [];
const temp = (n: string) => {
  const d = mkdtempSync(join(tmpdir(), `atticus-rules-${n}-`));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

/** A Forge metarepo: two fuse-service repos and a gateway. */
function metarepo(): string {
  const root = temp("meta");
  write(root, "org-pack/pack.yaml", "schemaVersion: 1\nname: forge\n");
  write(
    root,
    "org-pack/profiles/forge/repos.manifest.yaml",
    [
      "schemaVersion: 2",
      "platform: forge",
      "repos:",
      "  - { id: forge-refunds, url: https://git.example.com/forge/forge-refunds.git, type: fuse-service, owner: team-payments }",
      "  - { id: forge-payouts, url: https://git.example.com/forge/forge-payouts.git, type: fuse-service, owner: team-payments }",
      "  - { id: forge-gw, url: https://git.example.com/forge/forge-gw.git, type: gateway-external, owner: team-platform }",
      "",
    ].join("\n"),
  );
  return root;
}

const RULE =
  'A call\'s path is never the field that holds it: follow the field to its @Value("${...}") key.';

describe("the layers (ADR 0176)", () => {
  it("adds layer by layer, and a later layer switches an earlier rule off, saying why", async () => {
    const root = metarepo();
    write(
      root,
      "org-pack/reading-rules/org.yaml",
      `schemaVersion: 1\nrules:\n  - key: no-mocks\n    rule: "Never record a call made only by a test double or mock server."\n`,
    );
    write(
      root,
      "org-pack/reading-rules/types/fuse-service.yaml",
      `schemaVersion: 1\nrules:\n  - key: path-from-field\n    rule: ${JSON.stringify(RULE)}\n    files: ["src/main/java/**/*Client.java"]\n    example: "src/main/java/forge/refunds/RefundClient.java:42"\n  - key: soap-actions\n    status: draft\n    rule: "A SOAP call's path is its SOAPAction header's value."\n`,
    );
    write(
      root,
      "org-pack/reading-rules/repos/forge-payouts.yaml",
      `schemaVersion: 1\noff:\n  - key: no-mocks\n    reason: "payouts calls the bank's sandbox through a mock in production"\n  - key: builtin:terms\n    reason: "payouts has no organisation terms"\n`,
    );
    const refunds = await effectiveRules(root, "forge-refunds");
    expect(refunds.rules.map((r) => [r.key, r.layer])).toEqual([
      ["no-mocks", "org"],
      ["path-from-field", "type"],
    ]);
    expect(refunds.drafts.map((r) => r.key)).toEqual(["soap-actions"]);
    const payouts = await effectiveRules(root, "forge-payouts");
    expect(payouts.rules.map((r) => r.key)).toEqual(["path-from-field"]);
    expect(payouts.builtinOff).toEqual(["terms"]);
    expect(payouts.off.map((x) => x.key)).toEqual(["no-mocks", "builtin:terms"]);
    const gw = await effectiveRules(root, "forge-gw");
    expect(gw.rules.map((r) => r.key)).toEqual(["no-mocks"]);
    // The text a reader is given: the rule, its layer, its files and example.
    const text = readingRulesText(refunds);
    expect(text).toContain("## The organisation's reading rules for this repo");
    expect(text).toContain(
      "- path-from-field (type; for src/main/java/**/*Client.java): A call's path is never the field",
    );
    expect(text).toContain("For example src/main/java/forge/refunds/RefundClient.java:42.");
    expect(readingRulesText(payouts)).toContain("Atticus's terms rules");
  });

  it("names each rule by its words and files, so a change is lacking and only that one", () => {
    const a = { key: "path-from-field", rule: RULE, files: ["src/**/*Client.java"] };
    expect(ruleId(a)).toMatch(/^org:path-from-field@[0-9a-f]{8}$/);
    expect(ruleId({ ...a, rule: `${RULE} Always.` })).not.toBe(ruleId(a));
    const e = {
      rules: [{ ...a, id: ruleId(a), layer: "type", file: "x", status: "active" }],
    } as never;
    expect(orgRulesLacking({ sets: [ruleId(a)] }, e)).toEqual([]);
    expect(orgRulesLacking({ sets: ["field-types"] }, e).map((r) => r.key)).toEqual([
      "path-from-field",
    ]);
    expect(ruleIds(e)).toEqual([ruleId(a)]);
    expect(ruleMatches(a, "src/main/java/forge/RefundClient.java")).toBe(true);
    expect(ruleMatches(a, "src/main/java/forge/Refund.java")).toBe(false);
    expect(ruleMatches({}, "anything")).toBe(true);
  });
});

describe("atticus rules add, activate, off and list", () => {
  it("writes a draft for review, sets it active, switches one off, and lists them", async () => {
    const root = metarepo();
    const a = io();
    expect(
      await rulesAddCommand(
        root,
        { type: "fuse-service" },
        { key: "path-from-field", rule: RULE, files: "src/main/java/**/*Client.java", draft: true },
        a.io,
      ),
    ).toBe(0);
    expect(a.out[0]).toContain(
      "Drafted path-from-field in org-pack/reading-rules/types/fuse-service.yaml",
    );
    expect((await effectiveRules(root, "forge-refunds")).drafts.map((r) => r.key)).toEqual([
      "path-from-field",
    ]);
    expect(
      await rulesSetCommand(
        root,
        "activate",
        "path-from-field",
        { type: "fuse-service" },
        {},
        io().io,
      ),
    ).toBe(0);
    expect((await effectiveRules(root, "forge-refunds")).rules.map((r) => r.key)).toEqual([
      "path-from-field",
    ]);
    const off = io();
    expect(
      await rulesSetCommand(root, "off", "path-from-field", { repo: "forge-payouts" }, {}, off.io),
    ).toBe(2);
    expect(off.err[0]).toContain("--reason");
    expect(
      await rulesSetCommand(
        root,
        "off",
        "path-from-field",
        { repo: "forge-payouts" },
        { reason: "payouts reads its paths from a table" },
        io().io,
      ),
    ).toBe(0);
    expect((await effectiveRules(root, "forge-payouts")).rules).toEqual([]);
    const l = io();
    expect(await rulesListCommand(root, "forge-refunds", {}, l.io)).toBe(0);
    expect(l.out.join("\n")).toContain(
      "path-from-field (type, org-pack/reading-rules/types/fuse-service.yaml)",
    );
    // Two layers at once, or none, is refused; so is a rule that isn't one.
    expect(await rulesAddCommand(root, {}, { key: "x", rule: RULE }, io().io)).toBe(2);
    expect(
      await rulesAddCommand(root, { org: true }, { key: "Bad Key", rule: RULE }, io().io),
    ).toBe(2);
  });
});

describe("Copilot drafts and tries (a stand-in session)", () => {
  it("drafts from what the reads missed: the prompt has the misses, and the session writes drafts only", async () => {
    const root = metarepo();
    write(
      root,
      "facts/forge-refunds.corrections.jsonl",
      JSON.stringify({
        schemaVersion: 1,
        fact: "c-refund",
        target: {
          kind: "call",
          file: "src/main/java/forge/refunds/RefundClient.java",
          line: 42,
          value: "requestRefundPath",
        },
        action: "link",
        link: { repo: "forge-gw", method: "POST", path: "/v2/refunds/request" },
        by: "pat",
        at: "2026-11-06T12:00:00.000Z",
      }) + "\n",
    );
    const prompts: string[] = [];
    const runner: AcpStepRunner = async (s) => {
      prompts.push(s.line);
      expect(s.writeRoots).toEqual([join(root, "org-pack/reading-rules")]);
      write(
        root,
        "org-pack/reading-rules/types/fuse-service.yaml",
        `schemaVersion: 1\nrules:\n  - key: path-from-field\n    status: draft\n    rule: ${JSON.stringify(RULE)}\n    files: ["src/main/java/**/*Client.java"]\n    by: "copilot, from 2 repos"\n`,
      );
      return { stopReason: "end_turn", runId: "r1" } as never;
    };
    const d = io();
    expect(
      await rulesDraftCommand(root, { type: "fuse-service", mode: "copilot-acp", runner }, d.io),
    ).toBe(0);
    expect(prompts[0]).toContain("# Draft reading rules for every repo of type fuse-service");
    expect(prompts[0]).toContain("forge-refunds: a person paired call requestRefundPath");
    expect(prompts[0]).toContain("- forge-payouts (not cloned here)");
    expect(d.out.at(-1)).toContain("1 draft for a person to review and set active");
    // Hand-off: the prompt is written, and the line to give Copilot Chat said.
    const h = io();
    expect(
      await rulesDraftCommand(
        root,
        { repo: "forge-gw", about: "forwarding calls are missed", mode: "hand-off" },
        h.io,
      ),
    ).toBe(0);
    expect(h.out[0]).toBe(
      "In a NEW Copilot Chat (agent mode): read org-pack/reading-rules/drafting/repo-forge-gw.md and do what it says.",
    );
    expect(
      readFileSync(join(root, "org-pack/reading-rules/drafting/repo-forge-gw.md"), "utf8"),
    ).toContain("forwarding calls are missed");
    expect(draftPrompt({ scope: { type: "t" }, repos: [], file: "f", missed: [] })).toContain(
      "status: draft",
    );
  });

  it("tries a rule on a few files it names: the facts it would add, and nothing written", async () => {
    const root = metarepo();
    write(
      root,
      "workspace/forge-refunds/src/main/java/forge/refunds/RefundClient.java",
      "class RefundClient {}\n",
    );
    write(
      root,
      "workspace/forge-refunds/src/main/java/forge/refunds/Refund.java",
      "class Refund {}\n",
    );
    write(
      root,
      "org-pack/reading-rules/types/fuse-service.yaml",
      `schemaVersion: 1\nrules:\n  - key: path-from-field\n    rule: ${JSON.stringify(RULE)}\n    files: ["src/main/java/**/*Client.java"]\n`,
    );
    const fact = {
      kind: "call",
      id: "c-refund",
      repo: "forge-refunds",
      commit: "1111aaa",
      callType: "rest",
      method: "POST",
      path: "${forge.gw.uris.refund}",
      cite: {
        file: "src/main/java/forge/refunds/RefundClient.java",
        line: 1,
        value: "RefundClient",
      },
      verified: "none",
      by: "assistant",
      conf: "declared",
    };
    const prompts: string[] = [];
    const runner: AcpStepRunner = async (s) => {
      prompts.push(s.line);
      write(root, "facts/.try/forge-refunds.jsonl", JSON.stringify(fact) + "\n");
      return { stopReason: "end_turn", runId: "r2" } as never;
    };
    const t = io();
    const code = await rulesTryCommand(
      root,
      "forge-refunds",
      { rule: "path-from-field", mode: "copilot-acp", runner },
      t.io,
    );
    expect(code, t.err.join("\n")).toBe(0);
    expect(prompts[0]).toContain("- `src/main/java/forge/refunds/RefundClient.java`");
    expect(prompts[0]).not.toContain("Refund.java`");
    expect(t.out.join("\n")).toContain("would add 1 facts and change 0");
    expect(t.out.at(-1)).toBe("Nothing was written to the facts on file.");
    expect(() => readFileSync(join(root, "facts/.try/forge-refunds.jsonl"))).toThrow();
    expect(
      tryDiff([fact as never], [{ ...fact, path: "/v2/refunds" } as never]).changed,
    ).toHaveLength(1);
  });
});

describe("atticus rules import", () => {
  it("copies another team's type rules, pinned at a tag, with their source, for review", async () => {
    const root = metarepo();
    const theirs = temp("theirs");
    const git = (...a: string[]) => execFileSync("git", ["-C", theirs, ...a], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "harbor@example.com");
    git("config", "user.name", "Harbor team");
    write(
      theirs,
      "org-pack/reading-rules/types/fuse-service.yaml",
      `schemaVersion: 1\nrules:\n  - key: house-client\n    rule: "Calls through HarborClient.send name their path as the first argument."\n`,
    );
    git("add", ".");
    git("commit", "-qm", "rules");
    git("tag", "v1.0");
    // A later change on their side isn't what the tag pins.
    write(
      theirs,
      "org-pack/reading-rules/types/fuse-service.yaml",
      "schemaVersion: 1\nrules: []\n",
    );
    const i = io();
    expect(
      await rulesImportCommand(
        root,
        theirs,
        { type: "fuse-service", team: "harbor", at: "v1.0" },
        i.io,
      ),
    ).toBe(0);
    const copy = parse(
      readFileSync(join(root, "org-pack/reading-rules/imported/harbor/fuse-service.yaml"), "utf8"),
    ) as { source: { at: string; team: string }; rules: { key: string }[] };
    expect(copy.source).toMatchObject({ at: "v1.0", team: "harbor" });
    expect(copy.rules.map((r) => r.key)).toEqual(["house-client"]);
    // Another team's rules reach no read until reviewed and set active: each is a draft.
    const e = await effectiveRules(root, "forge-refunds");
    expect(e.rules).toEqual([]);
    expect(e.drafts.map((r) => [r.key, r.layer])).toEqual([["house-client", "imported"]]);
    const no = (o: Record<string, string>) => rulesImportCommand(root, theirs, o, io().io);
    expect(await no({ type: "fuse-service", team: "Harbor Team", at: "v1.0" })).toBe(2);
    expect(await no({ type: "nope", team: "harbor", at: "v1.0" })).toBe(2);
    // Pinned, always; and a ref that would be read as an option is refused before git sees it.
    expect(await no({ type: "fuse-service", team: "harbor" })).toBe(2);
    expect(await no({ type: "fuse-service", team: "harbor", at: "--output=/tmp/x" })).toBe(2);
  });
});

describe("atticus rules notes", () => {
  it("offers a type's notes that read as instructions as draft rules, and writes them with --save", async () => {
    const root = metarepo();
    write(
      root,
      "org-pack/repo-types/fuse-service/type.yaml",
      [
        "schemaVersion: 1",
        "id: fuse-service",
        "name: Fuse service",
        "description: A Fuse integration service of the Forge estate.",
        "fingerprint:",
        "  - kind: layout",
        '    globs: ["src/main/java/**"]',
        "    weight: 5",
        "notes:",
        '  - "A clearing id is the account a payout settles to."',
        '  - "Follow the route builder to the endpoint URI it sets: that is the call\'s path."',
        "",
      ].join("\n"),
    );
    const { rulesNotesCommand } = await import("../src/rules-commands.js");
    const a = io();
    expect(await rulesNotesCommand(root, { type: "fuse-service" }, a.io)).toBe(0);
    expect(a.out[0]).toBe(
      "from-note-1: Follow the route builder to the endpoint URI it sets: that is the call's path.",
    );
    expect(await rulesNotesCommand(root, { type: "fuse-service", save: true }, io().io)).toBe(0);
    expect((await effectiveRules(root, "forge-refunds")).drafts.map((r) => r.key)).toEqual([
      "from-note-1",
    ]);
  });
});
