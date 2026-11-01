import { describe, expect, it } from "vitest";
import { Conventions } from "@maycombhq/core";
import { houseImportsUntaught, memorySource, readRulesOf } from "../src/index.js";

/**
 * R3 (ADR 0147): before the first read, the house packages a repo imports that no taught
 * framework covers, so the person teaches them first.
 */
const repo = memorySource({
  "src/main/java/com/forge/payouts/PayoutController.java": [
    "package com.forge.payouts;",
    "",
    "import com.forge.platform.web.InternalApi;",
    "import com.forge.platform.http.ForgeHttp;",
    "import static com.forge.audit.Audit.record;",
    "import org.springframework.web.bind.annotation.GetMapping;",
    "",
    "@InternalApi class PayoutController {}",
  ].join("\n"),
  "src/main/java/com/forge/payouts/Payouts.java": [
    "package com.forge.payouts;",
    "import com.forge.platform.web.Op;",
    "class Payouts {}",
  ].join("\n"),
  "web/src/api.ts": [
    'import { lanternCall } from "@forge/lantern";',
    'import axios from "axios";',
    'const ui = require("@forge/ui-kit/buttons");',
  ].join("\n"),
  // tests and installed packages are not the product's
  "src/test/java/com/forge/payouts/Setup.java": "import com.forge.testkit.Fixtures;\n",
  "web/node_modules/@forge/vendored/index.js": 'import x from "@forge/vendored";\n',
  // a comment or a string that isn't an import line names no package
  "web/src/notes.ts": '// the old code used com.forge.legacy\nconst s = "@forge/legacy";\n',
});

describe("houseImportsUntaught (R3)", () => {
  it("says nothing without house prefixes", () => {
    expect(houseImportsUntaught(repo, { prefixes: [], taught: [] })).toEqual([]);
  });

  it("lists each house package the repo imports, most used first, with the learn command", () => {
    const found = houseImportsUntaught(repo, { prefixes: ["com.forge.", "@forge/"], taught: [] });
    expect(found.map((h) => [h.package, h.name, h.files, h.first])).toEqual([
      [
        "com.forge.platform",
        "forge-platform",
        2,
        "src/main/java/com/forge/payouts/PayoutController.java:3",
      ],
      ["@forge/lantern", "forge-lantern", 1, "web/src/api.ts:1"],
      ["@forge/ui-kit", "forge-ui-kit", 1, "web/src/api.ts:3"],
      [
        "com.forge.audit",
        "forge-audit",
        1,
        "src/main/java/com/forge/payouts/PayoutController.java:5",
      ],
      // the repo's own package line is not an import; com.forge.payouts is never listed
    ]);
    expect(found[0]!.command).toBe(
      "atticus frameworks learn forge-platform --from <its source, JAR or npm package> --package com.forge.platform",
    );
  });

  it("leaves out what a taught framework's packages cover, whole parts only", () => {
    const found = houseImportsUntaught(repo, {
      prefixes: ["com.forge.", "@forge/"],
      taught: ["com.forge.platform", "@forge/lantern", "com.forge.aud"],
    });
    expect(found.map((h) => h.package)).toEqual(["@forge/ui-kit", "com.forge.audit"]);
  });

  it("reads the organisation's not-product folders", () => {
    const rules = readRulesOf(Conventions.parse({ schemaVersion: 1, notProductFolders: [] }));
    const found = houseImportsUntaught(repo, { prefixes: ["com.forge."], taught: [], rules });
    expect(found.map((h) => h.package)).toContain("com.forge.testkit");
  });
});
