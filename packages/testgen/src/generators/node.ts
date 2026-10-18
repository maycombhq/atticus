import type { GeneratedFile } from "../header.js";
import type { ApiCase, ContractCase, DataCase, EventCase, RepoTests, TestModel } from "../model.js";
import { quote } from "../words.js";
import type { RenderContext, TestGenerator } from "./types.js";

/**
 * Vitest or Jest + fetch skeletons for Node and TypeScript repos (Node 18+ has fetch): API
 * tests against ATTICUS_BASE_URL, consumer contract tests against a stub of the provider
 * (ATTICUS_STUB_URL), provider tests against the service. Data and event checks need the
 * team's own harness, so they are written as todo tests that list what to check.
 */

const CODE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

const json = (v: unknown, indent: string) =>
  JSON.stringify(v, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : `${indent}${l}`))
    .join("\n");

function statusCheck(status: string): string {
  if (/^\d{3}$/.test(status)) return `expect(res.status).toBe(${status});`;
  const d = /^([1-5])XX$/i.exec(status)?.[1] ?? "4";
  return `expect(Math.floor(res.status / 100)).toBe(${d});`;
}

const url = (
  base: string,
  path: string,
  params: Record<string, unknown>,
  query: Record<string, unknown>,
) => {
  const p = path.replace(
    /\{([^}]+)\}/g,
    (_, k: string) => `\${encodeURIComponent(String(${JSON.stringify(params[k] ?? 1)}))}`,
  );
  const q = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `\`\${${base}}${p}${q ? `?${q}` : ""}\``;
};

function headers(c: ApiCase): string[] {
  const h: string[] = [];
  if (c.request.body !== undefined) h.push(`"content-type": "application/json"`);
  if (c.request.auth === "valid") {
    if (c.request.authType === "basic")
      h.push(
        'authorization: `Basic ${Buffer.from(`${env("ATTICUS_USER")}:${env("ATTICUS_PASSWORD")}`).toString("base64")}`',
      );
    else if (c.request.authType === "apiKey" || c.request.authType === "api-key")
      h.push(`[env("ATTICUS_API_KEY_HEADER", "x-api-key")]: env("ATTICUS_API_KEY")`);
    else h.push('authorization: `Bearer ${env("ATTICUS_TOKEN")}`');
  } else if (c.request.auth === "no-scope") {
    const v = `ATTICUS_TOKEN_WITHOUT_${c.request.scope!.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    h.push(`authorization: \`Bearer \${env("${v}")}\``);
  }
  return h;
}

