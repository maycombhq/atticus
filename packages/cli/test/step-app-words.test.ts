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

  // Review of the fix: the reviewer's sentences, each said in full.
  it("drops a bracketed command alternative as one unit, and the bracket it empties", () => {
    expect(
      say(
        "Answer 2 questions on Questions (or atticus questions answer <id>), then run the design stage again.",
      ),
    ).toBe("Answer 2 questions on Questions, then run the design stage again.");
    expect(
      say(
        "forge-ledger: no facts were read at 1a2b3c4: read it again (Map › Trust › Freshness: Read again, or atticus map forge-ledger), then atticus verify forge-ledger --write, so the catalog says what shipped.",
      ),
    ).toBe(
      "forge-ledger: no facts were read at 1a2b3c4: read it again (Map › Trust › Freshness: Read again), so the catalog says what shipped.",
    );
    expect(
      say(
        "so the code never reached main: raise the release PRs (Release › Raise the release PRs, or atticus change release-prs add-transfer-limit --approve), and merge them on the Git host.",
      ),
    ).toBe(
      "so the code never reached main: raise the release PRs (Release › Raise the release PRs), and merge them on the Git host.",
    );
    expect(
      say(
        "opening it is a step waiting on you (atticus todo, or Home › Manual steps in the app). Open it.",
      ),
    ).toBe("opening it is a step waiting on you (Home › Manual steps in the app). Open it.");
    expect(say("Answer it (or /atticus-answer), then go on.")).toBe("Answer it, then go on.");
  });

  it("keeps the verb of a command that is its sentence's subject, and of one a verb takes", () => {
    expect(say("atticus map --all --stale tops up every such repo.")).toBe(
      "This step tops up every such repo.",
    );
    expect(
      say(
        "Critic round 2 on the design gate didn't finish: run atticus critic add-transfer-limit --gate design again.",
      ),
    ).toBe("Critic round 2 on the design gate didn't finish: run the critic again from the app.");
    expect(say("Run atticus verify forge-ledger first.")).toBe(
      "Run the facts check first from the app.",
    );
    expect(say("Use atticus questions answer q-1a2b to answer it.")).toBe(
      "Use Questions from the app to answer it.",
    );
    expect(say("your assistant reads it, and atticus verify forge-ledger checks them.")).toBe(
      "your assistant reads it, and Atticus checks them.",
    );
  });

  // Beta.27 final fixes: a verb's command is named for what it does, never "it" with no "it".
  it("names the action a verb took, where the sentence has no it", () => {
    expect(
      say(
        "The design gate is not decided: 2 AI lenses are with your assistant. Run atticus handoff done <run> for each, then look at the findings again.",
      ),
    ).toBe(
      "The design gate is not decided: 2 AI lenses are with your assistant. Mark the hand-off done from the app for each, then look at the findings again.",
    );
    expect(
      say(
        "The architecture stage is with your assistant (run r-9): finish the hand-off, then run atticus change architecture add-transfer-limit again.",
      ),
    ).toBe(
      "The architecture stage is with your assistant (run r-9): finish the hand-off, then run the architecture stage again from the app.",
    );
    expect(
      say(
        "The security lens on the design gate (round 1) didn't review (timed out): run atticus critic add-transfer-limit --gate design again.",
      ),
    ).toBe(
      "The security lens on the design gate (round 1) didn't review (timed out): run the critic again from the app.",
    );
    expect(
      say(
        "The design gate is mandatory on this platform and the critic hasn't reviewed it yet: run atticus critic add-transfer-limit --gate design.",
      ),
    ).toBe(
      "The design gate is mandatory on this platform and the critic hasn't reviewed it yet: run the critic from the app.",
    );
    expect(say("Run atticus workspace sync first.")).toBe("Sync the workspace first from the app.");
    expect(say("then run atticus plan stories add-transfer-limit again.")).toBe(
      "then run the stories stage again from the app.",
    );
  });

  /**
   * Every step and gate sentence with a command in it (next-commands.ts, changes' assess.ts and
   * lifecycle.ts gate messages, ci's archive.ts), as Forge's add-transfer-limit says them.
   */
  const real = [
    // next-commands.ts: a gate its hand-off would refuse, the archive gate, the change's steps
    "add-transfer-limit's design stage is done, but the design gate is blocked, so its hand-off would be refused: Knowledge gap f-1. Ask its owner (atticus finding add-transfer-limit f-1 ask --asked-of <who>), or fill it in (atticus finding add-transfer-limit f-1 edit-and-apply).",
    "add-transfer-limit's design stage is done, but the design gate is blocked, so its hand-off would be refused: A blocking finding. Fix it (atticus finding add-transfer-limit f-1 edit-and-apply), or record why it doesn't apply (not-relevant --reason, or waive); 2 more after it.",
    "add-transfer-limit is released, and the archive gate needs what shipped read: forge-ledger: no facts were read at 1a2b3c4, the commit its release merged into main: read it again (Map › Trust › Freshness: Read again, or atticus map forge-ledger), then atticus verify forge-ledger --write, so the catalog says what shipped.",
    "add-transfer-limit is released, and the archive gate needs what shipped read: forge-ledger: its facts were read at 9f8e7d6, not at 1a2b3c4, the commit its release merged into main: read it again (Map › Trust › Freshness: Read again, or atticus map forge-ledger), then atticus verify forge-ledger --write, so the catalog says what shipped.",
    "add-transfer-limit is released, and the archive gate needs the catalog written from what shipped: forge-ledger: its facts are of the merged commit 1a2b3c4, but 2 catalog records still cite another commit: write them into the catalog (atticus verify forge-ledger --write, or Apply on the Map).",
    "add-transfer-limit is released, but the archive gate doesn't pass yet: forge-ledger: no release PR from change/add-transfer-limit into main was raised, so the code never reached main: raise the release PRs (Release › Raise the release PRs, or atticus change release-prs add-transfer-limit --approve), and merge them on the Git host.",
    "add-transfer-limit is released, but the archive gate doesn't pass yet: forge-ledger: the change branch moved past release PR #12 after it merged, so the newer work isn't in main: raise the release PRs again (atticus change release-prs add-transfer-limit --approve) and merge the new one.",
    "add-transfer-limit is released, and the archive gate needs forge-ledger's clone at what merged: forge-ledger: the clone here is still at 1a2b3c4, where the change started, though release PR #12 merged: sync the workspace (atticus workspace sync), then read the repo again.",
    "2 needs of add-transfer-limit are open (the longest: 4 days). Raise each, then record it with atticus needs done add-transfer-limit <item>.",
    "add-transfer-limit adds pay-limit as new, and forge-ledger's starting spec (openspec/specs/forge-ledger/spec.md), not accepted yet, adds it too: archiving both would fail on a requirement added twice. A person reads and accepts the seed. Then run the change's stories stage again (atticus plan stories add-transfer-limit) so it modifies the seeded requirement (ADR 0156).",
    "add-transfer-limit's design hand-off PR isn't open yet: your Git host is manual, so opening it is a step waiting on you (atticus todo, or Home › Manual steps in the app). Open it on the Git host as its step says, record its link, then sync; merging it approves the design gate.",
    "2 questions of add-transfer-limit are waiting for a person: q-1a2b, q-3c4d. Answer 2 questions on Questions (or atticus questions answer <id>), then run the design stage again.",
    "Task 1.2 of add-transfer-limit in forge-ledger is the first one not done. /atticus-task gives your assistant its context (atticus task context add-transfer-limit 1.2): the story, the criteria, the step with today's code and the files to change (ADR 0113).",
    // next-commands.ts: a repo's steps
    "forge-ledger is read: atticus verify forge-ledger --write checks its facts against the code, then puts them in the catalog and renders its map.",
    "forge-ledger isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify forge-ledger checks them. No facts are filed under forge-ledger, but forge-ledgr has some (state/facts/forge-ledgr.jsonl) and its id is near this one: if they are one repo, keep one id with atticus repo rename forge-ledger forge-ledgr (or rename the facts to forge-ledger). Estimated about 40 thousand tokens in 2 sessions (atticus map forge-ledger --estimate; an estimate, not a meter).",
    "forge-ledger's clone moved past its facts' commit (facts 1a2b3c4d5e6f, clone 9f8e7d6c5b4a): atticus estate fresh says how many facts to read again; your assistant reads only the files that changed.",
    "forge-ledger was read before reading rules added since (forge-rule-1): your assistant reads only the files they apply to, for what they ask, and atticus verify forge-ledger records the rules. atticus map --all --stale tops up every such repo.",
    "2 open needs of changes come from knowledge items no person has verified: check each against its page (atticus knowledge verify, correct or reject).",
    // changes: assess.ts
    "The design hand-off's PR isn't open yet: your Git host is manual, so opening it is a step waiting on you (atticus todo, or Home › Manual steps in the app). Open it on the Git host as its step says, record its link, then sync; merging it approves the gate.",
    "add-transfer-limit is a draft; create it with atticus change new.",
    "Create the change with atticus change new.",
    // changes: lifecycle.ts, the reasons and gate messages a step carries
    "The stories stage waits for a person to answer its questions: answer them on Questions (or atticus questions), then run the stage again (atticus plan stories add-transfer-limit).",
    "The architecture stage is with your assistant (run r-9): finish the hand-off, then run atticus change architecture add-transfer-limit again.",
    "Critic round 2 on the design gate didn't finish: run atticus critic add-transfer-limit --gate design again.",
    "The security lens on the design gate (round 1) is waiting for its hand-off answer (Done on run r-7 in Model runs, or atticus handoff done r-7).",
    "The security lens on the design gate (round 1) didn't review (timed out): run atticus critic add-transfer-limit --gate design again.",
    "The design gate is mandatory on this platform and the critic hasn't reviewed it yet: run atticus critic add-transfer-limit --gate design.",
    // ci: archive.ts notes
    "No clone of forge-ledger here to say which commit merged, so its facts weren't compared: sync the workspace (atticus workspace sync), or pass its pipeline's drift report.",
    // critic-commands.ts: a capitalised lead-in
    "The design gate is not decided: 2 AI lenses are with your assistant. Run atticus handoff done <run> for each, then look at the findings again.",
  ];

  it.each(real)("leaves no command and no garble: %s", (t) => {
    const s = say(t);
    expect(s).not.toMatch(/\batticus [a-z]|\/atticus-/);
    expect(s).not.toMatch(/\(\s*\)|\(or\s*\)|\(\s*,/);
    // No dangling ", or" before a bracket's end, a full stop or the end.
    expect(s).not.toMatch(/,\s*or\s*(?:[).;,]|$)/);
    // No sentence or clause ending in a word a removal left (a preposition, a joiner) or a colon:
    // one there is the sentence's own ("the files they apply to, for …").
    const ends =
      /\b(?:with|by|using|running|run|type|via|from|to|of|on|then|or|and|use)\s*(?:[.;:,)]|$)/gi;
    for (const m of s.matchAll(ends)) expect(t).toContain(m[0]);
    expect(s).not.toMatch(/:\s*(?:[.;,)]|$)/);
    expect(s).not.toMatch(/ {2}|,,|\s[.,;:]/);
  });
});
