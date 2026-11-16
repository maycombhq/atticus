import { describe, expect, it } from "vitest";
import { parseRecord } from "@maycombhq/core";
import {
  knowledgeAnswer,
  rankItems,
  rankPassages,
  searchPages,
  sectionOf,
  termsOf,
  type KnowledgeRecord,
  type PassagePage,
  type Snapshot,
} from "../src/index.js";

// beta.28.3: what a review of Ask, Search and "Read it here" found on invented Forge wikis, and
// an acronym and its words finding each other in Ask.

const page = (p: string, text: string): PassagePage => ({
  source: "platform",
  page: p,
  path: `knowledge/snapshots/platform/2026-11-16/${p}`,
  text,
});

const snap = (text: string) =>
  [
    {
      manifest: { source: "platform" },
      dir: "x",
      pages: [{ pagePath: "a.md", path: "x/a.md", text }],
    },
  ] as unknown as Snapshot[];

describe("a suggested section opens in place by the id the index gives it", () => {
  const long = Array.from(
    { length: 12 },
    (_, i) => `Paragraph ${i}. ${"The forge gateway allowlist is reviewed weekly. ".repeat(6)}`,
  ).join("\n\n");
  const pages = [
    page("how-to/firewall.md", `# Firewall rules\n\n## Long allowlist\n\n${long}\n`),
    page("Release #4 notes.md", "# Release #4\n\n## Rollback plan\n\nRedeploy the previous tag.\n"),
    page("Release.md", "# Release\n\n## 4 notes\n\nNot this page.\n"),
  ];

  it("a later part of a long section (…#Heading#2)", () => {
    expect(sectionOf(pages, "platform/how-to/firewall.md#Long allowlist#2")?.heading).toBe(
      "Firewall rules › Long allowlist",
    );
    expect(sectionOf(pages, "platform/how-to/firewall.md#long-allowlist#3")?.heading).toBe(
      "Firewall rules › Long allowlist",
    );
  });

  it("a page whose file name has a # in it, never a shorter-named page", () => {
    expect(sectionOf(pages, "platform/Release #4 notes.md#Rollback plan")?.text).toBe(
      "Redeploy the previous tag.",
    );
    expect(sectionOf(pages, "platform/Release #4 notes.md")?.page).toBe("Release #4 notes.md");
    expect(sectionOf(pages, "platform/Release.md#4 notes")?.text).toBe("Not this page.");
  });

  it("opens part 2 of Step, not the section Step 2 beside it", () => {
    const p = [page("w/a.md", "# Run\n\n## Step\n\nFirst.\n\n## Step 2\n\nSecond.\n")];
    expect(sectionOf(p, "platform/w/a.md#Step#2")?.text).toBe("First.");
    expect(sectionOf(p, "platform/w/a.md#Step 2")?.text).toBe("Second.");
    expect(sectionOf(p, "platform/w/a.md#step-2")?.text).toBe("Second.");
  });

  it("still gives nothing for a heading the page doesn't have", () => {
    expect(sectionOf(pages, "platform/how-to/firewall.md#No such heading")).toBeUndefined();
    expect(sectionOf(pages, "platform/how-to/firewall.md#No such heading#2")).toBeUndefined();
  });
});