function apiTest(c: ApiCase): string[] {
  const lines: string[] = [];
  const skip = c.request.auth === "no-scope";
  const v = skip
    ? `ATTICUS_TOKEN_WITHOUT_${c.request.scope!.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    : "";
  lines.push(`  it${skip ? `.skipIf(!process.env.${v})` : ""}("${quote(c.name)}", async () => {`);
  if (c.kind === "error") lines.push(`    // ${c.why}`);
  const dataVar = c.data && (c.kind === "happy" || c.kind === "error") ? c.data.name : "body";
  if (c.request.body !== undefined)
    lines.push(`    const ${dataVar} = ${json(c.request.body, "    ")};`);
  const h = headers(c);
  lines.push(
    `    const res = await fetch(${url("BASE_URL", c.path, c.request.pathParams, c.request.query)}, {`,
    `      method: "${c.method}",`,
    ...(h.length ? [`      headers: { ${h.join(", ")} },`] : []),
    ...(c.request.body !== undefined ? [`      body: JSON.stringify(${dataVar}),`] : []),
    `    });`,
    `    ${statusCheck(c.expect.status)}`,
  );
  if (c.kind === "happy" || c.kind === "error") {
    const checks: string[] = [];
    const b = c.expect.body;
    if (b && typeof b === "object" && !Array.isArray(b))
      for (const [k, val] of Object.entries(b as Record<string, unknown>))
        if (typeof val === "string" && CODE.test(val))
          checks.push(`    expect(json).toHaveProperty("${quote(k)}", "${quote(val)}");`);
    for (const f of c.expect.fields)
      if (!checks.some((x) => x.includes(`"${f}"`)))
        checks.push(`    expect(json).toHaveProperty("${quote(f)}");`);
    if (checks.length)
      lines.push(`    const json = (await res.json()) as Record<string, unknown>;`, ...checks);
  }
  lines.push("  });");
  return lines;
}

function contractTest(c: ContractCase): string[] {
  const lines = [`  // ${c.checks.join("; ")}`, ...c.gaps.map((g) => `  // Gap: ${g}`)];
  if (c.topic) return [...lines, `  it.todo("${quote(c.name)}");`];
  const base = c.role === "consumer" ? "STUB_URL" : "BASE_URL";
  const params = Object.fromEntries(
    [...(c.path ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, 1]),
  );
  lines.push(`  it("${quote(c.name)}", async () => {`);
  if (c.request.example !== undefined)
    lines.push(`    const body = ${json(c.request.example, "    ")};`);
  const h = [
    ...(c.request.example !== undefined ? [`"content-type": "application/json"`] : []),
    ...(c.role === "provider" ? ['authorization: `Bearer ${env("ATTICUS_TOKEN")}`'] : []),
  ];
  lines.push(
    `    const res = await fetch(${url(base, c.path ?? "/", params, {})}, {`,
    `      method: "${c.method ?? "GET"}",`,
    ...(h.length ? [`      headers: { ${h.join(", ")} },`] : []),
    ...(c.request.example !== undefined ? [`      body: JSON.stringify(body),`] : []),
    `    });`,
    c.response.status
      ? `    ${statusCheck(c.response.status)}`
      : `    expect(res.status).toBeLessThan(400);`,
  );
  if (c.response.fields.length)
    lines.push(
      `    const json = (await res.json()) as Record<string, unknown>;`,
      ...c.response.fields.map(
        (f) => `    expect(json).toHaveProperty("${quote(f.split(/[.[]/)[0]!)}");`,
      ),
    );
  lines.push("  });");
  return lines;
}

const todo = (c: DataCase | EventCase) => [
  `  // ${c.checks.join("; ")}`,
  `  it.todo("${quote(c.name)}");`,
];

function file(
  m: TestModel,
  runner: "vitest" | "jest",
  what: string,
  body: string[],
  bases: string[],
): string {
  return [
    runner === "vitest"
      ? `import { describe, expect, it } from "vitest";`
      : `import { describe, expect, it } from "@jest/globals";`,
    "",
    `const env = (name: string, fallback = "") => process.env[name] || fallback;`,
    ...bases,
    "",
    `describe("${quote(`${what} for story ${m.story.id} (change ${m.change})`)}", () => {`,
    ...body,
    "});",
    "",
  ].join("\n");
}

function generator(runner: "vitest" | "jest"): TestGenerator {
  return {
    id: `${runner}-fetch`,
    version: "1.0.0",
    generic: false,
    appliesTo: (repo: RepoTests) =>
      repo.language === "node" && (repo.runner ?? "vitest") === runner,
    render(model, repo, ctx: RenderContext): GeneratedFile[] {
      const dir = "test/atticus";
      const out: GeneratedFile[] = [];
      const add = (kind: string, content: string, cases: { id: string }[]) =>
        out.push({
          path: `${dir}/${model.story.id}.${kind}.test.ts`,
          content,
          style: "slash",
          source: ctx.source,
          cases: cases.map((c) => c.id),
        });
      const BASE = `const BASE_URL = env("ATTICUS_BASE_URL", "http://localhost:3000");`;
      const STUB = `const STUB_URL = env("ATTICUS_STUB_URL", "http://127.0.0.1:4010");`;
      const api = repo.cases.filter((c): c is ApiCase => c.type === "api");
      const contracts = repo.cases.filter((c): c is ContractCase => c.type === "contract");
      const rest = repo.cases.filter(
        (c): c is DataCase | EventCase => c.type === "data" || c.type === "event",
      );
      const fixSkip = (lines: string[]) =>
        runner === "jest"
          ? lines.map((l) =>
              l.replace(
                /it\.skipIf\((![^)]+)\)\(/,
                (_, cond: string) => `(${cond} ? it.skip : it)(`,
              ),
            )
          : lines;
      if (api.length)
        add(
          "api",
          file(
            model,
            runner,
            "API tests",
            fixSkip(api.flatMap((c, i) => [...(i ? [""] : []), ...apiTest(c)])),
            [BASE],
          ),
          api,
        );
      if (contracts.length)
        add(
          "contract",
          file(
            model,
            runner,
            "Contract tests",
            contracts.flatMap((c, i) => [...(i ? [""] : []), ...contractTest(c)]),
            [BASE, STUB],
          ),
          contracts,
        );
      if (rest.length)
        add(
          "data-and-events",
          file(
            model,
            runner,
            "Data and event tests",
            rest.flatMap((c, i) => [...(i ? [""] : []), ...todo(c)]),
            [],
          ),
          rest,
        );
      return out;
    },
  };
}

export const vitestGenerator = generator("vitest");
export const jestGenerator = generator("jest");
