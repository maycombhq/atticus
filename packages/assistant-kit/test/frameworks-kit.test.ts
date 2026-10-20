import { readdir, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FrameworkModel, orgPackJsonSchemas } from "@maycombhq/core";
import { runFrameworkTests } from "@maycombhq/extractors";
import { fsRepo, memoryRepo } from "@maycombhq/sdk";
import {
  exportFrameworksKit,
  formatFrameworkSurvey,
  FRAMEWORK_KIT_COMMANDS,
  FRAMEWORKS_KIT_DIR,
  surveyFrameworks,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSY = join(HERE, "../../../fixtures/messy");
const SHA = "0".repeat(40);

describe("the framework-model kit (ADR 0055)", () => {
  it("writes the guide, the examples, the checklist, the prompt, the schema and the commands", async () => {
    const out = await mkdtemp(join(tmpdir(), "atticus-fwkit-"));
    expect(await exportFrameworksKit(out)).toEqual([
      "README.md",
      "checklist.md",
      "cli.md",
      "examples/tide-lantern.yaml",
      "examples/tide-platform.yaml",
      "framework.schema.json",
      "prompts/write-framework-model.md",
    ]);
    expect(JSON.parse(await readFile(join(out, "framework.schema.json"), "utf8"))).toEqual(
      orgPackJsonSchemas().FrameworkModel,
    );
    const cli = await readFile(join(out, "cli.md"), "utf8");
    for (const c of FRAMEWORK_KIT_COMMANDS) expect(cli).toContain(c.usage);
    expect(cli).not.toContain("dialect");
  });

  it("ships the messy estate's models as its examples, unchanged, and their tests pass", async () => {
    const dir = join(FRAMEWORKS_KIT_DIR, "examples");
    for (const f of await readdir(dir)) {
      const text = await readFile(join(dir, f), "utf8");
      expect(text).toBe(await readFile(join(MESSY, "metarepo/org-pack/frameworks", f), "utf8"));
      const model = FrameworkModel.parse(parse(text));
      expect(model.tests.length).toBeGreaterThan(0);
      expect(await runFrameworkTests(model)).toEqual([]);
    }
  });
});

describe("atticus frameworks survey", () => {
  const repos = ["tide-web", "tide-bff", "tide-cards"].map((r) =>
    fsRepo(r, join(MESSY, "repos", r), SHA),
  );

  it("lists the house modules the repos import and how each imported name is used", async () => {
    const s = await surveyFrameworks(repos, { prefixes: ["@tide/", "tide.platform"] });
    expect(formatFrameworkSurvey(s)).toEqual([
      "@tide/lantern (js): 2 files in 1 repo, not modelled",
      "  imports: lantern, useApi",
      '  lantern.call(...) x1 in 1 repo, e.g. tide-web/src/pages/Limits.tsx:5: return lantern.call(Services.BFF, "POST", "/limits", { amount });',
      '  useApi(...) x1 in 1 repo, e.g. tide-web/src/pages/Statements.tsx:5: const { data } = useApi({ service: Services.BFF, path: `/statements/${id}`, method: "GET" });',
      "@tide/lantern/server (js): 2 files in 1 repo, not modelled",
      "  imports: defineRoute, lantern, router",
      '  defineRoute(...) x1 in 1 repo, e.g. tide-bff/src/routes.ts:5: defineRoute({ method: "GET", path: "/statements/:id", handler: statementFor });',
      '  lantern.call(...) x1 in 1 repo, e.g. tide-bff/src/handlers.ts:4: return lantern.call("cards", "GET", `/statements/${req.params.id}`);',
      '  router.route(...) x1 in 1 repo, e.g. tide-bff/src/routes.ts:6: router.route("POST", "/limits", raise);',
      "tide.platform.web (java): 2 files in 1 repo, not modelled",
      "  imports: InternalApi, Op",
      '  @InternalApi x1 in 1 repo, e.g. tide-cards/src/main/java/tide/cards/StatementsController.java:7: @InternalApi(basePath = "/statements")',
      '  @Op x1 in 1 repo, e.g. tide-cards/src/main/java/tide/cards/StatementsController.java:10: @Op(verb = "GET", path = "/{id}")',
      "tide.platform.http (java): 1 file in 1 repo, not modelled",
      "  imports: BankHttp",
      '  BankHttp.exchange(...) x1 in 1 repo, e.g. tide-cards/src/main/java/tide/cards/AuditClient.java:10: bankHttp.exchange(Services.AUDIT, "POST", "/audit/events", e);',
    ]);
  });

  it("says which model already covers a module", async () => {
    const models = await Promise.all(
      ["tide-lantern", "tide-platform"].map(async (n) =>
        FrameworkModel.parse(
          parse(await readFile(join(MESSY, `metarepo/org-pack/frameworks/${n}.yaml`), "utf8")),
        ),
      ),
    );
    const s = await surveyFrameworks(repos, { prefixes: ["@tide/", "tide.platform"], models });
    expect(s.modules.map((m) => `${m.module} ${m.modelled}`)).toEqual([
      "@tide/lantern tide-lantern",
      "@tide/lantern/server tide-lantern",
      "tide.platform.web tide-platform",
      "tide.platform.http tide-platform",
    ]);
  });

  it("reads Python, C# and Go imports too, and without prefixes leaves out what every estate imports", async () => {
    const repo = memoryRepo("kit-user", SHA, {
      "app/entries.py": `from bankkit import client
import requests
def post(e):
    return client.call("ledger", "POST", "/entries")
`,
      "src/Cards.cs": `using Bank.Kit;
using System.Text;
class Cards { void Get(string id) { _api.Send("cards", "GET", "/cards"); } }`,
      "events/publish.go": `package events
import (
  "fmt"
  kit "example.com/bank/kit"
)
func Issued() { kit.Publish("cards.issued"); fmt.Println("x") }`,
    });
    const s = await surveyFrameworks([repo]);
    expect(
      s.modules.map((m) => `${m.module} (${m.language}): ${m.uses.map((u) => u.use).join(", ")}`),
    ).toEqual([
      "Bank.Kit (csharp): _api.Send(...)",
      "bankkit (python): client.call(...)",
      "example.com/bank/kit (go): kit.Publish(...)",
    ]);
  });
});
