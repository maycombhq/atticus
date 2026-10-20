import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { readDrawio } from "@maycombhq/reconcile";
import type { StubHandler } from "@maycombhq/stubs";
import { diagramLibrary, diagramRender } from "../src/diagram-commands.js";
import { stubCheck, stubServe } from "../src/stub-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const GOLDEN = join(HERE, "../../diagrams/test/fixtures/golden");
const SPECS = join(HERE, "../../stubs/test/fixtures/specs");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the expected catalog as files, the diagram and the specs. */
async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-diagram-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "inputs/diagrams"), join(root, "inputs/diagrams"), { recursive: true });
  await cp(SPECS, join(root, "specs"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

describe("atticus diagram render", () => {
  it("prints a catalog view as JSON for the app's canvas: its groups, nodes and edges", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await diagramRender(root, { view: "data", format: "json" }, c.io)).toBe(0);
    const v = JSON.parse(c.out.join("\n")) as {
      type: string;
      groups: { id: string }[];
      nodes: { id: string; group?: string }[];
      edges: { from: string; to: string; label: string }[];
    };
    expect(v.type).toBe("data");
    expect(v.edges.length).toBeGreaterThan(0);
    // Every edge joins two nodes of the view, and every grouped node's group is drawn.
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) expect([ids.has(e.from), ids.has(e.to)]).toEqual([true, true]);
    const groups = new Set(v.groups.map((g) => g.id));
    for (const n of v.nodes) if (n.group) expect(groups.has(n.group)).toBe(true);
    // A sequence view has no canvas form.
    const s = capture();
    expect(
      await diagramRender(root, { view: "sequence", focus: "portal-ui", format: "json" }, s.io),
    ).toBe(2);
    expect(s.err.join("\n")).toMatch(/Mermaid only/);
  });

  it("prints a catalog view as Mermaid", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await diagramRender(root, { view: "context" }, c.io)).toBe(0);
    expect(`${c.out.join("\n")}\n`).toBe(readFileSync(join(GOLDEN, "forge-context.mmd"), "utf8"));
  });

  it("takes a focus for container, data, event and sequence views", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await diagramRender(root, { view: "container", focus: "portal" }, c.io)).toBe(0);
    expect(`${c.out.join("\n")}\n`).toBe(
      readFileSync(join(GOLDEN, "forge-container-portal.mmd"), "utf8"),
    );
    const s = capture();
    expect(
      await diagramRender(
        root,
        { view: "sequence", focus: "portal-ui,portal-bff,ledger-api,northwind-pay" },
        s.io,
      ),
    ).toBe(0);
    expect(`${s.out.join("\n")}\n`).toBe(readFileSync(join(GOLDEN, "forge-sequence.mmd"), "utf8"));
  });

  it("writes a draw.io file that reads back with the catalog's names", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await diagramRender(
        root,
        { view: "context", format: "drawio", out: "out/context.drawio" },
        c.io,
      ),
    ).toBe(0);
    expect(c.out).toEqual(["Wrote out/context.drawio."]);
    const d = readDrawio(await readFile(join(root, "out/context.drawio"), "utf8"));
    expect(d.nodes.map((n) => n.label)).toEqual([
      "Audit",
      "Ledger",
      "Northwind Pay",
      "Portal",
      "Reports",
    ]);
    expect(d.edges).toHaveLength(7);
  });

  it("shows a .drawio file as Mermaid", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await diagramRender(root, { view: "inputs/diagrams/forge-context.drawio" }, c.io)).toBe(
      0,
    );
    expect(`${c.out.join("\n")}\n`).toBe(readFileSync(join(GOLDEN, "forge-drawio.mmd"), "utf8"));
  });

  it("exits 2 for usage mistakes and 1 when the catalog can't answer", async () => {
    const root = await forgeRoot();
    const run = async (o: Parameters<typeof diagramRender>[1], r = root) => {
      const c = capture();
      return [await diagramRender(r, o, c.io), c.err.join("\n")] as const;
    };
    expect(await run({ view: "galaxy" })).toEqual([
      2,
      expect.stringMatching(/Unknown view "galaxy"/),
    ]);
    expect(await run({ view: "context", format: "svg" })).toEqual([
      2,
      expect.stringMatching(/Unknown format/),
    ]);
    expect(await run({ view: "container" })).toEqual([2, expect.stringMatching(/--focus/)]);
    expect(await run({ view: "sequence", focus: "portal-ui", format: "drawio" })).toEqual([
      2,
      expect.stringMatching(/Mermaid only/),
    ]);
    expect(await run({ view: "missing.drawio" })).toEqual([2, "Can't read missing.drawio"]);
    expect(await run({ view: "container", focus: "nope" })).toEqual([
      1,
      'No system "nope" in the catalog.',
    ]);
    const empty = await mkdtemp(join(tmpdir(), "atticus-cli-diagram-empty-"));
    expect(await run({ view: "context" }, empty)).toEqual([
      1,
      "The catalog is empty: run atticus scan first.",
    ]);
  });
});

