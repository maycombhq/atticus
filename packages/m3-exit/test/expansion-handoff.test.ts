import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * M3 exit with retrieval's real defaults (ADR 0116 addendum): the model's expansion of a step's
 * input is on, and in hand-off mode (Copilot, one prompt per round) it is a round of its own.
 * `change feature` on the fixture change hands the expansion off first, with a prompt small
 * enough for the GPT-4o mini floor; answered, the step hands off its own prompt with the
 * expansion recorded in the run; run again, it waits on that prompt and asks nothing new.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
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
      retrieval?: { expansion?: { run?: string; cached: boolean; names: { name: string }[] } };
    };
  };

describe("M3 exit: the expansion in hand-off mode, on by default", () => {
  it(
    "change feature hands the expansion off first, then its own prompt with the expansion recorded; a rerun asks nothing new",
    async () => {
      const step = async (...args: string[]) =>
        json<Handoff>(
          await atticus(e.root, "change", "feature", CHANGE, "--handoff", "--json", ...args),
        );
      const rounds: string[] = [];

      const expansion = await step();
      expect(expansion.state, JSON.stringify(expansion)).toBe("handoff");
      expect(expansion.resultFile).toMatch(/\/expansion\.yaml$/);
      rounds.push((await runJson(expansion.runId)).request.agent.id);
      // Small for the GPT-4o mini floor: the expander's budget is 6,000 tokens.
      const prompt = await readFile(join(e.root, expansion.promptFile), "utf8");
      expect(prompt.length).toBeLessThan(6000 * 4);
      expect(prompt).toContain("Northwind Pay's velocity check");

      await writeFile(
        join(e.root, expansion.resultFile),
        await readFile(join(HERE, "fixtures/expansion/add-transfer-limit.yaml"), "utf8"),
      );
      expect((await atticus(e.root, ...expansion.doneArgs)).code).toBe(0);
      const draft = json<Handoff>(await atticus(e.root, ...expansion.resumeArgs));
      expect(draft.state, JSON.stringify(draft)).toBe("handoff");
      const req = (await runJson(draft.runId)).request;
      rounds.push(req.agent.id);
      expect(req.retrieval?.expansion).toMatchObject({ run: expansion.runId, cached: false });
      expect(req.retrieval?.expansion?.names.map((n) => n.name)).toEqual(["Northwind Pay"]);

      // Run again without --resume: the same prompt waits; the expansion isn't asked again.
      const again = await step();
      expect(again).toMatchObject({ runId: draft.runId, stillWaiting: true });
      expect(rounds).toEqual(["context-expander", "feature-placer"]);
    },
    T,
  );
});