describe("Ask over the wikis' passages", () => {
  it("finds a sentence past the first 1,500 characters of a long section, and shows it", () => {
    const filler = "The forge gateway allowlist is reviewed weekly by the platform team. ".repeat(
      30,
    );
    const p = page(
      "how-to/tokens.md",
      `# Tokens\n\n## Rotation\n\n${filler}\n\nThe zanzibar token is rotated monthly.\n`,
    );
    const found = rankPassages("zanzibar rotated", [p]);
    expect(found.map((s) => s.heading)).toEqual(["Tokens › Rotation"]);
    expect(found[0]!.text).toContain("The zanzibar token is rotated monthly.");
    expect(found[0]!.text.length).toBeLessThanOrEqual(1500);
  });

  it("finds the page that says rules, services, changes or policies for the singular, and the other way", () => {
    const p = page(
      "standards/limits.md",
      "# Limits\n\n## Quotas\n\nThe services share one budget; the rules, policies and changes are listed here.\n",
    );
    for (const q of ["rule", "service", "change", "policy"])
      expect(
        rankPassages(q, [p]).map((s) => s.heading),
        q,
      ).toEqual(["Limits › Quotas"]);
    for (const [a, b] of [
      ["rule", "rules"],
      ["service", "services"],
      ["change", "changes"],
      ["changed", "changing"],
      ["page", "pages"],
      ["file", "files"],
      ["policy", "policies"],
      ["process", "processes"],
      ["cache", "cached"],
      ["issue", "issues"],
      ["value", "values"],
      ["queue", "queues"],
      ["tree", "trees"],
      ["query", "queried"],
      ["retries", "retried"],
      ["applies", "applied"],
      ["agree", "agreed"],
      ["sign", "signing"],
    ])
      expect(termsOf(a!), `${a} / ${b}`).toEqual(termsOf(b!));
    // Words that are not each other stay apart.
    for (const [a, b] of [
      ["note", "not"],
      ["care", "car"],
      ["rate", "rat"],
      ["site", "sit"],
      ["core", "cors"],
      ["status", "state"],
      ["access", "accessory"],
    ])
      expect(termsOf(a!), `${a} / ${b}`).not.toEqual(termsOf(b!));
  });

  it("never lists a heading with no words under it as a passage", () => {
    const p = page(
      "how-to/firewall.md",
      "# Firewall rules\n\n## Requesting a firewall rule\n\nRaise a Forge Desk request.\n",
    );
    const found = rankPassages("requesting firewall rules", [p]);
    expect(found.map((s) => s.heading)).toEqual(["Firewall rules › Requesting a firewall rule"]);
    // The bare heading still opens by its id.
    expect(sectionOf([p], "platform/how-to/firewall.md#Firewall rules")?.heading).toBe(
      "Firewall rules",
    );
  });

  it("finds the section that writes a defined name the other way: the acronym asked for, or its words", () => {
    const pages = [
      page(
        "data/warehouse.md",
        "# Reporting\n\n## Nightly load\n\nThe enterprise data warehouse takes each Forge service's rows at night.\n",
      ),
      page(
        "identity/gate.md",
        "# Identity\n\n## The gate\n\nSend a shopper who isn't logged in to the SSO page of Forge Identity.\n",
      ),
      page("orders/history.md", "# Orders\n\n## History\n\nA shopper's orders are kept.\n"),
      page(
        "abbreviations.md",
        "# Abbreviations\n\n## List\n\n- EDW: Enterprise Data Warehouse\n- SSO: single sign-on\n",
      ),
    ];
    expect(rankPassages("Which apps publish to the EDW?", pages).map((s) => s.heading)).toContain(
      "Reporting › Nightly load",
    );
    expect(
      rankPassages("How does single sign-on work for a new endpoint?", pages).map((s) => s.heading),
    ).toContain("Identity › The gate");
    // With no page defining them, letters alone link nothing: "step still open" is no SSO.
    const undefinedPages = [
      ...pages.slice(0, 3),
      page("orders/steps.md", "# Steps\n\n## Review\n\nA step still open blocks the release.\n"),
    ];
    expect(rankPassages("Which apps publish to the EDW?", undefinedPages)).toEqual([]);
    expect(rankPassages("Who owns SSO?", undefinedPages).map((s) => s.heading)).toEqual([
      "Identity › The gate",
    ]);
  });

  it("shows the sentence found in a long section with odd spacing or no paragraphs at all", () => {
    const filler = "The forge gateway allowlist is reviewed weekly by the platform team.";
    const odd = page(
      "a.md",
      `# A\n\n## Spaced\n\n${Array(30).fill(filler).join("\n   \n")}\n   \nThe zanzibar token is rotated monthly.\n`,
    );
    const one = page(
      "b.md",
      `# B\n\n## One paragraph\n\n${Array(40).fill(filler).join(" ")} The quokka token is rotated monthly. ${filler}\n`,
    );
    const list = page(
      "c.md",
      `# C\n\n## A list\n\n${Array(40).fill(`- ${filler}`).join("\n")}\n- The numbat token is rotated monthly.\n`,
    );
    for (const [p, word] of [
      [odd, "zanzibar"],
      [one, "quokka"],
      [list, "numbat"],
    ] as const) {
      const text = rankPassages(`${word} rotated`, [p])[0]!.text;
      expect(text, word).toContain(`The ${word} token is rotated monthly.`);
      expect(text.length, word).toBeLessThanOrEqual(1500);
      expect(text, word).toMatch(/^… (The|- The) /);
    }
  });
});

