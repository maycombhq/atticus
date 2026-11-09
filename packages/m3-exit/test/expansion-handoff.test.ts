import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atticus,
  CHANGE,
  changeDir,
  FORGE_CHANGE,
  forgeEstate,
  json,
  removeTop,
  T,
  writeExpectedCatalog,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit with retrieval's real defaults (ADR 0116 addendum): the expansion of a step's input is
 * on. In hand-off mode a round is one paste (ADR 0188): the expansion is read without a model
 * (the estate's names the input uses), and `change feature` on the fixture change hands off its
 * own prompt first, with the expansion recorded in the run; run again, it waits on that prompt
 * and asks nothing new.
 */

let e: Estate;
const env = { ...process.env };
beforeAll(async () => {
  e = await forgeEstate();
  await writeExpectedCatalog(e.root);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), changeDir(e.root), {
    recursive: true,
  });
}, T);
afterAll(async () => {
  process.env = env;
  await removeTop(e);
});

interface Handoff {
  state: string;
  runId: string;
  resultFile: string;
  promptFile: string;
  doneArgs: string[];
  resumeArgs: string[];
  stillWaiting?: boolean;
}

const runJson = async (run: string) =>
  JSON.parse(await readFile(join(e.root, ".runs", CHANGE, run, "run.json"), "utf8")) as {
    request: {
      agent: { id: string };
      retrieval?: {
        expansion?: { run?: string; cached: boolean; names: { name: string; id?: string }[] };
      };
    };
  };

describe("M3 exit: the expansion in hand-off mode, on by default (ADR 0188: one paste per round)", () => {
  it(
    "change feature hands off its own prompt first, the estate's names read without a model; a rerun asks nothing new",
    async () => {
      const step = async (...args: string[]) =>
        json<Handoff>(
          await atticus(e.root, "change", "feature", CHANGE, "--handoff", "--json", ...args),
        );
      const draft = await step();
      expect(draft.state, JSON.stringify(draft)).toBe("handoff");
      const req = (await runJson(draft.runId)).request;
      // The round's one prompt is the stage's own: no expander prompt before it.
      expect(req.agent.id).toBe("feature-placer");
      expect(req.retrieval?.expansion).toMatchObject({ cached: false });
      expect(req.retrieval?.expansion?.run).toBeUndefined();
      expect(req.retrieval?.expansion?.names.map((n) => n.id)).toContain("northwind-pay");
      const prompt = await readFile(join(e.root, draft.promptFile), "utf8");
      expect(prompt).toContain("Northwind Pay's velocity check");
      // The prompt's last line asks for the file, and runs nothing.
      expect(prompt).not.toContain("atticus handoff done");
      expect(prompt.trimEnd()).toMatch(/There is nothing to run\.$/);

      // Run again without --resume: the same prompt waits; nothing new is asked.
      const again = await step();
      expect(again).toMatchObject({ runId: draft.runId, stillWaiting: true });
    },
    T,
  );
});
