import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildStub,
  checkStub,
  startStub,
  stubFromCatalog,
  stubHandler,
  type Stub,
} from "@maycombhq/stubs";
import type { Output } from "./commands.js";
import { loadCatalog } from "./diagram-commands.js";
import { table } from "./index-commands.js";

const EXAMPLES = new Set(["example", "examples", "schema-example", "schema-default"]);

async function readStub(path: string, io: Output): Promise<Stub | number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    io.err(`Can't read ${path}`);
    return 2;
  }
  try {
    return buildStub(text);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
}

/**
 * atticus stub serve <spec> [--port n] [--catalog]: serve a deterministic stub of a spec, or
 * with --catalog of a component's or system's endpoints in the catalog. `listen` is the
 * server start; tests pass a fake, so nothing here needs a socket until the very end.
 */
export async function stubServe(
  root: string,
  specOrId: string,
  o: { port?: number; host?: string; catalog?: boolean },
  io: Output,
  listen: typeof startStub = startStub,
): Promise<number> {
  const port = o.port ?? 4010;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.err(`--port must be a whole number from 0 to 65535.`);
    return 2;
  }
  let stub: Stub;
  if (o.catalog) {
    const { records, generated } = await loadCatalog(root, io);
    if (generated === 0) {
      io.err("The catalog is empty: run atticus scan first.");
      return 1;
    }
    try {
      stub = stubFromCatalog(records, specOrId);
    } catch (e) {
      io.err((e as Error).message);
      return 1;
    }
  } else {
    const r = await readStub(resolve(root, specOrId), io);
    if (typeof r === "number") return r;
    stub = r;
  }
  for (const w of stub.warnings) io.err(`warning: ${w}`);
  if (stub.routes.length === 0) {
    io.err(`${stub.title} has no operations to serve.`);
    return 1;
  }
  const server = await listen(stubHandler(stub), { port, host: o.host ?? "127.0.0.1" });
  const n = stub.routes.length;
  io.out(`Serving ${stub.title} at ${server.url} (${n} operation${n === 1 ? "" : "s"}).`);
  for (const l of table(
    ["METHOD", "PATH", "ANSWERS"],
    stub.routes.map((r) => [r.method, r.path, `${r.status} (${r.example})`]),
  ))
    io.out(`  ${l}`);
  if (stub.basePaths.length > 0) io.out(`Paths also work under ${stub.basePaths.join(", ")}.`);
  io.out("Ask for another documented response with X-Stub-Status: <code>. Stop with Ctrl+C.");
  return 0;
}

/**
 * atticus stub check <spec>: which operations have examples. Exit 0 when every operation has
 * an example or no body, 1 when the stub would build some bodies from the schema, 2 when the
 * spec can't be read.
 */
export async function stubCheck(specPath: string, io: Output): Promise<number> {
  const r = await readStub(resolve(specPath), io);
  if (typeof r === "number") return r;
  for (const w of r.warnings) io.err(`warning: ${w}`);
  const rows = checkStub(r);
  for (const l of table(
    ["METHOD", "PATH", "STATUS", "EXAMPLE"],
    rows.map((x) => [x.method, x.path, String(x.status), x.example]),
  ))
    io.out(l);
  const generated = rows.filter((x) => x.example === "generated").length;
  const withExamples = rows.filter((x) => EXAMPLES.has(x.example)).length;
  if (generated === 0) {
    io.out(
      `All ${rows.length} operation${rows.length === 1 ? " has" : "s have"} an example or no body (${withExamples} with examples).`,
    );
    return 0;
  }
  io.out(
    `${generated} of ${rows.length} operation${rows.length === 1 ? "" : "s"} ${generated === 1 ? "has" : "have"} no example: the stub builds ${generated === 1 ? "that body" : "those bodies"} from the schema. Add examples to control what it returns.`,
  );
  return 1;
}