describe("atticus diagram library", () => {
  it("writes the draw.io shape library", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cli-lib-"));
    const c = capture();
    expect(await diagramLibrary(join(dir, "atticus.xml"), c.io)).toBe(0);
    expect(await readFile(join(dir, "atticus.xml"), "utf8")).toMatch(/^<mxlibrary>\[\{"xml":/);
    expect(c.out[0]).toMatch(/Open Library/);
  });
});

describe("atticus stub check", () => {
  it("lists what each operation answers with, and exits 1 when some bodies are generated", async () => {
    const c = capture();
    expect(await stubCheck(join(SPECS, "accounts-openapi.yaml"), c.io)).toBe(1);
    expect(c.out).toEqual([
      "METHOD  PATH                               STATUS  EXAMPLE",
      "GET     /accounts                          200     examples",
      "POST    /accounts                          201     example",
      "GET     /accounts/me                       200     generated",
      "DELETE  /accounts/{id}                     204     none",
      "GET     /accounts/{id}                     200     example",
      "GET     /accounts/{id}/statements/{month}  200     schema-example",
      "1 of 6 operations has no example: the stub builds that body from the schema. Add examples to control what it returns.",
    ]);
  });

  it("exits 0 when every operation has an example or no body, 2 when the spec can't be read", async () => {
    const c = capture();
    expect(await stubCheck(join(FORGE, "repos/forge-ledger/api/ledger-openapi.yaml"), c.io)).toBe(
      0,
    );
    expect(c.out.at(-1)).toBe("All 2 operations have an example or no body (0 with examples).");
    expect(await stubCheck(join(SPECS, "missing.yaml"), capture().io)).toBe(2);
    const bad = await mkdtemp(join(tmpdir(), "atticus-cli-stub-"));
    await writeFile(join(bad, "x.yaml"), "title: not a spec\n");
    const b = capture();
    expect(await stubCheck(join(bad, "x.yaml"), b.io)).toBe(1);
    expect(b.err).toEqual(["This file is not an OpenAPI 3 or Swagger 2.0 spec."]);
  });
});

describe("atticus stub serve (everything before listen)", () => {
  function fakeListen() {
    const got: { handler?: StubHandler; port?: number; host?: string } = {};
    const listen = (handler: StubHandler, o: { port: number; host?: string }) => {
      Object.assign(got, { handler, port: o.port, host: o.host });
      return Promise.resolve({
        url: `http://${o.host ?? "127.0.0.1"}:${o.port}`,
        port: o.port,
        close: () => Promise.resolve(),
      });
    };
    return { got, listen };
  }

  async function get(handler: StubHandler, url: string) {
    const req = Object.assign(Readable.from([]), { method: "GET", url, headers: {} });
    return new Promise<{ status: number; body: string }>((done) => {
      let status = 0;
      void handler(req, {
        writeHead: (s: number) => (status = s),
        end: (body?: string) => done({ status, body: body ?? "" }),
      });
    });
  }

  it("builds the stub from a spec, binds to 127.0.0.1 and lists the operations", async () => {
    const root = await forgeRoot();
    const { got, listen } = fakeListen();
    const c = capture();
    expect(await stubServe(root, "specs/accounts-openapi.yaml", { port: 4010 }, c.io, listen)).toBe(
      0,
    );
    expect(got).toMatchObject({ port: 4010, host: "127.0.0.1" });
    expect(c.out[0]).toBe("Serving Forge Accounts API at http://127.0.0.1:4010 (6 operations).");
    expect(c.out).toContain("  GET     /accounts/me                       200 (generated)");
    expect(c.out).toContain("Paths also work under /v1.");
    const r = await get(got.handler!, "/v1/accounts/42");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ id: 42 });
  });

  it("serves a catalog component or system with --catalog", async () => {
    const root = await forgeRoot();
    const { got, listen } = fakeListen();
    const c = capture();
    expect(await stubServe(root, "ledger", { port: 4020, catalog: true }, c.io, listen)).toBe(0);
    expect(c.out[0]).toBe(
      "Serving Catalog stub for ledger at http://127.0.0.1:4020 (2 operations).",
    );
    expect((await get(got.handler!, "/ledger/v1/accounts/7/balance")).status).toBe(200);
    expect(await stubServe(root, "nope", { catalog: true }, capture().io, listen)).toBe(1);
  });

  it("exits 2 for an unreadable spec or a bad port, before listening", async () => {
    const root = await forgeRoot();
    const { got, listen } = fakeListen();
    expect(await stubServe(root, "specs/missing.yaml", {}, capture().io, listen)).toBe(2);
    expect(
      await stubServe(root, "specs/accounts-openapi.yaml", { port: 70000 }, capture().io, listen),
    ).toBe(2);
    expect(got.handler).toBeUndefined();
  });
});