describe("Ask over the knowledge items", () => {
  const item = (o: Record<string, unknown>) => {
    const p = parseRecord({
      schemaVersion: 2,
      status: "current",
      confidence: "inferred",
      evidence: [{ source: "document", path: "knowledge/snapshots/platform/2026-10-20/x.md" }],
      kind: "ProcessDefinition",
      processKind: "request",
      ...o,
    });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record as KnowledgeRecord;
  };
  const kafka = item({
    id: "kafka-topic-request",
    title: "Kafka topic",
    appliesWhen: "A service publishes to a topic that does not exist yet.",
    leadTime: "5 working days",
    handledBy: "Messaging team",
    quote: {
      source: "platform",
      page: "how-to/kafka.md",
      section: "The request",
      text: "Handled by: Messaging team.",
      snapshot: "2026-10-20",
    },
  });

  it("lists an item matched by when it applies, as knowledge ask would answer from it", () => {
    const q = "What must a service do before it publishes somewhere new?";
    expect(rankItems(q, [kafka]).map((x) => x.item.id)).toEqual(["kafka-topic-request"]);
    expect(knowledgeAnswer(q, { items: [kafka], pages: [] }).items.map((i) => i.id)).toEqual([
      "kafka-topic-request",
    ]);
  });

  it("ranks the item that only writes the acronym for a question that spells it out", () => {
    const gate = item({
      id: "sso-login-gate",
      title: "Put an endpoint behind SSO login",
      appliesWhen: "An endpoint of a Forge service is open only to users logged in with SSO.",
      steps: ["Send a user who isn't logged in to the SSO login page of Forge Identity."],
      quote: {
        source: "platform",
        page: "sso-login-gate.md",
        section: "Steps",
        text: "Send a user who isn't logged in to the SSO login page of Forge Identity.",
        snapshot: "2026-10-20",
      },
    });
    const q = "How do I add single sign-on?";
    // Nothing defines SSO: the letters alone link nothing.
    expect(rankItems(q, [kafka, gate])).toEqual([]);
    // A page of the wiki does: the item is found and listed.
    const pages = [page("abbreviations.md", "# Abbreviations\n\n- SSO: single sign-on\n")];
    expect(knowledgeAnswer(q, { items: [kafka, gate], pages }).items.map((i) => i.id)).toEqual([
      "sso-login-gate",
    ]);
    // And an item that defines it itself.
    const defines = item({
      id: "identity-terms",
      title: "Forge Identity terms",
      appliesWhen: "Reading an identity page.",
      notes: "Single sign-on (SSO) is the only way in.",
      quote: {
        source: "platform",
        page: "identity.md",
        section: "Terms",
        text: "Single sign-on (SSO) is the only way in.",
        snapshot: "2026-10-20",
      },
    });
    expect(rankItems(q, [kafka, gate, defines]).map((x) => x.item.id)).toContain("sso-login-gate");
  });
});

describe("searching the wikis", () => {
  it("never matches or shows hidden text", () => {
    const s = snap(
      "# Rules\n\nThe visible platypus rule.<!-- the narwhal password is hunter2 -->\n",
    );
    expect(searchPages(s, "narwhal")).toEqual([]);
    expect(searchPages(s, "platypus")[0]!.excerpt).toBe("The visible platypus rule.");
  });

  it("never matches a page's front matter, and keeps the page's own line numbers", () => {
    const s = snap(
      "---\ntitle: Idempotency Keys\nauthor: lee\n---\n# Idempotency Keys\n\nKeep it.\n",
    );
    expect(searchPages(s, "lee")).toEqual([]);
    expect(searchPages(s, "idempotency").map((m) => m.line)).toEqual([5]);
  });

  it("doesn't take a comment in a code block for a heading", () => {
    const s = snap("# Setup\n\n```sh\n# install the wombat\nmake wombat\n```\n\nThen run it.\n");
    expect(searchPages(s, "wombat").map((m) => [m.section, m.line])).toEqual([["Setup", 4]]);
  });
});
