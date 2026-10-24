import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import type { InboxItem } from "../src/app/inbox.js";
import { BulkBar, bulkable, bulkCalls, WaitingList } from "../src/screens/CommandCenter.js";

/** Bulk actions on Waiting on you (WP7.10): several needs or manual steps, one reason for all. */

const T = COPY.commandCenter;
const need = (id: string): InboxItem => ({
  kind: "need",
  title: `Raise ${id}`,
  detail: "request",
  href: "#/changes?across=needs",
  id,
  change: "add-transfer-limit",
});
const step: InboxItem = {
  kind: "step",
  title: "Open the firewall",
  detail: "ledger",
  href: "#/todo",
  id: "s-1",
};
const finding: InboxItem = { kind: "finding", title: "A gap", detail: "", href: "#/x", id: "f-1" };

describe("bulk actions on Waiting on you (WP7.10)", () => {
  it("acts on needs and manual steps only", () => {
    expect([need("kafka"), step, finding].map(bulkable)).toEqual([true, true, false]);
  });

  it("makes one call per item, each with the same reason, and none without a reason", () => {
    expect(bulkCalls([need("kafka"), need("dns"), step], "need-done", "CTASK-42")).toEqual([
      {
        path: "/api/changes/add-transfer-limit/needs/kafka",
        body: { status: "done", note: "CTASK-42" },
      },
      {
        path: "/api/changes/add-transfer-limit/needs/dns",
        body: { status: "done", note: "CTASK-42" },
      },
    ]);
    expect(bulkCalls([step], "step-skip", "done by the platform team")).toEqual([
      { path: "/api/todo/s-1/done", body: { skip: true, note: "done by the platform team" } },
    ]);
    expect(bulkCalls([need("kafka")], "need-not-needed", "  ")).toEqual([]);
  });

  it("offers the actions that fit what is selected, and checkboxes only when bulk is on", () => {
    const bar = renderToStaticMarkup(
      <BulkBar selected={[need("kafka"), step]} onDo={() => {}} onClear={() => {}} />,
    );
    expect(bar).toContain(T.bulkNeedDone(1));
    expect(bar).toContain(T.bulkStepSkip(1));
    expect(bar).toContain(T.selected(2));
    const plain = renderToStaticMarkup(
      <WaitingList items={[need("kafka")]} changes={[]} text="" onText={() => {}} state="ready" />,
    );
    expect(plain).not.toContain('type="checkbox"');
    const bulk = renderToStaticMarkup(
      <WaitingList
        items={[need("kafka"), finding]}
        changes={[]}
        text=""
        onText={() => {}}
        state="ready"
        onBulk={async () => {}}
      />,
    );
    expect(bulk.match(/type="checkbox"/g)).toHaveLength(1);
  });
});
