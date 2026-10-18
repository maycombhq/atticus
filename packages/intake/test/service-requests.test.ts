import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readServiceRequestExport, readServiceRequestExports } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("service-request exports (golden)", () => {
  it("reads the Forge closed-requests export field for field", () => {
    const path = "inputs/tickets/closed-service-requests.json";
    const got = readServiceRequestExport(path, readFileSync(join(FORGE, path)));
    expect(got).toEqual([
      {
        id: "SR-0001",
        type: "network-firewall-rule",
        fields: { source: "ledger-api", destination: "api.northwind.example", port: 443 },
        opened: "2026-03-02",
        closed: "2026-03-16",
        approvalGroup: "network-team",
        source: { path, line: 2 },
      },
      {
        id: "SR-0002",
        type: "network-firewall-rule",
        fields: { source: "reports-job", destination: "ledger-db.forge.internal", port: 5432 },
        opened: "2026-04-06",
        closed: "2026-04-17",
        approvalGroup: "network-team",
        source: { path, line: 3 },
      },
      {
        id: "SR-0003",
        type: "gateway-route-review",
        fields: { proxy: "ledger-v1" },
        opened: "2026-02-10",
        closed: "2026-02-13",
        approvalGroup: "gateway-team",
        source: { path, line: 4 },
      },
    ]);
  });

  it("reads a table export and a CSV export, and leaves work-item exports alone", () => {
    const table = JSON.stringify({
      result: [
        {
          number: "RITM0010001",
          cat_item: { display_value: "Network firewall rule" },
          state: "Closed Complete",
          opened_at: "2026-05-04 09:12:00",
          closed_at: "2026-05-15 16:00:00",
          approval_group: { display_value: "Network Team" },
          variables: { source_app: "ledger-api", port: "443" },
        },
      ],
    });
    expect(readServiceRequestExport("inputs/x.json", bytes(table))).toEqual([
      {
        id: "RITM0010001",
        type: "Network firewall rule",
        state: "Closed Complete",
        fields: { source_app: "ledger-api", port: "443" },
        opened: "2026-05-04",
        closed: "2026-05-15",
        approvalGroup: "Network Team",
        source: { path: "inputs/x.json", line: 1 },
      },
    ]);
    const csv =
      "Number,Type,Opened,Closed,Approval group,Source app,Port\n" +
      'SR-0100,Network firewall rule,2026-06-01,2026-06-12,network team,"ledger-api",443\n';
    expect(readServiceRequestExport("inputs/x.csv", bytes(csv))).toEqual([
      {
        id: "SR-0100",
        type: "Network firewall rule",
        fields: { "Source app": "ledger-api", Port: "443" },
        opened: "2026-06-01",
        closed: "2026-06-12",
        approvalGroup: "network team",
        source: { path: "inputs/x.csv", line: 2 },
      },
    ]);
    const stories = readFileSync(join(FORGE, "inputs/tickets/ado-stories.json"));
    expect(readServiceRequestExport("inputs/tickets/ado-stories.json", stories)).toBeUndefined();
  });

  it("finds every export under inputs/", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-requests-"));
    await mkdir(join(root, "inputs/tickets"), { recursive: true });
    for (const f of ["closed-service-requests.json", "ado-stories.json"])
      await writeFile(
        join(root, "inputs/tickets", f),
        readFileSync(join(FORGE, "inputs/tickets", f)),
      );
    const r = await readServiceRequestExports({ root });
    expect(r.files).toEqual(["inputs/tickets/closed-service-requests.json"]);
    expect(r.requests.map((x) => x.id)).toEqual(["SR-0001", "SR-0002", "SR-0003"]);
    expect(r.problems).toEqual([]);
  });
});
