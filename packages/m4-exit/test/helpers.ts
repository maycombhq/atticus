import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { main } from "@maycombhq/cli/dist/main.js";
import { startUi } from "@maycombhq/cli/dist/ui-commands.js";

/**
 * Shared set-up for the M4 exit suite: a fresh practice sandbox (`atticus sandbox create`, the
 * invented Forge ecosystem with every adapter a mock), the real CLI entry point and the local
 * server. Nothing touches the network and no AI runs.
 */

for (const [k, v] of Object.entries({
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_TERMINAL_PROMPT: "0",
}))
  process.env[k] ??= v;

export interface Result {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

export async function atticus(root: string | undefined, ...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(root ? [...args, "--root", root] : args, {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

export const json = <T>(r: Result): T => JSON.parse(r.out.join("\n")) as T;

/** A new practice sandbox; returns its metarepo. */
export async function sandbox(): Promise<{ top: string; root: string }> {
  const top = join(await mkdtemp(join(tmpdir(), "atticus-m4-")), "sandbox");
  const r = await atticus(undefined, "sandbox", "create", top);
  if (r.code !== 0) throw new Error(r.text);
  return { top, root: join(top, "metarepo") };
}

export interface App {
  url: string;
  call: <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** The app's local server for a metarepo, signed in as a person. */
export async function app(root: string, user: string): Promise<App> {
  const srv = await startUi(root, { port: 0, user });
  return {
    url: srv.url,
    call: async <T>(method: string, path: string, body?: unknown) => {
      const r = await fetch(srv.url + path, {
        method,
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as T };
    },
    close: () => srv.close(),
  };
}

/** sha256 of every file under a folder, by relative path with forward slashes. */
export async function fingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[relative(dir, p).split(sep).join("/")] = createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
  }
  return out;
}

/** Elapsed milliseconds of each named step, printed at the end so the exit report can quote them. */
export class Clock {
  private t = performance.now();
  readonly steps: { step: string; ms: number }[] = [];
  lap(step: string) {
    const now = performance.now();
    this.steps.push({ step, ms: Math.round(now - this.t) });
    this.t = now;
  }
  get total() {
    return this.steps.reduce((a, s) => a + s.ms, 0);
  }
  report(title: string) {
    console.log(
      `${title}: ${this.total} ms\n${this.steps.map((s) => `  ${s.step}: ${s.ms} ms`).join("\n")}`,
    );
  }
}
