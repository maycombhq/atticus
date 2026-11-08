import { describe, expect, it } from "vitest";
import { atticusArgvOf, personOnlyWhy } from "../src/index.js";

/**
 * Review round 32: what records a person's decision is refused inside a Copilot session Atticus
 * started, both by the session's command check and by the CLI itself (one list).
 */
const PERSON = [
  "questions answer q1 --option 1",
  "questions sheet --apply facts/sheet.yaml",
  "questions sheet --apply=facts/sheet.yaml --by dev",
  "verify audit forge-ledger --right f1,f2",
  "verify audit forge-ledger --answers a.yaml",
  "verify audit forge-ledger --wrong=f1",
  "knowledge verify k1",
  "knowledge correct k1 --set owner=x",
  "knowledge reject k1 --note no",
  "spec accept forge-ledger",
  "orgpack accept",
  "standards accept",
  "onboard accept spring",
  "absorb accept p1",
  "wikis accept w1",
  "baseline",
  "triage decide t1 2",
  "finding c1 F-1 waive",
  "feature name f1 Limits",
  "feature link f1 ado:1",
  "todo done s1",
  "needs done c1 n1",
  "needs skip c1 n1 --note x",
  "change needs done c1 n1",
  "next --by someone",
  "change handoff c1 --approve",
  "plan submit c1 --approve",
  "ado sync c1 --approve",
  "task run c1 t1 --level pr --approve",
  "handoff done r1 --approve",
  "scan verify forge --accept",
  "repo describe forge-ledger --accept",
  "repo describe forge-ledger --description Ledger",
  "repo describe forge-ledger --reject",
  "repo add forge-x --url u",
  "knowledge keep k1 --find s",
  "alias Ledger forge-ledger",
  "glossary define Limit --text x",
  "glossary link Limit forge-ledger",
  "glossary alias Limit Cap",
  "digest --send --channel x",
  "digest --as dana",
  "rules activate k1 --type service",
  "rules off builtin:spring --reason x",
  "rules add k1 --type service",
  "initiative commit c1 done",
  "outcome record c1 m1 --value 3",
];
const SESSION = [
  "verify forge-ledger",
  "verify audit forge-ledger --report",
  "verify audit --report",
  "questions sheet --out q.yaml",
  "questions show q1",
  "knowledge list",
  "feature list",
  "todo",
  "needs c1",
  "spec check forge-ledger",
  "repo describe forge-ledger --drafted Ledger --cites a:1",
  "glossary list",
  "map forge-ledger --estimate",
  "rules list",
  "rules add k1 --type service --draft",
  "digest",
];

describe("what only a person does", () => {
  it.each(PERSON)("refuses %s", (line) => {
    expect(personOnlyWhy(line.split(" "))).toBeTruthy();
    expect(atticusArgvOf(`atticus ${line}`).refused).toMatch(/^Refused: /);
  });
  it.each(SESSION)("lets a session run %s", (line) => {
    expect(personOnlyWhy(line.split(" "))).toBeUndefined();
    expect(atticusArgvOf(`atticus ${line}`).refused).toBeUndefined();
  });
});

describe("a person's records under facts/", () => {
  it("are never a session's to write", async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { factsOnly, acpPathsOf } = await import("../src/copilot-acp.js");
    const root = await mkdtemp(join(tmpdir(), "po-"));
    await mkdir(join(root, "facts"));
    const paths = acpPathsOf(factsOnly(root, join(root, "facts")));
    expect(paths.writable(join(root, "facts", "forge-ledger.jsonl"))).toBeUndefined();
    expect(paths.writable(join(root, "facts", "forge-ledger.audit.yaml"))).toMatch(
      /person's record/,
    );
    expect(paths.writable(join(root, "facts", "forge-ledger.corrections.jsonl"))).toMatch(
      /person's record/,
    );
  });
});

it("a session's command comes first, so a flag can't hide it", () => {
  expect(atticusArgvOf("atticus --mode x questions answer q1").refused).toMatch(/command first/);
  expect(atticusArgvOf("atticus --version").refused).toBeUndefined();
});
