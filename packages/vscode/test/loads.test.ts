import { describe, expect, it } from "vitest";
import { Loads } from "../src/loads";

/**
 * What a section shows while it reads (0.3.1): nothing read yet is a "Reading…" row (undefined
 * here); once read, the rows; a refresh keeps the rows on show until the new ones are read, so
 * nothing flickers; and a read that ends after a newer one started is dropped.
 */

const later = <T>() => {
  let done!: (v: T) => void;
  const p = new Promise<T>((a) => {
    done = a;
  });
  return { p, done };
};
const none = () => undefined;

describe("reading a section's rows", () => {
  it("has nothing to show until the first read ends, then calls back", async () => {
    const l = new Loads<string[]>();
    const r = later<string[]>();
    const ended: string[][] = [];
    const fail = () => ["failed"];
    expect(
      l.get(
        "top",
        () => r.p,
        (v) => ended.push(v),
        fail,
      ),
    ).toBeUndefined();
    r.done(["a", "b"]);
    await l.wait("top", () => r.p, fail);
    expect(ended).toEqual([["a", "b"]]);
    expect(l.get("top", () => Promise.resolve(["x"]), none, fail)).toEqual(["a", "b"]);
  });

  it("reads once, however often it is asked", async () => {
    const l = new Loads<number>();
    let reads = 0;
    const read = () => Promise.resolve(++reads);
    l.get("k", read, none, () => 0);
    l.get("k", read, none, () => 0);
    expect(await l.wait("k", read, () => 0)).toBe(1);
    expect(reads).toBe(1);
  });

  it("keeps showing the rows read before a refresh until the new ones are read", async () => {
    const l = new Loads<string>();
    await l.wait(
      "k",
      () => Promise.resolve("old"),
      () => "",
    );
    l.refresh();
    const r = later<string>();
    expect(
      l.get(
        "k",
        () => r.p,
        none,
        () => "",
      ),
    ).toBe("old");
    r.done("new");
    expect(
      await l.wait(
        "k",
        () => r.p,
        () => "",
      ),
    ).toBe("new");
  });

  it("shows a failed read as what fail makes of it, and reads again after a refresh", async () => {
    const l = new Loads<string>();
    const failed = await l.wait(
      "k",
      () => Promise.reject(new Error("no API")),
      (e) => `error: ${(e as Error).message}`,
    );
    expect(failed).toBe("error: no API");
    l.refresh();
    expect(
      await l.wait(
        "k",
        () => Promise.resolve("ok"),
        () => "",
      ),
    ).toBe("ok");
  });

  it("drops a read that ends after a newer one started", async () => {
    const l = new Loads<string>();
    const first = later<string>();
    const ended: string[] = [];
    l.get(
      "k",
      () => first.p,
      (v) => ended.push(v),
      () => "",
    );
    l.clear();
    const second = later<string>();
    l.get(
      "k",
      () => second.p,
      (v) => ended.push(v),
      () => "",
    );
    second.done("second");
    await l.wait(
      "k",
      () => second.p,
      () => "",
    );
    first.done("first");
    await first.p;
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toEqual(["second"]);
    expect(
      l.get(
        "k",
        () => first.p,
        none,
        () => "",
      ),
    ).toBe("second");
  });

  it("forgets everything on clear: the next read shows Reading… again", async () => {
    const l = new Loads<string>();
    await l.wait(
      "k",
      () => Promise.resolve("old"),
      () => "",
    );
    l.clear();
    expect(
      l.get(
        "k",
        () => new Promise<string>(none),
        none,
        () => "",
      ),
    ).toBeUndefined();
  });
});
