import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCorrections, Question } from "@maycombhq/core";

/**
 * The invented Forge estate of ai-decide.test.ts, for the tests of ADR 0208: forge-billing has
 * loose calls to the partner gateway (`/charges/{id}/capture`, `/charges/{id}/refunds`,
 * `/charges`, and `captureChargePath`, a field's name), its client's source in the workspace.
 * Nothing leaves the machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
export const GW = "forge-partner-gateway";
export const BFF = "forge-shop-bff";
export const CAPTURE = "entry.post.partners-northwind-charges-chargeid-capture";
export const REFUNDS = "entry.post.partners-northwind-charges-chargeid-refunds";
export const CHARGES = "entry.post.partners-northwind-charges";
export const FILE = "src/main/java/forge/billing/PartnerClient.java";
export const LINES = "facts/forge-billing.corrections.jsonl";
export const AT = new Date("2026-11-08T10:15:00.000Z");

export const callFact = (id: string, path: string, line: number) => ({
  kind: "call",
  id,
  repo: "forge-billing",
  commit: "aaa1111",
  callType: "rest",
  method: "POST",
  path,
  cite: { file: FILE, line, value: path },
  verified: "line",
  by: "assistant",
  conf: "declared",
});

const SOURCE = Array.from({ length: 45 }, (_, i) => {
  const n = i + 1;
  if (n === 31) return "    post(captureChargePath, body); // PartnerRoutes.CAPTURE";
  if (n === 40) return '    post("/charges/" + id + "/capture", body);';
  if (n === 41) return '    post("/charges/" + id + "/refunds", body);';
  if (n === 42) return '    post("/charges", body);';
  return n === 1 ? "package forge.billing;" : `    // line ${n}`;
}).join("\n");

/** A pairing line: the AI's (with `run`) or a person's (`by`), of a call on FILE. */
export function pairLine(
  fact: string,
  line: number,
  value: string,
  to: { repo: string; entry: string; path: string },
  o: { run?: string; by?: string; at?: string } = {},
) {
  return JSON.stringify({
    schemaVersion: 2,
    fact,
    target: { kind: "call", file: FILE, line, value },
    action: "link",
    link: { repo: to.repo, entry: to.entry, method: "POST", path: to.path },
    by: o.run ? "atticus" : (o.by ?? "pat"),
    at: o.at ?? "2026-11-08T09:00:00.000Z",
    ...(o.run
      ? { ai: { runtime: "copilot-acp", run: o.run }, batch: "b-20261108-090000-aaaaaa" }
      : {}),
  });
}

export const toBff = { repo: BFF, entry: "entry.post.checkout", path: "/checkout" };
export const toCapture = {
  repo: GW,
  entry: CAPTURE,
  path: "/partners/northwind/charges/{chargeId}/capture",
};

/** A fresh copy of the estate; `facts` adds call facts to forge-billing's. */
export async function correctionsEstate(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(join(root, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await writeFile(
    join(root, "org-pack/runtime.yaml"),
    [
      "schemaVersion: 4",
      "assistants: { allowed: [copilot], default: copilot }",
      "modes: { allowed: [hand-off, copilot-acp], default: copilot-acp }",
      "decide: { links: auto, questions: auto }",
      "",
    ].join("\n"),
  );
  await cp(join(FX, "org-pack/profiles/forge"), join(root, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(root, d), { recursive: true });
  await appendFile(
    join(root, "facts/forge-billing.jsonl"),
    [
      callFact("call.post.capture-charge", "captureChargePath", 31),
      callFact("call.post.charges-capture", "/charges/{id}/capture", 40),
      callFact("call.post.charges-refunds", "/charges/{id}/refunds", 41),
      callFact("call.post.charges", "/charges", 42),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  await mkdir(join(root, "workspace/forge-billing", dirname(FILE)), { recursive: true });
  await writeFile(join(root, "workspace/forge-billing", FILE), SOURCE);
  return root;
}

export const correctionsOn = async (root: string) =>
  parseCorrections(await readFile(join(root, LINES), "utf8").catch(() => "")).corrections;

/** An open targets question about forge-billing's call on `line`. */
export const targetsQuestion = (id: string, line: number) =>
  Question.parse({
    schemaVersion: 5,
    id,
    askedBy: {
      step: "facts-targets",
      command: "atticus verify forge-billing --write",
      at: "2026-11-08T08:00:00Z",
    },
    repo: "forge-billing",
    question: `Where does forge-billing's call on line ${line} go?`,
    options: [
      { label: BFF, means: `${BFF}: a path like it`, changes: "joins it" },
      { label: GW, means: `${GW}: the same path under /partners/northwind`, changes: "joins it" },
      { label: "Another repo…", means: "A repo not listed", changes: "Nothing until you name one" },
      { label: "None of these", means: "Nothing answers it", changes: "The call stays loose" },
    ],
    evidence: [`${FILE}:${line}`],
    scope: { level: "repo", id: "forge-billing" },
    state: "open",
    rerun: "atticus verify forge-billing --write",
  });
