import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  CorrectForm,
  ItemDetail,
  ItemList,
  itemFor,
  reviewKey,
  reviewQueue,
  stepQueue,
} from "../src/screens/knowledge/Items.js";
import { needTick, markBody, markedWords, NeedsView } from "../src/screens/knowledge/Needs.js";
import { DraftPage, initialPick } from "../src/screens/knowledge/OrgPackDraft.js";
import { PartiesPage, relations } from "../src/screens/knowledge/Parties.js";
import { FindDetail, FindList, SearchResult } from "../src/screens/knowledge/Search.js";
import {
  correctionBody,
  groupItems,
  matchItem,
  pageText,
  reviewText,
  tagsOf,
} from "../src/screens/knowledge/shared.js";
import {
  AddSource,
  addBody,
  EMPTY_ADD,
  ScanReport,
  SourceList,
} from "../src/screens/knowledge/Sources.js";

/** ADR 0102: the knowledge screens, in every state, over invented Forge data. */

const K = COPY.knowledge;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const quote = (page: string, text: string) => ({
  source: "platform",
  page,
  section: "The request",
  text,
  snapshot: "2026-10-20",
  line: 7,
});

const kafka: Api.KnowledgeItemViewT = {
  id: "kafka-topic-request",
  kind: "request",
  recordKind: "ProcessDefinition",
  title: "Kafka topic",
  record: {
    kind: "ProcessDefinition",
    id: "kafka-topic-request",
    title: "Kafka topic",
    appliesWhen: "A service publishes to a topic that does not exist yet.",
    leadTime: "5 working days",
    handledBy: "Messaging team",
    steps: ["Open the platform catalogue", "Pick Kafka topic"],
    urls: [{ label: "Form", url: "https://servicedesk.example.com/kafka" }],
    quote: quote("how-to/kafka.md", "Handled by: Messaging team."),
  },
  fields: {
    title: "text",
    appliesWhen: "text",
    leadTime: "text",
    handledBy: "text",
    steps: "list",
    urls: "links",
  },
  conflict: false,
};
const logging: Api.KnowledgeItemViewT = {
  id: "json-logging",
  kind: "standard",
  recordKind: "Pattern",
  title: "Log as JSON",
  record: { kind: "Pattern", id: "json-logging", name: "Log as JSON", rules: ["Log as JSON"] },
  review: { state: "verified", verdict: "verified", by: "priya.nair", at: "2026-10-22T10:00:00Z" },
  fields: { name: "text", rules: "list", urls: "links" },
  conflict: true,
};
const messaging: Api.KnowledgeItemViewT = {
  id: "messaging-team",
  kind: "team",
  recordKind: "Party",
  title: "Messaging team",
  record: {
    name: "Messaging team",
    aliases: ["MSG"],
    responsibilities: ["Runs the event bus"],
    owns: ["Event bus"],
  },
  fields: {},
  conflict: false,
};
const history: Api.KnowledgeItemViewT = {
  id: "chat-history",
  kind: "product",
  recordKind: "Product",
  title: "Chat history service",
  record: { name: "Chat history service", ownedBy: "MSG", usedBy: ["Support team"] },
  review: {
    state: "stale",
    verdict: "verified",
    by: "tom",
    at: "2026-10-01T10:00:00Z",
  },
  fields: {},
  conflict: false,
};
const northwind: Api.KnowledgeItemViewT = {
  id: "northwind-pay",
  kind: "vendor",
  recordKind: "Party",
  title: "Northwind Pay",
  record: { name: "Northwind Pay", aliases: ["NWP"] },
  review: {
    state: "rejected",
    verdict: "rejected",
    by: "priya.nair",
    at: "2026-10-22T10:00:00Z",
    note: "Replaced last year.",
  },
  fields: {},
  conflict: false,
};

const ready = <T,>(data: T) => ({ state: "ready" as const, data });

