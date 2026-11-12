import { describe, expect, it } from "vitest";
import { commandShapes, stepInAppWords } from "../src/step-app-words.js";

/**
 * Beta.27 review, final round: a step's reason in the app's words, on the server, from the help
 * catalog's commands: a command Atticus has goes with its arguments; prose that only looks like
 * one stays. The reviewer's four sentences, then capitalised "Atticus" and backticked code.
 * Invented Forge names.
 */
describe("a step's reason in the app's words", async () => {
  const cmds = await commandShapes();
  const say = (t: string) => stepInAppWords(t, cmds);

  it("says the task step without its slash command's clause, keeping the sentence", () => {
    expect(
      say(
        "Task 1.2 of add-transfer-limit in forge-ledger is the first one not done. /atticus-task gives your assistant its context (atticus task context add-transfer-limit 1.2): the story, the criteria, the step with today's code and the files to change (ADR 0113).",
      ),
    ).toBe(
      "Task 1.2 of add-transfer-limit in forge-ledger is the first one not done. This step gives your assistant its context: the story, the criteria, the step with today's code and the files to change.",
    );
  });

  it("takes a known command out with its id and flag value, stopping at the comma", () => {
    expect(say("Fill the gap with atticus questions owner q.x --text 'y', then rerun.")).toBe(
      "Fill the gap, then rerun.",
    );
    expect(
      say(
        "2 needs of add-transfer-limit are open. Raise each, then record it with atticus needs done add-transfer-limit <item>.",
      ),
    ).toBe("2 needs of add-transfer-limit are open. Raise each, then record it.");
  });

  it("leaves prose that isn't a command Atticus has", () => {
    expect(say("approval comes from atticus approve design or the Gate, then build")).toBe(
      "approval comes from atticus approve design or the Gate, then build",
    );
    expect(say("Ask the owner what atticus knows about it.")).toBe(
      "Ask the owner what atticus knows about it.",
    );
  });

  it("keeps capitalised Atticus and backticked code that isn't a command", () => {
    expect(
      say(
        "Your assistant drafts them, and Atticus checks each entry against the code in `org-pack/runtime.yaml` and `atticus knows`.",
      ),
    ).toBe(
      "Your assistant drafts them, and Atticus checks each entry against the code in `org-pack/runtime.yaml` and `atticus knows`.",
    );
    // A backticked command Atticus has goes, as a bare one does.
    expect(say("Read it again with `atticus scan --full`, then raise it.")).toBe(
      "Read it again, then raise it.",
    );
  });

  it("says a command that leads its clause as the step", () => {
    expect(
      say(
        "forge-ledger is read: atticus verify forge-ledger --write checks its facts against the code, then puts them in the catalog and renders its map.",
      ),
    ).toBe(
      "forge-ledger is read: this step checks its facts against the code, then puts them in the catalog and renders its map.",
    );
  });
});
