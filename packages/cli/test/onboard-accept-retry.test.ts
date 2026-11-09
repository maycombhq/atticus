import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Review round 46 (Windows): accepting a proposal moves it into the org pack, and on Windows a
 * virus scanner or the editor holding the file makes the first rename fail with EPERM or EBUSY.
 * The move is retried (renameRetrying), as every other move of Atticus's is.
 */
const busy = vi.hoisted(() => ({ left: 0 }));
vi.mock("node:fs/promises", async (real) => {
  const fs = await real<typeof import("node:fs/promises")>();
  const rename: typeof fs.rename = async (from, to) => {
    if (busy.left > 0) {
      busy.left--;
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return fs.rename(from, to);
  };
  return { ...fs, rename, default: { ...fs, rename } };
});

const { onboardAccept } = await import("../src/onboard-commands.js");

const GW = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/gateways");
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

let root: string | undefined;
afterEach(async () => {
  busy.left = 0;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("atticus onboard accept on Windows", () => {
  it("moves the proposal into the org pack when the first rename is refused for a moment", async () => {
    root = await mkdtemp(join(tmpdir(), "atticus-accept-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, "proposals", "dialects"), { recursive: true });
    const from = join(root, "proposals", "dialects", "tide-apim.yaml");
    await cp(join(GW, "metarepo", "org-pack", "dialects", "tide-apim.yaml"), from);
    const text = await readFile(from, "utf8");
    busy.left = 2;
    const c = capture();
    expect(await onboardAccept(root, "tide-apim", {}, c.io), c.err.join("\n")).toBe(0);
    expect(busy.left).toBe(0);
    expect(await readFile(join(root, "org-pack", "dialects", "tide-apim.yaml"), "utf8")).toBe(text);
    expect(await stat(from).catch(() => undefined)).toBeUndefined();
  });
});