describe("the shared knowledge pieces", () => {
  it("says each review in words", () => {
    expect(reviewText(undefined)).toBe(K.review.none);
    expect(reviewText(logging.review)).toBe(K.review.verified("priya.nair", "2026-10-22"));
    expect(reviewText(history.review)).toBe(K.review.stale("tom"));
    expect(reviewText(northwind.review)).toBe(K.review.rejected("priya.nair", "2026-10-22"));
  });

  it("searches items by every word, and groups them by kind in order", () => {
    expect(matchItem(kafka, "messaging kafka")).toBe(true);
    expect(matchItem(kafka, "kafka sso")).toBe(false);
    expect(matchItem(messaging, "msg")).toBe(true);
    expect(
      groupItems([logging, kafka, messaging], K.groups).map((g) => [
        g.title,
        g.items.map((i) => i.id),
      ]),
    ).toEqual([
      ["Requests and processes", ["kafka-topic-request"]],
      ["Standards and patterns", ["json-logging"]],
      ["Teams and vendors", ["messaging-team"]],
    ]);
  });

  it("sends only the changed fields of a correction, lists without blanks, links checked", () => {
    const form = {
      title: "Kafka topic",
      appliesWhen: "A service publishes to a topic that does not exist yet.",
      leadTime: " 3 working days ",
      handledBy: "Messaging team",
      steps: ["Open the platform catalogue", "", "Pick Kafka topic", "Name it"],
      urls: [
        { label: "Form", url: "https://servicedesk.example.com/kafka" },
        { label: "", url: "" },
      ],
    };
    expect(correctionBody(kafka, form)).toEqual({
      set: {
        leadTime: "3 working days",
        steps: ["Open the platform catalogue", "Pick Kafka topic", "Name it"],
      },
    });
    expect(
      correctionBody(kafka, { ...form, urls: [{ label: "Form", url: "servicedesk/kafka" }] }),
    ).toEqual({ error: K.items.badUrl("servicedesk/kafka") });
    expect(correctionBody(kafka, {})).toEqual({ error: K.items.noChange });
  });

  it("reads comma-separated tags and names one that isn't a slug", () => {
    expect(tagsOf("change-process, platform-runbook")).toEqual([
      "change-process",
      "platform-runbook",
    ]);
    expect(tagsOf("Change Process")).toEqual({ error: K.sources.notSlug("Change Process") });
  });
});

const sources: Api.KnowledgeSourceListT = {
  file: "org-pack/sources.yaml",
  types: ["confluence", "ado-wiki", "sharepoint", "markdown-folder", "git"],
  kindSuggestions: ["change-process"],
  staleDays: 14,
  sources: [
    {
      id: "platform-wiki",
      type: "git",
      location: "https://git.example.com/forge/platform.wiki.git",
      ref: "main",
      path: "pages",
      checkout: "submodule",
      owner: "platform-team",
      tags: { kinds: ["change-process"], frameworks: [] },
      snapshot: {
        date: "2026-10-01",
        takenAt: "2026-10-01T09:00:00Z",
        commit: "0123456789abcdef",
        pages: 12,
        skipped: 0,
        ageDays: 21,
      },
      scanned: { date: "2026-10-01", pages: 12 },
      stale: true,
      commands: {
        sync: "atticus sources sync --source platform-wiki",
        scan: "atticus knowledge scan --source platform-wiki",
        slash: "/atticus-knowledge platform-wiki",
      },
    },
  ],
  problems: [],
};

