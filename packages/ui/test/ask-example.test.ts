import { describe, expect, it } from "vitest";
import { askExample } from "../src/app/App.js";
import { COPY } from "../src/copy.js";

/** The Ask box's example comes from the person's own catalog (a real metarepo, 2026-10-25). */
describe("the Ask box's example", () => {
  it("names a real table, else a real entry point, else nothing of anyone's estate", () => {
    const page = (...ids: string[]) => ({ rows: ids.map((id) => ({ id })) });
    expect(askExample(page("studio-db.note"), page("api.post-note"))).toBe(
      "Ask: what breaks if studio-db.note changes?",
    );
    expect(askExample(page(), page("api.post-note"))).toBe(
      "Ask: what breaks if api.post-note changes?",
    );
    expect(askExample(page(), page())).toBe(COPY.shell.askNeutral);
    expect(askExample(undefined, undefined)).toBe(COPY.shell.askNeutral);
    expect(COPY.shell.askNeutral).not.toMatch(/ledger|forge/i);
  });
});
