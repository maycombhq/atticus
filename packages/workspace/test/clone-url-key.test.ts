import { describe, expect, it } from "vitest";
import { cloneUrlKey } from "../src/index.js";

/**
 * ADR 0199, the review (N3): repos discover tells a folder the manifest lists already by its
 * clone URL, and no longer reads it. A URL written another way must still be the same repo
 * (else it is read again and offered as new), and two repos must never be one (a false "already
 * listed" hides a new repo): only equivalences true of every Git host, each tested both ways.
 */

const same = (a: string, b: string) => expect(cloneUrlKey(a), `${a} = ${b}`).toBe(cloneUrlKey(b));
const differ = (a: string, b: string) =>
  expect(cloneUrlKey(a), `${a} ≠ ${b}`).not.toBe(cloneUrlKey(b));

describe("one repo, written two ways", () => {
  it("a percent-encoded name and the name itself", () => {
    same(
      "https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger",
      "https://dev.azure.com/forgeorg/Forge Payments/_git/forge-ledger",
    );
    // A stray % that is no encoding is kept as it is, never an error.
    expect(cloneUrlKey("https://git.forge.example/forge/100%-ledger")).toBe(
      "git.forge.example/forge/100%-ledger",
    );
  });

  it("a Windows path with either slash", () => {
    same("C:\\work\\clones\\forge-ledger", "C:/work/clones/forge-ledger");
    same("C:\\work\\clones\\forge-ledger\\", "c:/work/clones/forge-ledger");
  });

  it("ssh with its default port, and the scp form", () => {
    same(
      "ssh://git@git.forge.example:22/forge/ledger.git",
      "git@git.forge.example:forge/ledger.git",
    );
    same("ssh://git@git.forge.example/forge/ledger.git", "git@git.forge.example:forge/ledger");
    same(
      "https://git.forge.example:443/forge/ledger.git",
      "https://git.forge.example/forge/ledger",
    );
  });
});

describe("two repos, never one", () => {
  it("another port is another server", () => {
    differ("https://git.forge.example:8443/forge/ledger", "https://git.forge.example/forge/ledger");
    differ("ssh://git@git.forge.example:2222/forge/ledger", "git@git.forge.example:forge/ledger");
  });

  it("an encoded slash is part of a name, not a folder", () => {
    differ("https://git.forge.example/forge%2Fledger", "https://git.forge.example/forge/ledger");
  });

  // What one Git host calls the same repo under two addresses is that host's knowledge (an
  // adapter's, ADR 0035), not this function's: such a pair is read as two, and the folder is
  // read again and offered as new, never hidden.
  it("a host's own second address for a repo is not guessed", () => {
    differ(
      "https://git.forge.example/forgeorg/Payments/_git/forge-ledger",
      "git@ssh.git.forge.example:v3/forgeorg/Payments/forge-ledger",
    );
  });

  it("still names no clone for a folder of this metarepo", () => {
    expect(cloneUrlKey("./ledger")).toBeUndefined();
    expect(cloneUrlKey(".\\ledger")).toBeUndefined();
    expect(cloneUrlKey("../ledger")).toBeUndefined();
  });
});