describe("Knowledge sources", () => {
  it("has loading, error and empty states", () => {
    const noop = () => undefined;
    expect(html(<SourceList of={{ state: "loading" }} onSync={noop} />)).toContain(
      'aria-busy="true"',
    );
    expect(html(<SourceList of={{ state: "error", error: "boom" }} onSync={noop} />)).toContain(
      'role="alert"',
    );
    expect(html(<SourceList of={ready({ ...sources, sources: [] })} onSync={noop} />)).toContain(
      esc(K.sources.empty),
    );
  });

  it("shows each source's git ref, path, checkout, tags, owner and snapshot, with Sync and the scan to copy", () => {
    const out = html(<SourceList of={ready(sources)} onSync={() => undefined} />);
    for (const s of ["main", "pages", "submodule", "change-process", "platform-team"])
      expect(out).toContain(s);
    expect(out).toContain(esc(K.sources.snapshotLine("2026-10-01", 12, 21)));
    expect(out).toContain("0123456");
    expect(out).toContain(esc(K.sources.stale(14)));
    expect(out).toContain(K.sources.sync("platform-wiki"));
    expect(out).toContain("atticus knowledge scan --source platform-wiki");
    expect(out).toContain("/atticus-knowledge platform-wiki");
  });

  it("builds the add request as sources add takes it, and refuses git options on a folder", () => {
    expect(
      addBody({
        ...EMPTY_ADD,
        location: "https://git.example.com/forge/platform.wiki.git",
        ref: "main",
        path: "pages",
        submodule: true,
        kinds: "change-process",
        owner: "platform-team",
      }),
    ).toEqual({
      body: {
        type: "git",
        location: "https://git.example.com/forge/platform.wiki.git",
        path: "pages",
        ref: "main",
        submodule: true,
        kinds: ["change-process"],
        owner: "platform-team",
        save: true,
      },
    });
    expect(addBody({ ...EMPTY_ADD })).toEqual({ error: K.sources.needLocation });
    expect(
      addBody({ ...EMPTY_ADD, type: "markdown-folder", location: "docs", ref: "main" }),
    ).toEqual({ error: K.sources.gitOnly });
    const out = html(<AddSource types={sources.types} kinds={["change-process"]} />);
    expect(out).toContain('<label for="src-location"');
    expect(out).toContain(esc(K.sources.addSave));
  });

  it("says what the last scan changed and which reviews to check again", () => {
    const scan: Api.KnowledgeScanViewT = {
      scannedAt: "2026-10-22T09:00:00Z",
      snapshots: [{ source: "platform-wiki", date: "2026-10-22", pages: 12 }],
      changes: {
        at: "2026-10-22T09:00:00Z",
        added: ["sso-intake"],
        changed: ["kafka-topic-request"],
        removed: [],
      },
      checkAgain: [
        { id: "chat-history", kind: "product", title: "Chat history service", by: "tom" },
      ],
      conflicts: 1,
      injections: 0,
      failed: 0,
      command: "atticus knowledge scan",
      slash: "/atticus-knowledge",
    };
    const out = html(<ScanReport of={ready(scan)} />);
    expect(out).toContain('href="#/knowledge?item=sso-intake"');
    expect(out).toContain('href="#/knowledge?item=chat-history"');
    expect(out).toContain("atticus knowledge scan");
    const never = html(
      <ScanReport
        of={ready({ ...scan, scannedAt: undefined, changes: undefined, checkAgain: [] })}
      />,
    );
    expect(never).toContain(esc(K.scan.never));
    expect(never).toContain(esc(K.scan.noCheckAgain));
    expect(html(<ScanReport of={{ state: "loading" }} />)).toContain('aria-busy="true"');
  });
});

