import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitError, loadRepos, type GitRunner } from "@maycombhq/workspace";
import { gitFailureWords, workspaceSync } from "../src/workspace-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
/**
 * Beta.30: a sync that fails on sign-in, a proxy or a certificate says what to do in a plain
 * line, and keeps git's own line after it. No network: git is a mock that fails as git does.
 */
const AUTH = [
  "remote: HTTP Basic: Access denied.",
  "fatal: Authentication failed for 'https://git.example.com/forge/forge-ledger.git/'",
];
const NO_PROMPT = [
  "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled",
];
const SSH = [
  "git@git.example.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
];
const PROXY = [
  "fatal: unable to access 'https://git.example.com/forge/forge-ledger.git/': Received HTTP code 407 from proxy after CONNECT",
];
const PROXY_NAMED = [
  "fatal: unable to access 'https://git.example.com/forge/forge-ledger.git/': The requested URL returned error: 407 Proxy Authentication Required",
];
const TLS = [
  "fatal: unable to access 'https://git.example.com/forge/forge-ledger.git/': SSL certificate problem: unable to get local issuer certificate",
];
const TLS_SELF = [
  "fatal: unable to access 'https://git.example.com/forge/forge-ledger.git/': SSL certificate problem: self-signed certificate in certificate chain",
];
const TLS_SCHANNEL = [
  "fatal: unable to access 'https://git.example.com/forge/forge-ledger.git/': schannel: SEC_E_UNTRUSTED_ROOT (0x80090325) - The certificate chain was issued by an authority that is not trusted.",
];

describe("what a failed git says to do", () => {
  it("names sign-in, the proxy and the certificate, each with its cure", () => {
    for (const lines of [AUTH, NO_PROMPT, SSH]) {
      const w = gitFailureWords(lines.join("\n"))!;
      expect(w, lines[0]).toMatch(/^Git couldn't sign in to the remote/);
      expect(w).toContain("git fetch");
      expect(w).toContain("in a terminal");
    }
    for (const lines of [PROXY, PROXY_NAMED]) {
      const w = gitFailureWords(lines.join("\n"))!;
      expect(w, lines[0]).toMatch(/^The proxy asked for a sign-in \(407\)/);
      expect(w).toContain("git config --global http.proxy");
      expect(w).toContain("HTTPS_PROXY");
    }
    for (const lines of [TLS, TLS_SELF, TLS_SCHANNEL]) {
      const w = gitFailureWords(lines.join("\n"))!;
      expect(w, lines[0]).toMatch(/^Git doesn't trust the server's certificate/);
      expect(w).toContain("git config --global http.sslCAInfo");
      expect(w).toContain("NODE_EXTRA_CA_CERTS");
      // Never the unsafe way out.
      expect(w).not.toMatch(/sslVerify false|NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });

  it("says a proxy's 407 is the proxy's, though the line also reads as a failed sign-in", () => {
    expect(gitFailureWords(`${PROXY_NAMED[0]}\nfatal: Authentication failed`)).toMatch(
      /^The proxy/,
    );
  });

  it("says nothing of a failure it doesn't know", () => {
    expect(gitFailureWords("fatal: repository 'https://git.example.com/x.git/' not found")).toBe(
      undefined,
    );
    expect(gitFailureWords("the base clone has local changes; base clones are read-only")).toBe(
      undefined,
    );
    // A repo or branch whose name has 407 in it is no proxy.
    expect(gitFailureWords("fatal: couldn't find remote ref release-407")).toBe(undefined);
  });
});

describe("atticus workspace sync, when git fails", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "atticus-sync-words-"));
    await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const failing =
    (stderr: string[]): GitRunner =>
    async (args) => {
      if (args[0] === "clone" || args[0] === "fetch") {
        const text = stderr.join("\n");
        // As the real runner words it: the command, then the end of git's stderr.
        throw new GitError(`git ${args[0]} failed: ${stderr.slice(-3).join(" ")}`, args, 128, text);
      }
      return { stdout: "", stderr: "" };
    };

  const sync = async (stderr: string[]) => {
    const [repo] = await loadRepos(root);
    const out: string[] = [];
    const err: string[] = [];
    const code = await workspaceSync(
      root,
      [repo!.id],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { git: failing(stderr) },
    );
    return { id: repo!.id, code, out, err };
  };

  it.each([
    ["a failed sign-in", AUTH, /^Git couldn't sign in to the remote/],
    ["a proxy's 407", PROXY, /^The proxy asked for a sign-in \(407\)/],
    ["a certificate git doesn't trust", TLS, /^Git doesn't trust the server's certificate/],
  ])("says what to do about %s, then git's own line", async (_name, stderr, plain) => {
    const r = await sync(stderr);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(2);
    expect(r.err[0]!.startsWith(`${r.id}: `)).toBe(true);
    expect(r.err[0]!.slice(r.id.length + 2)).toMatch(plain);
    expect(r.err[1]).toBe(`${r.id}: failed (git clone failed: ${stderr.slice(-3).join(" ")})`);
  });

  it("leaves any other failure as git said it, one line", async () => {
    const r = await sync(["fatal: repository 'https://git.example.com/forge/x.git/' not found"]);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      `${r.id}: failed (git clone failed: fatal: repository 'https://git.example.com/forge/x.git/' not found)`,
    ]);
  });
});
