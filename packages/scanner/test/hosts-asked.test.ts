import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, Question, type CatalogRecord } from "@maycombhq/core";
import { fsRepo } from "@maycombhq/sdk";
import { hostQuestionDrafts, unknownHosts } from "../src/hosts-asked.js";

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/estate");
const OWNERS = join(ESTATE, "owners");
const load = (file: string): CatalogRecord[] =>
  (parse(readFileSync(file, "utf8")) as unknown[]).map((r) => {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
const records = () => [
  ...load(join(ESTATE, "catalog.yaml")),
  ...load(join(OWNERS, "catalog.yaml")),
];
const repos = [
  { id: "forge-web", component: "forge-web", hosts: [] as string[] },
  { id: "forge-customers", component: "forge-customers", hosts: [] as string[] },
];
// forge-customers' config (server.port) is in the owners part of the fixture.
const handle = (repo: string) =>
  repo === "forge-customers"
    ? fsRepo(repo, join(OWNERS, "repos", repo), "0".repeat(40))
    : fsRepo(repo, join(ESTATE, "repos", repo), "0".repeat(40));

describe("which repo answers on a host the calls name (ADR 0088)", () => {
  it("finds each host no repo lists, with its calls and the repo whose config sets its port", async () => {
    const asks = await unknownHosts({ records: records(), repos, handle });
    expect(asks).toEqual([
      {
        host: "localhost:9966",
        calls: [
          { repo: "forge-web", at: "src/app/owners/owner.service.ts:10" },
          { repo: "forge-web", at: "src/app/owners/owner.service.ts:14" },
        ],
        servers: ["forge-customers"],
        suggest: {
          repo: "forge-customers",
          at: "src/main/resources/application.properties:2",
          line: "server.port=9966",
        },
      },
    ]);
  });

  it("asks one question per host, the suggested repo first and none of these last", async () => {
    const asks = await unknownHosts({ records: records(), repos, handle });
    const want = Question.parse(
      parse(readFileSync(join(OWNERS, "expected", "question.yaml"), "utf8")),
    );
    expect(hostQuestionDrafts(asks)).toEqual([
      {
        repo: "forge-web",
        draft: {
          question: want.question,
          options: want.options,
          evidence: want.evidence,
          scope: "repo",
        },
      },
    ]);
  });

  it("leaves out hosts a repo lists, with or without the port", async () => {
    for (const hosts of [["localhost"], ["localhost:9966"], ["local*"]]) {
      const listed = repos.map((r) => (r.id === "forge-customers" ? { ...r, hosts } : r));
      expect(await unknownHosts({ records: records(), repos: listed, handle }), hosts[0]).toEqual(
        [],
      );
    }
    // Another port of localhost is still a question.
    const other = repos.map((r) =>
      r.id === "forge-customers" ? { ...r, hosts: ["localhost:8080"] } : r,
    );
    expect(
      (await unknownHosts({ records: records(), repos: other, handle })).map((a) => a.host),
    ).toEqual(["localhost:9966"]);
  });

  it("suggests no repo when none, or more than one, sets the port, and lists the servers in order", async () => {
    const api2 = {
      kind: "Endpoint",
      schemaVersion: 2,
      id: "forge-billing.get-bills",
      status: "current",
      confidence: "verified",
      evidence: [{ source: "code", repo: "forge-billing", path: "src/Bills.java", line: 3 }],
      component: "forge-billing",
      endpointType: "rest",
      method: "GET",
      pathOrTopic: "/bills",
      normalizedPath: "/bills",
    };
    const p = parseRecord(api2);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    const asks = await unknownHosts({
      records: [...records(), p.record],
      repos: [...repos, { id: "forge-billing", hosts: [] }],
      // No clones: nothing to read the port from.
      handle: () => undefined,
    });
    expect(asks[0]).toMatchObject({ servers: ["forge-billing", "forge-customers"] });
    expect(asks[0]!.suggest).toBeUndefined();
    expect(hostQuestionDrafts(asks)[0]!.draft.options.map((o) => o.label)).toEqual([
      "forge-billing",
      "forge-customers",
      "None of these",
    ]);
  });
});