describe("Knowledge items", () => {
  const list = ready({ items: [kafka, logging, northwind], problems: [] });
  it("has loading, error and empty states, and says when nothing matches", () => {
    expect(html(<ItemList of={{ state: "loading" }} text="" kind="" />)).toContain(
      'aria-busy="true"',
    );
    expect(html(<ItemList of={{ state: "error", error: "boom" }} text="" kind="" />)).toContain(
      'role="alert"',
    );
    expect(html(<ItemList of={ready({ items: [], problems: [] })} text="" kind="" />)).toContain(
      esc(K.items.empty),
    );
    expect(html(<ItemList of={list} text="nothing like it" kind="" />)).toContain(
      esc(K.items.noMatch),
    );
  });

  it("groups the items by kind with each review, rejected ones included", () => {
    const out = html(<ItemList of={list} text="" kind="" current="json-logging" />);
    expect(out).toContain("Requests and processes (1)");
    expect(out).toContain('href="#/knowledge?item=kafka-topic-request"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain(esc(K.review.rejected("priya.nair", "2026-10-22")));
    expect(html(<ItemList of={list} text="" kind="vendor" />)).not.toContain("Kafka topic");
  });

  it("shows an item's fields, quote, page and links, with Verify, Correct and Reject", () => {
    const out = html(<ItemDetail item={kafka} onReview={() => undefined} />);
    expect(out).toContain("5 working days");
    expect(out).toContain("<li>Open the platform catalogue</li>");
    expect(out).toContain("Handled by: Messaging team.");
    expect(out).toContain("platform/how-to/kafka.md (The request), line 7");
    expect(out).toContain('href="https://servicedesk.example.com/kafka"');
    for (const b of [K.items.verify, K.items.correct, K.items.reject])
      expect(out).toContain(`>${b}</button>`);
    expect(out).toContain(esc(K.review.none));
    // A conflict is said; a rejected item shows its reason.
    expect(html(<ItemDetail item={logging} />)).toContain(esc(K.items.conflict));
    expect(html(<ItemDetail item={northwind} />)).toContain("Replaced last year.");
    // B-task-knowledge (C4 2.25.0): what each page says, and who decided which applies.
    const C = COPY.knowledgeConflicts;
    const disputed = html(
      <ItemDetail
        item={{
          ...logging,
          conflicts: [
            {
              key: "json-logging @ forge-wiki/a.md | forge-wiki/b.md",
              about: ["json-logging"],
              pages: [
                { source: "forge-wiki", page: "a.md", says: "Log as JSON." },
                { source: "forge-wiki", page: "b.md", says: "Log as plain text." },
              ],
              applies: [{ source: "forge-wiki", page: "a.md" }],
              decided: {
                by: "code",
                record: "forge-orders.logging",
                kind: "Component",
                value: "logback.json",
                at: "forge-orders:src/main/resources/logback.xml:3",
              },
            },
          ],
        }}
      />,
    );
    expect(disputed).toContain(esc('forge-wiki/b.md says "Log as plain text."'));
    expect(disputed).toContain(
      esc(
        C.applies(
          "forge-wiki/a.md",
          C.byCode(
            "Component",
            "forge-orders.logging",
            "logback.json",
            "forge-orders:src/main/resources/logback.xml:3",
          ),
        ),
      ),
    );
  });

  it("corrects only the fields the record allows: lists as lists, links as label and address", () => {
    const out = html(
      <CorrectForm item={kafka} onSave={() => undefined} onCancel={() => undefined} />,
    );
    expect(out).toContain('<label for="fix-kafka-topic-request-leadTime"');
    expect(out).toContain(`aria-label="${esc(`${K.fields.steps}: ${K.items.item(2)}`)}"`);
    expect(out).toContain(`aria-label="${esc(`${K.items.link(1)}: ${K.items.linkUrl}`)}"`);
    expect(out).not.toContain("fix-kafka-topic-request-quote");
    const reject = html(<ItemDetail item={kafka} onReview={() => undefined} mode="reject" />);
    expect(reject).toContain(esc(K.items.rejectWhy));
  });
});

const search: Api.WikiSearchResultT = {
  phrase: "new starter",
  sources: 1,
  matches: [
    {
      source: "platform",
      page: "joiners.md",
      section: "Getting a laptop",
      line: 5,
      excerpt: "Raise the new starter request two weeks before the start date.",
    },
  ],
  pages: ["platform/joiners.md"],
  command: 'atticus knowledge find "new starter"',
  slash: "/atticus-find new starter",
};
const find: Api.SavedFindViewT = {
  slug: "new-starter",
  phrase: "new starter",
  at: "2026-10-22T09:30:00Z",
  file: "knowledge/finds/new-starter.yaml",
  matches: search.matches,
  candidates: [
    {
      id: "new-starter-request",
      kind: "request",
      recordKind: "ProcessDefinition",
      title: "New starter request",
      record: { quote: quote("joiners.md", "Raise the new starter request.") },
      keepAs: ["process", "request"],
    },
    {
      id: "kafka-topic-request",
      kind: "request",
      recordKind: "ProcessDefinition",
      title: "Kafka topic",
      record: {},
      known: "kafka-topic-request",
      keepAs: ["process", "request"],
    },
  ],
};

describe("Search the wikis", () => {
  it("shows the sections that mention the phrase and the AI step to copy", () => {
    const out = html(<SearchResult of={ready(search)} />);
    expect(out).toContain("platform/joiners.md");
    expect(out).toContain("Getting a laptop · 5");
    expect(out).toContain("Raise the new starter request two weeks before the start date.");
    expect(out).toContain(esc('atticus knowledge find "new starter"'));
    expect(out).toContain("/atticus-find new starter");
  });

  it("says when no page mentions it, when no source has a snapshot, and while it loads", () => {
    expect(html(<SearchResult of={ready({ ...search, matches: [], pages: [] })} />)).toContain(
      esc(K.search.none("new starter")),
    );
    expect(html(<SearchResult of={ready({ ...search, sources: 0 })} />)).toContain(
      esc(K.search.noSnapshot),
    );
    expect(html(<SearchResult of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<SearchResult of={{ state: "error", error: "boom" }} />)).toContain('role="alert"');
  });

  it("lists the saved searches and each candidate new or known, with Keep as its kinds", () => {
    expect(html(<FindList of={ready({ finds: [] })} />)).toContain(esc(K.search.noSaved));
    expect(html(<FindList of={ready({ finds: [find] })} current="new-starter" />)).toContain(
      'href="#/wiki-search?find=new-starter"',
    );
    const out = html(<FindDetail of={ready(find)} onKeep={() => undefined} />);
    expect(out).toContain(`>${K.search.fresh}<`);
    expect(out).toContain(esc(K.search.known("kafka-topic-request")));
    expect(out).toContain('<select id="keep-new-starter-request"');
    expect(out).toContain('<option value="process">Process</option>');
    // A known candidate has no Keep.
    expect(out).not.toContain('id="keep-kafka-topic-request"');
  });
});

describe("Teams, vendors and products", () => {
  it("gives each team what it owns and uses, by its page and the products naming it", () => {
    const r = relations([messaging, history, northwind]);
    expect(r.teams[0]).toMatchObject({
      aliases: ["MSG"],
      owns: ["Event bus", "Chat history service"],
      responsibilities: ["Runs the event bus"],
    });
    expect(r.products[0]).toMatchObject({ ownedBy: "MSG", usedBy: ["Support team"] });
    expect(r.vendors.map((v) => v.item.id)).toEqual(["northwind-pay"]);
  });

  it("has loading, error and empty states, and leaves rejected ones out", () => {
    expect(html(<PartiesPage of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<PartiesPage of={{ state: "error", error: "boom" }} />)).toContain('role="alert"');
    expect(html(<PartiesPage of={ready({ items: [kafka], problems: [] })} />)).toContain(
      esc(K.parties.empty),
    );
    const out = html(
      <PartiesPage of={ready({ items: [messaging, history, northwind], problems: [] })} />,
    );
    expect(out).toContain("Messaging team");
    expect(out).toContain("Chat history service");
    expect(out).not.toContain("Northwind Pay");
  });
});

const draft: Api.OrgPackDraftViewT = {
  platforms: [
    {
      platform: "forge",
      file: "proposals/orgpack/forge.yaml",
      present: true,
      at: "2026-10-22T10:00:00Z",
      command: "atticus orgpack draft --platform forge",
      proposals: [
        {
          from: "northwind-pay",
          kind: "vendor",
          action: "add",
          system: {
            id: "northwind-pay",
            name: "Northwind Pay",
            boundary: "vendor",
            aliases: ["NWP"],
            tags: [],
          },
          verified: true,
          verifiedBy: "priya.nair",
          quote: "Northwind Pay is the card processor.",
          page: "platform/vendors.md#Vendors",
          notes: [],
        },
        {
          from: "chat-history",
          kind: "product",
          action: "add",
          system: {
            id: "chat-history",
            name: "Chat history service",
            boundary: "internal",
            owner: "Messaging team",
            aliases: [],
            tags: [],
          },
          verified: false,
          notes: [],
        },
      ],
    },
  ],
};

describe("The org pack from the wikis", () => {
  it("picks the verified proposals to start with", () => {
    expect(initialPick(draft.platforms[0]!.proposals)).toEqual(["northwind-pay"]);
  });

  it("shows each proposed system, verified or not, with a checkbox and Accept", () => {
    const out = html(<DraftPage of={ready(draft)} onAccept={() => undefined} />);
    expect(out).toContain(`aria-label="${esc(K.orgpack.pick("Northwind Pay"))}" checked=""`);
    expect(out).not.toContain(
      `aria-label="${esc(K.orgpack.pick("Chat history service"))}" checked=""`,
    );
    expect(out).toContain(esc(K.orgpack.verified("priya.nair")));
    expect(out).toContain(esc(K.orgpack.unverified));
    expect(out).toContain(K.orgpack.accept);
    expect(out).toContain("atticus orgpack draft --platform forge");
  });

  it("has loading, error and empty states, and says when no draft is there yet", () => {
    expect(html(<DraftPage of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<DraftPage of={{ state: "error", error: "boom" }} />)).toContain('role="alert"');
    expect(html(<DraftPage of={ready({ platforms: [] })} />)).toContain(esc(K.orgpack.empty));
    const none = html(
      <DraftPage
        of={ready({
          platforms: [{ ...draft.platforms[0]!, present: false, proposals: [], at: undefined }],
        })}
      />,
    );
    expect(none).toContain(esc(K.orgpack.noDraft));
  });
});

const needs: Api.ChangeNeedsViewT = {
  change: "add-chat-export",
  file: "openspec/changes/add-chat-export/needs.yaml",
  present: true,
  updatedAt: "2026-10-22T09:00:00Z",
  command: "atticus change needs add-chat-export",
  slash: "/atticus-needs add-chat-export",
  considered: [{ item: "sso-intake", why: "The change adds no web application." }],
  needs: [
    {
      item: "kafka-topic-request",
      kind: "request",
      title: "Kafka topic",
      for: "story:s1-export-chat",
      why: "The story publishes on a new topic.",
      because: { file: "stories/s1-export-chat.md", quote: "on the chat-exports topic", line: 3 },
      when: "before-build",
      from: "assistant",
      leadTime: "5 working days",
      handledBy: "Messaging team",
      catalogueItem: "CTASK: Kafka topic",
      inputs: [],
      steps: ["Open the platform catalogue"],
      rules: [],
      urls: [{ label: "Form", url: "https://servicedesk.example.com/kafka" }],
      page: "platform/how-to/kafka.md#The request",
      status: "open",
      review: {
        state: "verified",
        verdict: "verified",
        by: "priya.nair",
        at: "2026-10-22T10:00:00Z",
      },
    },
    {
      item: "json-logging",
      kind: "standard",
      title: "Log as JSON",
      for: "change",
      why: "Every backend service logs.",
      from: "assistant",
      inputs: [],
      steps: [],
      rules: ["Log as JSON"],
      urls: [],
      status: "done",
      by: "priya.nair",
      note: "Already done",
    },
  ],
};

describe("A change's needs", () => {
  it("says the step to find them when the change has none yet", () => {
    const out = html(
      <NeedsView of={ready({ ...needs, present: false, needs: [], considered: [] })} />,
    );
    expect(out).toContain(esc(K.needs.none("add-chat-export")));
    expect(out).toContain("atticus change needs add-chat-export");
    expect(out).toContain("/atticus-needs add-chat-export");
    expect(html(<NeedsView of={{ state: "loading" }} />)).toContain('aria-busy="true"');
    expect(html(<NeedsView of={{ state: "error", error: "boom" }} />)).toContain('role="alert"');
    expect(html(<NeedsView of={ready({ ...needs, needs: [], considered: [] })} />)).toContain(
      esc(K.needs.empty),
    );
  });

  it("groups them as needs.md does, each with its how-to, why and its item's tick", () => {
    const out = html(<NeedsView of={ready(needs)} onMark={() => undefined} />);
    expect(out).toContain(esc("Requests and processes to raise"));
    expect(out).toContain(esc("Standards and patterns to follow"));
    expect(out).toContain("5 working days");
    expect(out).toContain("CTASK: Kafka topic");
    expect(out).toContain("<q>on the chat-exports topic</q>");
    expect(out).toContain("stories/s1-export-chat.md:3");
    expect(out).toContain(esc(K.review.verified("priya.nair", "2026-10-22")));
    expect(out).toContain(esc(K.review.none));
    expect(out).toContain(`>${K.needs.markDone}</button>`);
    expect(out).toContain(`>${K.needs.reopen}</button>`);
    expect(out).toContain(esc(K.needs.done("priya.nair", "Already done")));
    expect(out).toContain(esc(K.needs.considered));
  });

  it("marks a need: not needed takes a reason, done keeps its note, reopen drops it", () => {
    expect(markBody("not-needed", " ", "change")).toEqual({ error: K.needs.needWhy });
    expect(markBody("done", "CTASK0012345", "story:s1")).toEqual({
      body: { status: "done", for: "story:s1", note: "CTASK0012345" },
    });
    expect(markBody("open", "x", "change")).toEqual({ body: { status: "open", for: "change" } });
    expect(needTick(needs.needs[0]!).ok).toBe(true);
    expect(needTick(needs.needs[1]!)).toEqual({ text: K.review.none, ok: false });
  });
});

/** What the app review found (October 2026): each gap, as the screen now says it. */
describe("the knowledge screens, after the app review", () => {
  it("says a source was never synced, not that its snapshot is too old", () => {
    const never = { ...sources.sources[0]!, snapshot: undefined, scanned: undefined };
    const out = html(
      <SourceList of={ready({ ...sources, sources: [never] })} onSync={() => undefined} />,
    );
    expect(out).toContain(esc(K.sources.unsynced));
    expect(out).not.toContain(esc(K.sources.stale(14)));
    // One with an old snapshot still says how old is too old.
    expect(html(<SourceList of={ready(sources)} onSync={() => undefined} />)).toContain(
      esc(K.sources.stale(14)),
    );
  });

  it("says when the item in the address isn't there, instead of asking to pick one", () => {
    expect(itemFor([kafka, logging], "json-logging")).toEqual({ item: logging });
    expect(itemFor([kafka], "gone-item")).toEqual({ missing: "gone-item" });
    expect(itemFor([kafka], undefined)).toEqual({});
  });

  it("names a page and its heading the same way on every screen", () => {
    expect(pageText("platform/vendors.md#Vendors")).toBe("platform/vendors.md (Vendors)");
    expect(pageText("platform/vendors.md")).toBe("platform/vendors.md");
    const out = html(<DraftPage of={ready(draft)} onAccept={() => undefined} />);
    expect(out).toContain("platform/vendors.md (Vendors)");
    expect(out).not.toContain("vendors.md#Vendors");
    const n = html(<NeedsView of={ready(needs)} onMark={() => undefined} />);
    expect(n).toContain(esc(K.needs.from("platform/how-to/kafka.md (The request)")));
  });

  it("opening a saved search keeps the search on screen", () => {
    expect(html(<FindList of={ready({ finds: [find] })} q="new starter" />)).toContain(
      'href="#/wiki-search?q=new+starter&amp;find=new-starter"',
    );
  });

  it("gives each Keep, Done, Not needed and Reopen a name that says which one", () => {
    const keep = html(<FindDetail of={ready(find)} onKeep={() => undefined} />);
    expect(keep).toContain(`aria-label="${esc(K.search.keepOf("New starter request"))}"`);
    const out = html(<NeedsView of={ready(needs)} onMark={() => undefined} />);
    expect(out).toContain(`aria-label="${esc(K.needs.markDoneOf("Kafka topic"))}"`);
    expect(out).toContain(`aria-label="${esc(K.needs.markSkipOf("Kafka topic"))}"`);
    expect(out).toContain(`aria-label="${esc(K.needs.reopenOf("Log as JSON"))}"`);
  });

  it("says a need's item was rejected, not that it is unverified", () => {
    const rejected = { ...needs.needs[0]!, review: northwind.review };
    expect(needTick(rejected)).toEqual({
      text: K.review.rejected("priya.nair", "2026-10-22"),
      ok: false,
      rejected: true,
    });
    const out = html(<NeedsView of={ready({ ...needs, needs: [rejected] })} />);
    expect(out).toContain(`chip blocking">${esc(K.review.rejected("priya.nair", "2026-10-22"))}`);
  });

  it("says a reopened need is open again", () => {
    expect(markedWords("open")).toBe(K.needs.openAgain);
    expect(markedWords("done")).toBe("done");
    expect(markedWords("not-needed")).toBe(K.needs.markSkip.toLowerCase());
  });
});

describe("review mode for knowledge (WP7.8)", () => {
  it("walks the items nobody has reviewed, or whose page changed since", () => {
    const stale: Api.KnowledgeItemViewT = {
      ...logging,
      id: "stale-one",
      review: { ...logging.review!, state: "stale" },
    };
    const queue = reviewQueue([kafka, logging, stale, messaging]);
    expect(queue.map((i) => i.id)).toEqual(["kafka-topic-request", "stale-one", "messaging-team"]);
    expect(stepQueue(queue, "kafka-topic-request", 1)).toBe("stale-one");
    expect(stepQueue(queue, "messaging-team", 1)).toBe("messaging-team");
    expect(stepQueue(queue, "kafka-topic-request", -1)).toBe("kafka-topic-request");
    expect(stepQueue(queue, "json-logging", 1)).toBe("kafka-topic-request");
    expect(stepQueue([], undefined, 1)).toBeUndefined();
  });

  it("reads j, k and the arrows to move, and v, c and r to verify, correct and reject", () => {
    expect(["j", "ArrowDown", "k", "ArrowUp", "v", "c", "r", "x"].map(reviewKey)).toEqual([
      "next",
      "next",
      "prev",
      "prev",
      "verify",
      "correct",
      "reject",
      undefined,
    ]);
  });
});
