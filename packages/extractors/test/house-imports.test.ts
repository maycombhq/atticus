import { describe, expect, it } from "vitest";
import { FrameworkModel } from "@maycombhq/core";
import { memoryRepo } from "@maycombhq/sdk";
import { frameworkNameOf, repoImports, unmodelledFrameworks } from "../src/index.js";

const SHA = "0".repeat(40);
const java = (pkg: string, imports: string[]) =>
  `package ${pkg};\n\n${imports.map((i) => `import ${i};`).join("\n")}\n\nclass A {}\n`;

/** An invented Harbor estate: two services on the Harbor kit, two web apps on its JS layer. */
const estate = () => [
  memoryRepo("harbor-orders", SHA, {
    "src/main/java/harbor/orders/Api.java": java("harbor.orders", [
      "harbor.kit.http.Dock",
      "harbor.kit.web.HarborApi",
      "org.springframework.web.bind.annotation.GetMapping",
      "com.google.common.collect.Lists",
      "harbor.audit.AuditTrail",
    ]),
    "src/test/java/harbor/orders/ApiTest.java": java("harbor.orders", ["harbor.testkit.Fixtures"]),
  }),
  memoryRepo("harbor-billing", SHA, {
    "src/main/kotlin/harbor/billing/Api.kt":
      "package harbor.billing\n\nimport harbor.kit.http.Dock\nimport com.google.common.collect.Lists\n\nclass Api\n",
  }),
  // The kit's own repo: its code isn't a framework it builds on.
  memoryRepo("harbor-kit", SHA, {
    "src/main/java/harbor/kit/http/Dock.java": java("harbor.kit.http", [
      "harbor.kit.web.HarborApi",
    ]),
  }),
  memoryRepo("harbor-web", SHA, {
    "package.json": JSON.stringify({ name: "@harbor/web" }),
    "src/cards.tsx": 'import { useApi } from "@harbor/lantern";\nimport React from "react";\n',
  }),
  memoryRepo("harbor-bff", SHA, {
    "package.json": JSON.stringify({ name: "@harbor/bff" }),
    "src/routes.ts": 'const { defineRoute } = require("@harbor/lantern");\nimport x from "./x";\n',
  }),
];

describe("house frameworks no model covers (ADR 0066)", () => {
  it("reads what a repo imports and declares, leaving out tests and well-known libraries", async () => {
    const r = await repoImports(estate()[0]!);
    expect([...r.modules.keys()].sort()).toEqual([
      "com.google.common.collect",
      "harbor.audit",
      "harbor.kit.http",
      "harbor.kit.web",
    ]);
    expect([...r.declared]).toEqual(["harbor.orders"]);
  });

  it("names the organisation's modules several repos import, by framework, most used first", async () => {
    const imports = await Promise.all(estate().map((r) => repoImports(r)));
    expect(unmodelledFrameworks(imports, [])).toEqual([
      {
        framework: "@harbor/lantern",
        name: "harbor-lantern",
        language: "js",
        repos: ["harbor-bff", "harbor-web"],
        modules: ["@harbor/lantern"],
      },
      {
        framework: "harbor.kit",
        name: "harbor-kit",
        language: "java",
        repos: ["harbor-billing", "harbor-orders"],
        modules: ["harbor.kit.http", "harbor.kit.web"],
      },
    ]);
  });

  it("leaves out a framework a model covers", async () => {
    const imports = await Promise.all(estate().map((r) => repoImports(r)));
    const model = FrameworkModel.parse({
      schemaVersion: 1,
      name: "harbor-kit",
      packages: ["harbor.kit"],
    });
    expect(unmodelledFrameworks(imports, [model]).map((f) => f.framework)).toEqual([
      "@harbor/lantern",
    ]);
  });

  it("names a model after its module", () => {
    expect([frameworkNameOf("tide.platform"), frameworkNameOf("@tide/lantern")]).toEqual([
      "tide-platform",
      "tide-lantern",
    ]);
  });
});
