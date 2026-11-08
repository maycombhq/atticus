import { describe, expect, it } from "vitest";
import { appLines } from "../src/handoff-resume.js";

/**
 * Ninth UX walk (no terminal in the daily path): what a step says to type next is said in the
 * app's words where the app does it: Done again on a run whose answer failed, and Bring in what
 * merged on Home before a merged step is recorded. The command line keeps its commands (these
 * lines are only rewritten on the app's routes). Invented Forge data only (CLAUDE.md rule 3).
 */
describe("appLines in the app's words", () => {
  it("says press Done again, not atticus handoff done <run> again", () => {
    expect(
      appLines([
        "Fix what is listed in .runs/lock-card/run-20261108224350-0001/answer.md and run atticus handoff done run-20261108224350-0001 again: only the lenses still out are checked. Or answer a lens alone with its own run.",
        "The answer isn't there yet: write it, then run atticus handoff done run-20261108224350-0001 again.",
        "The build still fails; fix it in workspace/forge-card-vault and run atticus handoff done run-1 again.",
        "Run atticus handoff done run-1 again.",
        "answer.md needs fixing; run atticus handoff done run-1 again when it's fixed",
      ]),
    ).toEqual([
      "Fix what is listed in .runs/lock-card/run-20261108224350-0001/answer.md, then press Done again: only the lenses still out are checked. Or answer a lens alone with its own run.",
      "The answer isn't there yet: write it, then press Done again.",
      "The build still fails; fix it in workspace/forge-card-vault, then press Done again.",
      "Press Done again.",
      "answer.md needs fixing; press Done again when it's fixed",
    ]);
  });

  it("says Bring in what merged on Home, not pull main then atticus change learn", () => {
    expect(
      appLines([
        "The merge of PR #4 isn't in this clone yet: pull main, then run atticus change learn.",
      ]),
    ).toEqual([
      "The merge of PR #4 isn't in this clone yet: Bring in what merged on Home; the comparison with what Atticus drafted is kept the next time the drafts are measured.",
    ]);
  });
});
