import { describe, expect, it } from "vitest";
import { Api, API_VERSION, openApiDocument } from "../src/index.js";

/**
 * API 2.42.0 (ADR 0149): after a correction, the commands and a preview of verify --write (C4);
 * a sample audit drawn and answered in the app (P3's follow-up); the outside systems (O4).
 * Additive only.
 */

const doc = openApiDocument() as {
  info: { version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, unknown> };
};

describe("corrections without git, the audit in the app and the outside systems (C4 2.42.0)", () => {
  it("is 2.42.0 or later and documents the four calls and their answers", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major! > 2 || (major === 2 && minor! >= 39)).toBe(true);
    expect(doc.paths["/api/facts/{repo}/preview"]!.get!.operationId).toBe("previewVerifyWrite");
    expect(doc.paths["/api/facts/{repo}/audit"]!.get!.operationId).toBe("drawAudit");
    expect(doc.paths["/api/facts/{repo}/audit"]!.post!.operationId).toBe("answerAudit");
    expect(doc.paths["/api/outside"]!.get!.operationId).toBe("getOutsideSystems");
    for (const s of ["VerifyPreviewView", "AuditSampleView", "AuditAnswerResult", "OutsideView"])
      expect(doc.components.schemas).toHaveProperty(s);
  });

  it("keeps a correction's result as it was, with the line written optional", () => {
    const r = {
      correction: {
        schemaVersion: 1,
        fact: "e-1",
        target: { kind: "entry", file: "a.java", line: 1, value: "/x" },
        action: "wrong",
        reason: "gone",
        by: "pat",
        at: "2026-11-01T10:00:00Z",
      },
      file: "facts/forge-ledger.corrections.jsonl",
      commit: "git add x",
      verify: "atticus verify forge-ledger",
    };
    expect(Api.FactCorrectionResult.safeParse(r).success).toBe(true);
    expect(Api.FactCorrectionResult.safeParse({ ...r, line: "{}" }).success).toBe(true);
  });

  it("takes an audit's answers as right, wrong or unsure only, at least one", () => {
    const ok = { seed: "s1", size: 3, answers: [{ id: "fact:x", answer: "wrong", note: "PUT" }] };
    expect(Api.AuditAnswerRequest.safeParse(ok).success).toBe(true);
    expect(Api.AuditAnswerRequest.safeParse({ ...ok, answers: [] }).success).toBe(false);
    expect(
      Api.AuditAnswerRequest.safeParse({ ...ok, answers: [{ id: "x", answer: "maybe" }] }).success,
    ).toBe(false);
    expect(Api.AuditAnswerRequest.safeParse({ ...ok, size: 0 }).success).toBe(false);
  });

  it("gives the steps in a fixed vocabulary, a pull request with no command allowed", () => {
    const v = Api.VerifyPreviewView.parse({
      repo: "forge-ledger",
      wrote: "facts/forge-ledger.corrections.jsonl",
      branch: "correct/forge-ledger",
      steps: [{ step: "verify", command: "atticus verify forge-ledger --write" }, { step: "pr" }],
      unavailable: "no-checkout",
    });
    expect(v.preview).toBeUndefined();
    expect(Api.NextStepView.safeParse({ step: "deploy", command: "x" }).success).toBe(false);
  });
});
