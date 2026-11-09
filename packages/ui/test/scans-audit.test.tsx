import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { jobNote, scanAdded } from "../src/screens/know/Know.js";

/**
 * App-only audit (Set up › Scans): the scan is a cross-check with the built-in readers, said as
 * such, and says what it added; a job that ended no longer says it started (DONE beside "Scan
 * started." said two things at once).
 */
const T = COPY.know;

describe("Set up › Scans (app-only audit)", () => {
  it("names the scan as the built-in readers' cross-check", () => {
    expect(T.scanNow).toBe("Check with the built-in readers");
    expect(T.scanCrossCheck).toMatch(/^A cross-check, not how the map is made/);
  });

  it("says what the readers added, changed and removed, and the questions open", () => {
    expect(
      scanAdded({ state: "done", result: { added: 12, changed: 3, removed: 0, questions: 1 } }),
    ).toBe(
      "The built-in readers added 12 records, changed 3 and removed 0. 1 host question is open.",
    );
    expect(scanAdded({ state: "running" })).toBeUndefined();
    expect(scanAdded({ state: "done", result: { lines: [] } })).toBeUndefined();
  });

  it("Bring in what merged offers the upstream the server found, and nothing else", async () => {
    const { upstreamOffered } = await import("../src/app/propose.js");
    expect(
      upstreamOffered(
        "This branch main follows no remote branch, and origin/main is there: Set the upstream to origin/main, then Bring in what merged again.",
      ),
    ).toBe("origin/main");
    expect(
      upstreamOffered("This branch follows no remote branch, so there is nothing to bring in."),
    ).toBeUndefined();
    expect(COPY.propose.setUpstream("origin/main")).toBe("Set the upstream to origin/main");
  });

  it("a rejected fact offers Drop this fact, and the catalog line says why nothing is written", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DropFact } = await import("../src/screens/map/drop-fact.js");
    const html = renderToStaticMarkup(<DropFact repo="forge-ledger" fact="rt-no-file" />);
    expect(html).toContain(`aria-label="${COPY.trust.dropFactLabel("rt-no-file")}"`);
    expect(html).toContain(`>${COPY.trust.dropFact}</button>`);
    expect(COPY.trust.rejectedHolds(1)).toBe(
      "Nothing is written to the catalog while a fact is rejected: fix it with your assistant, or drop it below.",
    );
  });

  it("drops the started note once the job has ended, and keeps a refusal", () => {
    const started = { ok: true, text: "Scan started." };
    const refused = { ok: false, text: "A scan is already running." };
    expect(jobNote({ state: "running" }, started)).toBe(started);
    expect(jobNote({ state: "done" }, started)).toBeUndefined();
    expect(jobNote({ state: "failed" }, started)).toBeUndefined();
    expect(jobNote({ state: "done" }, refused)).toBe(refused);
    expect(jobNote(undefined, started)).toBe(started);
  });
});
