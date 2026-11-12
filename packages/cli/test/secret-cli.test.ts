import { describe, expect, it } from "vitest";
import type { KeyStore } from "@maycombhq/model-providers";
import { secretCommand } from "../src/secret-commands.js";

/** atticus secret (ADR 0121 item 3): a provider's key kept in this machine's credential store. */

function memory(): KeyStore & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    get: (n) => kept.get(n),
    set: (n, v) => void kept.set(n, v),
    forget: (n) => void kept.delete(n),
  };
}

const run = async (
  args: string[],
  o: { stdin?: string; env?: NodeJS.ProcessEnv; store: KeyStore },
) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await secretCommand(
    args,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { store: o.store, env: o.env ?? {}, read: async () => o.stdin ?? "" },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const KEY = "sk-test-0123456789abcdefghij";

describe("atticus secret (ADR 0121)", () => {
  it("keeps a key read from stdin, and never prints it", async () => {
    const store = memory();
    const r = await run(["set", "ATTICUS_MODEL_KEY"], { stdin: `${KEY}\n`, store });
    expect(r.code).toBe(0);
    expect(store.kept.get("ATTICUS_MODEL_KEY")).toBe(KEY);
    expect(r.out + r.err).not.toContain(KEY);
    expect(r.out).toContain("ATTICUS_MODEL_KEY");
  });

  it("says where a key is found, by name only", async () => {
    const store = memory();
    store.set("STORED", KEY);
    expect((await run(["check", "STORED"], { store })).out).toMatch(/credential store/);
    expect((await run(["check", "FROM_ENV"], { store, env: { FROM_ENV: "x" } })).out).toMatch(
      /environment/,
    );
    const none = await run(["check", "NOPE"], { store });
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/isn't set/);
  });

  it("forgets a kept key", async () => {
    const store = memory();
    store.set("STORED", KEY);
    expect((await run(["forget", "STORED"], { store })).code).toBe(0);
    expect(store.kept.has("STORED")).toBe(false);
  });

  it("refuses a name that isn't a variable's, and an empty key", async () => {
    const store = memory();
    expect((await run(["set", "not a name"], { stdin: KEY, store })).code).toBe(2);
    expect((await run(["set", "OK_NAME"], { stdin: "  \n", store })).code).toBe(2);
    expect(store.kept.size).toBe(0);
  });

  it("beta.27 re-review: never says back what was typed where a name goes, nor a key after it", async () => {
    const store = memory();
    // A key typed as the name: refused, and not said back (it goes to the run's log and the screen).
    const keyLike = "Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5Fg7Hj0";
    for (const name of [KEY, keyLike, "has spaces", "tom@bank.example"]) {
      const r = await run(["set", name], { stdin: KEY, store });
      expect(r.code, name).toBe(2);
      expect(r.out + r.err, name).not.toContain(name);
      expect(r.err).toMatch(/isn't a variable's name/);
    }
    // A key typed on the command line after the name: refused before anything is read or kept.
    let read = false;
    const out: string[] = [];
    const code = await secretCommand(
      ["set", "ATTICUS_MODEL_KEY", keyLike],
      { out: (l) => out.push(l), err: (l) => out.push(l) },
      {
        store,
        env: {},
        read: async () => {
          read = true;
          return KEY;
        },
      },
    );
    expect(code).toBe(2);
    expect(read).toBe(false);
    expect(out.join("\n")).not.toContain(keyLike);
    expect(out.join("\n")).toMatch(/never given on the command line/);
    expect(store.kept.size).toBe(0);
  });
});
