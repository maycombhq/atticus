import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockModelProvider, ModelRuntime, type ChatInput } from "@maycombhq/ai";
import { surveyRepo } from "@maycombhq/assistant-kit";
import { fsRepo } from "@maycombhq/sdk";
import { metarepoToolBox, offerCodeDir } from "../src/code-tools.js";

/**
 * ADR 0118: the scan survey with the model's code search. forge-vault's base path is set by an
 * in-house annotation (@ForgeServiceBase on the application class), in a file none of the
 * survey's material shows. A scripted model greps for the annotation, reads the hit and cites
 * its line; the settings pass only because the check finds the value at that line.
 */

const VAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/code-search/repos/forge-vault",
);
const NOW = new Date("2026-10-23T12:00:00Z");

/** The tool results the model was given back, as one text. */
const toolText = (input: ChatInput) =>
  input.messages.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.text) : [])).join("\n");

describe("atticus scan survey with code search (ADR 0118)", () => {
  it("finds a custom framework's base path by grep and cites the line it found", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-survey-search-"));
    // The survey reads the repo from its folder; the tools read it by its id.
    offerCodeDir("forge-vault", VAULT);
    const provider = new MockModelProvider(
      "mock-model",
      () => "",
      (input, round) => {
        if (round === 1)
          return {
            calls: [{ name: "grep", input: { pattern: "@ForgeService", repo: "forge-vault" } }],
          };
        // The answer cites the hit the search returned: its path, line and the value written there.
        const m = /^forge-vault:(\S+):(\d+): @ForgeServiceBase\("([^"]+)"\)/m.exec(toolText(input));
        if (!m) return { text: "schemaVersion: 1\nrepo: forge-vault\n" };
        return {
          text: [
            "schemaVersion: 1",
            "repo: forge-vault",
            "exclude: []",
            "prefixes:",
            '  - paths: ["src/main/java/**"]',
            `    prefix: ${m[3]}`,
            "    why: the in-house @ForgeServiceBase annotation on the application class",
            `    at: "${m[1]}:${m[2]}"`,
            `    value: ${m[3]}`,
            "clients: []",
          ].join("\n"),
        };
      },
    );
    const runtime = new ModelRuntime(provider, {
      now: () => NOW,
      tools: () => metarepoToolBox(root),
      root,
    });
    const r = await surveyRepo(fsRepo("forge-vault", VAULT, "a".repeat(40)), {
      repoId: "forge-vault",
      runtime,
      now: NOW,
    });
    expect(r.attempts.map((a) => a.problems)).toEqual([[]]);
    expect(r.status).toBe("drafted");
    expect(r.settings?.prefixes).toEqual([
      {
        paths: ["src/main/java/**"],
        prefix: "/vault-api",
        why: "the in-house @ForgeServiceBase annotation on the application class",
        at: "src/main/java/forge/vault/VaultApplication.java:7",
        value: "/vault-api",
      },
    ]);
    // The material didn't show the annotation: the search found it. The prompt says to search.
    const first = provider.chats[0]!;
    expect(first.messages[0]).toMatchObject({ role: "user" });
    const prompt = (first.messages[0] as { text: string }).text;
    expect(prompt).not.toContain("ForgeServiceBase");
    expect(prompt).toMatch(/When you have the tools grep, files and outline/);
    expect(first.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["grep", "files", "outline"]),
    );
    // The run record keeps the search and what it returned, for Model runs.
    const kept = JSON.parse(
      await readFile(join(root, ".runs", "survey-forge-vault", r.runId!, "run.json"), "utf8"),
    ) as { tools: { calls: { name: string; output: string }[] } };
    expect(kept.tools.calls.map((c) => c.name)).toEqual(["grep"]);
    expect(kept.tools.calls[0]!.output).toContain(
      'forge-vault:src/main/java/forge/vault/VaultApplication.java:7: @ForgeServiceBase("/vault-api")',
    );
  }, 120_000);

  it("hands back an answer that cites a line the value isn't on, whatever the search said", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-survey-search-"));
    offerCodeDir("forge-vault", VAULT);
    const provider = new MockModelProvider(
      "mock-model",
      () => "",
      (_input, round) =>
        round === 1
          ? { calls: [{ name: "grep", input: { pattern: "@ForgeService" } }] }
          : {
              text: [
                "schemaVersion: 1",
                "repo: forge-vault",
                "prefixes:",
                '  - paths: ["src/main/java/**"]',
                "    prefix: /vault-api",
                "    why: a guess",
                '    at: "src/main/java/forge/vault/VaultApplication.java:3"',
                "    value: /vault-api",
              ].join("\n"),
            },
    );
    const runtime = new ModelRuntime(provider, {
      now: () => NOW,
      tools: () => metarepoToolBox(root),
    });
    const r = await surveyRepo(fsRepo("forge-vault", VAULT, "a".repeat(40)), {
      repoId: "forge-vault",
      runtime,
      now: NOW,
      maxAttempts: 1,
    });
    expect(r.status).toBe("failed");
    expect(r.attempts[0]!.problems.join("\n")).toMatch(
      /VaultApplication\.java:3 doesn't say \/vault-api/,
    );
  }, 120_000);
});
