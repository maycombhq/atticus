import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declarationOutline, liveTrees } from "../src/index.js";

// ADR 0118: a file's declarations from the syntax tree the readers already parse, for the
// outline context tool. Annotations are shown as written; nothing says which are endpoints.

const VAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/code-search/repos/forge-vault",
);
const read = (p: string) => readFile(join(VAULT, p), "utf8");
const brief = (o: Awaited<ReturnType<typeof declarationOutline>>) =>
  o?.map(
    (e) =>
      `${e.line} ${"  ".repeat(e.depth)}${e.kind} ${e.name}${e.marks.map((m) => ` [${m.line} ${m.text}]`).join("")}`,
  );

describe("declarationOutline (ADR 0118)", () => {
  it("gives a Java file's classes and methods, each with its annotations as written", async () => {
    const before = liveTrees();
    const p = "src/main/java/forge/vault/web/SecretController.java";
    expect(brief(await declarationOutline(p, await read(p)))).toEqual([
      "8 class SecretController [7 @RestController]",
      '11   method list [10 @GetMapping("/secrets")]',
      '16   method rotate [15 @VaultRoute(path = "/rotate", verb = "POST")]',
    ]);
    const app = "src/main/java/forge/vault/VaultApplication.java";
    expect(brief(await declarationOutline(app, await read(app)))).toEqual([
      '8 class VaultApplication [6 @SpringBootApplication] [7 @ForgeServiceBase("/vault-api")]',
      "9   method main",
    ]);
    expect(liveTrees()).toBe(before);
  });

  it("gives TypeScript's interfaces, functions and a const bound to a function", async () => {
    const p = "tools/release.ts";
    expect(brief(await declarationOutline(p, await read(p)))).toEqual([
      "1 interface ReleaseNote",
      "5 function noteFor",
      "9 function latest",
    ]);
  });

  it("gives Python's decorated functions and classes, and nothing nested in a function", async () => {
    const src = [
      "@app.task(queue='ledger')",
      "def settle(batch):",
      "    def inner():",
      "        pass",
      "    return inner",
      "",
      "class Ledger:",
      "    @property",
      "    def total(self):",
      "        return 0",
      "",
    ].join("\n");
    expect(brief(await declarationOutline("jobs/settle.py", src))).toEqual([
      "2 function settle [1 @app.task(queue='ledger')]",
      "7 class Ledger",
      "9   function total [8 @property]",
    ]);
  });

  it("reads C#, Go, Kotlin and Rust the same way: the grammar's names, the marks as written", async () => {
    const cases: [string, string, string[]][] = [
      [
        "Api.cs",
        'namespace Forge { [ApiController]\n[Route("x")]\npublic class A { [HttpGet("y")]\npublic int F() { return 1; } } }',
        [
          "1 namespace Forge",
          '3   class A [1 [ApiController]] [2 [Route("x")]]',
          '4     method F [3 [HttpGet("y")]]',
        ],
      ],
      [
        "a.go",
        "package a\ntype S struct{}\nfunc (s S) Get() {}\nfunc Top() {}\n",
        ["2 type S", "3 method Get", "4 function Top"],
      ],
      [
        "A.kt",
        '@RestController\nclass A {\n  @GetMapping("/x")\n  fun f(): Int = 1\n}\n',
        ["2 class A [1 @RestController]", '4   function f [3 @GetMapping("/x")]'],
      ],
      [
        "lib.rs",
        '#[get("/x")]\nfn f() {}\nstruct S;\n',
        ['2 function f [1 #[get("/x")]]', "3 struct S"],
      ],
    ];
    for (const [p, src, want] of cases)
      expect(brief(await declarationOutline(p, src)), p).toEqual(want);
  });

  it("has no outline for a file without a grammar", async () => {
    expect(await declarationOutline("README.md", "# Forge Vault\n")).toBeUndefined();
  });
});
