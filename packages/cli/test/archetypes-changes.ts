import { bigGatewayId, bigRepoId } from "./big-estate.js";
import { FIELD_TOPIC_LISTENER, FIELD_TOPIC_PUBLISHER } from "./field-estate.js";

/**
 * The three kinds of change ADR 0201 was written for, as invented changes to the field-shaped
 * estate (field-estate.ts): a new product no repo holds, a move of services to another platform
 * in two waves, and a new event to a topic the estate has. Each has the requirements file its
 * personas and their naysayers leave (the ADR's format: `## Planned`, a section a role with its
 * six-column table of questions) and the four files the personas write for the quick path
 * (proposal, one spec delta, design, tasks), as a person would have them before the hand-off.
 *
 * Invented names only: the Forge estate, the Anvil platform, the people pat, ari, dev, quinn and
 * sam. Every text is LF; writeChangeFiles writes it so on every platform.
 */

/** What the estate is given for these changes (makeFieldEstate's options). */
export const EMPTY_REPO = "forge-deploy";
export const UNREAD_REPO = "forge-audit";
export const TOPIC = "forge.items.settled";
/** The catalog's id for the topic: the listener's Endpoint (its entry on the topic). */
export const TOPIC_ENDPOINT = `${FIELD_TOPIC_LISTENER}.on-forge-items-settled`;

export interface Archetype {
  id: string;
  /** The requirements file's first heading, which `change new --from` takes as the title. */
  title: string;
  requirements: string;
  /** What `--check` counts: rows by state, evidence ids by where they are known. */
  counts: { questions: number; answered: number; accepted: number; inMap: number; planned: number };
  /** proposal.md, specs/<capability>/spec.md, design.md and tasks.md, by path. */
  files: Record<string, string>;
  /** The spec delta's path, the one file under specs/. */
  spec: string;
  /** The repos tasks.md has a heading for, in its order. */
  repos: string[];
}

const HEADER = [
  "| Question | Evidence | Asked by | Answered by | Answer | State |",
  "| --- | --- | --- | --- | --- | --- |",
];
type Row = [
  question: string,
  evidence: string,
  askedBy: string,
  answeredBy: string,
  answer: string,
  state: string,
];
/** A role's section: its heading, its part of the requirement, and its naysayer's questions. */
export const section = (role: string, text: string, rows: Row[]): string =>
  [`## ${role}`, "", text, "", ...HEADER, ...rows.map((r) => `| ${r.join(" | ")} |`), ""].join(
    "\n",
  );

const proposal = (o: { why: string; what: string[]; capability: string; impact: string }) =>
  [
    "# Proposal",
    "",
    "## Why",
    "",
    o.why,
    "",
    "## What Changes",
    "",
    ...o.what.map((w) => `- ${w}`),
    "",
    "## Capabilities",
    "",
    "### New Capabilities",
    "",
    `- \`${o.capability}\``,
    "",
    "## Impact",
    "",
    o.impact,
    "",
  ].join("\n");

const delta = (requirements: { name: string; shall: string; scenarios: [string, string[]][] }[]) =>
  [
    "## ADDED Requirements",
    "",
    ...requirements.flatMap((r) => [
      `### Requirement: ${r.name}`,
      "",
      r.shall,
      "",
      ...r.scenarios.flatMap(([name, lines]) => [`#### Scenario: ${name}`, "", ...lines, ""]),
    ]),
  ].join("\n");

const design = (o: { context: string; decisions: string[]; rollout: string; risks: string }) =>
  [
    "# Design",
    "",
    "## Context",
    "",
    o.context,
    "",
    "## Decisions",
    "",
    ...o.decisions.map((d) => `- ${d}`),
    "",
    "## Rollout and rollback",
    "",
    o.rollout,
    "",
    "## Risks",
    "",
    o.risks,
    "",
  ].join("\n");

// ---------------------------------------------------------------------------------------------
// A new product: an approvals portal in two repos no manifest lists yet.
// ---------------------------------------------------------------------------------------------

export const PORTAL_API = "forge-approvals-api";
export const PORTAL_WEB = "forge-approvals-web";

export const NEW_PRODUCT: Archetype = {
  id: "approvals-portal",
  title: "Approvals portal",
  requirements: [
    "# Approvals portal",
    "",
    "Branch managers approve refunds over the desk limit by telephone today. They want one page",
    "that lists what waits for them and records who approved what.",
    "",
    "## Planned",
    "",
    `- \`${PORTAL_API}\`: the portal's service, a new repo`,
    `- \`${PORTAL_WEB}\`: the portal's pages, a new repo`,
    "",
    section(
      "Product owner",
      "An approval is asked for, shown to the branch manager, and approved or refused once.",
      [
        [
          "Who may approve a refund?",
          "-",
          "product-owner-naysayer",
          "pat",
          "The branch manager of the refund's branch, nobody else",
          "answered",
        ],
        [
          "What happens to a request nobody answers?",
          "-",
          "product-owner-naysayer",
          "pat",
          "pat accepts this for the first release: it stays open, and the count is shown",
          "accepted",
        ],
      ],
    ),
    section(
      "Application architect",
      "Two new repos. The service keeps the requests; the pages read them from the service only.",
      [
        [
          "Which service holds the refund the request is about?",
          `\`${bigRepoId(0)}\``,
          "application-architect-naysayer",
          "ari",
          `${bigRepoId(0)}, read through its existing entries; the portal stores the refund's id only`,
          "answered",
        ],
        [
          "Do the pages call anything but the portal's own service?",
          `\`${PORTAL_WEB}\`; \`${PORTAL_API}\``,
          "application-architect-naysayer",
          "ari",
          "No. The pages call the service, and the service calls the estate",
          "answered",
        ],
      ],
    ),
    section("Security", "Only a signed-in branch manager reaches the portal.", [
      [
        "Does the portal go through the gateway like every other entry?",
        `\`${bigGatewayId(0)}\``,
        "security-naysayer",
        "sam",
        "Yes, a new route on the existing proxy, in a later change",
        "answered",
      ],
    ]),
  ].join("\n"),
  counts: { questions: 5, answered: 4, accepted: 1, inMap: 2, planned: 2 },
  spec: "specs/refund-approvals/spec.md",
  repos: [PORTAL_API, PORTAL_WEB],
  files: {
    "proposal.md": proposal({
      why: "Refunds over the desk limit are approved by telephone, and nobody can say afterwards who approved one.",
      what: [
        `A new service, ${PORTAL_API}, keeps each approval request and its decision.`,
        `New pages, ${PORTAL_WEB}, list a branch manager's open requests and record the decision.`,
        "No existing service changes a step.",
      ],
      capability: "refund-approvals",
      impact: `Two new repos, ${PORTAL_API} and ${PORTAL_WEB}, which no manifest lists until they are made. ${bigRepoId(0)} is read through entries it has today.`,
    }),
    "specs/refund-approvals/spec.md": delta([
      {
        name: "A refund over the desk limit waits for its branch manager",
        shall:
          "The approvals portal SHALL keep every refund over the desk limit as an open request until the branch manager of its branch approves or refuses it.",
        scenarios: [
          [
            "A branch manager approves a request",
            [
              "- **GIVEN** an open request for a refund of the manager's own branch",
              "- **WHEN** the manager approves it",
              "- **THEN** the request is closed as approved, with the manager's name and the time",
            ],
          ],
          [
            "A manager of another branch is refused",
            [
              "- **GIVEN** an open request for a refund of another branch",
              "- **WHEN** the manager tries to approve it",
              "- **THEN** the portal refuses and the request stays open",
            ],
          ],
        ],
      },
    ]),
    "design.md": design({
      context: `The estate has no approvals. The refund itself stays where it is, in ${bigRepoId(0)}.`,
      decisions: [
        `${PORTAL_API} owns the requests and their decisions in a store of its own.`,
        `${PORTAL_WEB} calls ${PORTAL_API} only.`,
        `${PORTAL_API} reads a refund from ${bigRepoId(0)} by its id and stores nothing else of it.`,
      ],
      rollout:
        "The service is released first with no page calling it; the pages follow. Rolling back removes the pages, then the service; no existing store is written.",
      risks:
        "The gateway route is a later change, so the portal is reachable inside the estate only until then.",
    }),
    "tasks.md": [
      `## ${PORTAL_API}`,
      "",
      "- [ ] 1.1 Create the service with its store of approval requests",
      "- [ ] 1.2 Approve and refuse a request, for the branch's own manager only",
      "",
      `## ${PORTAL_WEB}`,
      "",
      "- [ ] 2.1 List the manager's open requests and record a decision (after 1.2)",
      "",
    ].join("\n"),
  },
};

// ---------------------------------------------------------------------------------------------
// A migration: three services moved to the Anvil platform in two waves. No runtime step changes.
// ---------------------------------------------------------------------------------------------

export const MOVED = [bigRepoId(0), bigRepoId(1), bigRepoId(4)] as const;

export const MIGRATION: Archetype = {
  id: "move-to-anvil",
  title: "Move three services to the Anvil platform",
  requirements: [
    "# Move three services to the Anvil platform",
    "",
    "The hosts these services run on are retired at the end of the quarter. They move to the",
    "Anvil platform as they are: no entry, call or table changes.",
    "",
    section(
      "Application architect",
      `${MOVED[0]} and ${MOVED[1]} move first. ${MOVED[2]} moves once both run on Anvil, and the deploy settings in ${EMPTY_REPO} follow.`,
      [
        [
          "Why does one service wait for the other two?",
          `\`${MOVED[2]}\``,
          "application-architect-naysayer",
          "ari",
          "It calls both, and its calls must not cross platforms for longer than a day",
          "answered",
        ],
        [
          "Where do the platform's deploy settings live?",
          `\`${EMPTY_REPO}\``,
          "application-architect-naysayer",
          "ari",
          "In the deploy repo, made for this and still empty",
          "answered",
        ],
      ],
    ),
    section(
      "Developer",
      "Each service gains a deployment descriptor for Anvil and loses its host scripts.",
      [
        [
          "Does any setting change its value on the new platform?",
          `\`${MOVED[0]}\` src/main/resources/application.yml:1; \`${MOVED[1]}\` src/main/resources/application.yml:1`,
          "developer-naysayer",
          "dev",
          "No value changes; the platform supplies the same keys",
          "answered",
        ],
      ],
    ),
    section("QA", "The services answer as before from the new platform.", [
      [
        "What proves a moved service still answers?",
        "-",
        "qa-naysayer",
        "quinn",
        "Its health entry answers on Anvil before traffic moves, and its contract tests pass there",
        "answered",
      ],
    ]),
  ].join("\n"),
  counts: { questions: 4, answered: 4, accepted: 0, inMap: 4, planned: 0 },
  spec: "specs/service-hosting/spec.md",
  repos: [MOVED[0], MOVED[1], MOVED[2], EMPTY_REPO],
  files: {
    "proposal.md": proposal({
      why: "The hosts three services run on are retired at the end of the quarter.",
      what: [
        `${MOVED[0]} and ${MOVED[1]} are deployed to the Anvil platform (wave 1).`,
        `${MOVED[2]} follows once both run there, then traffic is routed by ${EMPTY_REPO}'s settings (wave 2).`,
        "No entry, call, table or setting value changes.",
      ],
      capability: "service-hosting",
      impact: `${MOVED.join(", ")} and ${EMPTY_REPO}. What changes is in operation only: where each service runs and how it is rolled back.`,
    }),
    "specs/service-hosting/spec.md": delta([
      {
        name: "A moved service is served from the Anvil platform",
        shall:
          "Each moved service SHALL be served from the Anvil platform only once its health entry answers there, and SHALL be served from its old host again within one deployment if it stops answering.",
        scenarios: [
          [
            "Traffic moves after the health entry answers",
            [
              "- **GIVEN** a service deployed to Anvil whose health entry answers",
              "- **WHEN** its wave is released",
              "- **THEN** its traffic is served from Anvil and its old host takes none",
            ],
          ],
          [
            "A service that stops answering goes back",
            [
              "- **GIVEN** a moved service whose health entry stops answering on Anvil",
              "- **WHEN** the operator rolls its wave back",
              "- **THEN** its traffic is served from its old host again",
            ],
          ],
        ],
      },
    ]),
    "design.md": design({
      context: "A move of platform. No flow of any service changes a step.",
      decisions: [
        `Wave 1: ${MOVED[0]} and ${MOVED[1]}, which call nothing that moves.`,
        `Wave 2: ${MOVED[2]}, which calls both, then the routing in ${EMPTY_REPO}.`,
        "Each service keeps its settings' keys and values; Anvil supplies them.",
      ],
      rollout:
        "A wave is released when every service in it answers its health entry on Anvil. Rolling a wave back routes its services to their old hosts, which stay up until the change is released; no store is written, so nothing is undone in data.",
      risks: `Between the waves ${MOVED[2]} calls across platforms; the second wave follows within a day.`,
    }),
    "tasks.md": [
      `## ${MOVED[0]}`,
      "",
      "- [ ] m1 Add the Anvil deployment descriptor and drop the host scripts",
      "",
      `## ${MOVED[1]}`,
      "",
      "- [ ] m2 Add the Anvil deployment descriptor and drop the host scripts",
      "",
      `## ${MOVED[2]}`,
      "",
      "- [ ] m3 Add the Anvil deployment descriptor and drop the host scripts (after m1, m2)",
      "",
      `## ${EMPTY_REPO}`,
      "",
      "- [ ] m4 Route the three services' traffic to Anvil (after m3)",
      "",
    ].join("\n"),
  },
};

// ---------------------------------------------------------------------------------------------
// A new event: one more service publishes to a topic the estate has. One of its consumers is a
// repo the manifest lists that nobody has read.
// ---------------------------------------------------------------------------------------------

export const NEW_PUBLISHER = bigRepoId(1);

export const NEW_EVENT: Archetype = {
  id: "publish-settled-refunds",
  title: "Publish settled refunds",
  requirements: [
    "# Publish settled refunds",
    "",
    `Refunds settle in ${NEW_PUBLISHER} and nothing says so. It publishes each settled refund to`,
    `the topic ${TOPIC}, which the estate has, so that who listens there hears of refunds too.`,
    "",
    section(
      "Application architect",
      `${NEW_PUBLISHER} becomes a second publisher of ${TOPIC}. ${FIELD_TOPIC_PUBLISHER} publishes to it today.`,
      [
        [
          "Who receives the topic today, and do they expect a refund on it?",
          `\`${TOPIC_ENDPOINT}\` src/main/java/forge/events/ItemListener.java:1`,
          "application-architect-naysayer",
          "ari",
          `${FIELD_TOPIC_LISTENER} listens and ignores a kind it doesn't know`,
          "answered",
        ],
        [
          "Does anything else read the topic that the map can't show?",
          `\`${UNREAD_REPO}\``,
          "application-architect-naysayer",
          "ari",
          `${UNREAD_REPO} does, by its team's word; it is in the manifest and not read yet, so its task is in this change`,
          "answered",
        ],
      ],
    ),
    section("Developer", "The event is published after the refund's row is written.", [
      [
        "Where is a refund settled in the publisher?",
        `\`${NEW_PUBLISHER}\``,
        "developer-naysayer",
        "dev",
        "In its settlement entry; the publish goes after the write there",
        "answered",
      ],
    ]),
    section("QA", "A settled refund is heard once by each listener.", [
      [
        "What if the publish fails after the row is written?",
        "-",
        "qa-naysayer",
        "quinn",
        "The refund stays settled and the publish is tried again from the row",
        "answered",
      ],
    ]),
  ].join("\n"),
  counts: { questions: 4, answered: 4, accepted: 0, inMap: 3, planned: 0 },
  spec: "specs/settled-refunds/spec.md",
  repos: [NEW_PUBLISHER, UNREAD_REPO],
  files: {
    "proposal.md": proposal({
      why: "A refund settles and no other service hears of it.",
      what: [
        `${NEW_PUBLISHER} publishes each settled refund to ${TOPIC}.`,
        `${UNREAD_REPO} handles the refund kind on the topic it reads.`,
      ],
      capability: "settled-refunds",
      impact: `${NEW_PUBLISHER} gains a publish. ${FIELD_TOPIC_LISTENER} receives one more kind and ignores it. ${UNREAD_REPO} is in the manifest and not read, so the map can't check its use.`,
    }),
    "specs/settled-refunds/spec.md": delta([
      {
        name: "A settled refund is published",
        shall: `${NEW_PUBLISHER} SHALL publish each refund to ${TOPIC} once, after the refund's row is written as settled.`,
        scenarios: [
          [
            "A refund settles",
            [
              "- **GIVEN** a refund that is not settled",
              "- **WHEN** it settles",
              `- **THEN** one event of the refund kind is on ${TOPIC} with the refund's id`,
            ],
          ],
          [
            "The publish fails",
            [
              "- **GIVEN** a refund whose row is written as settled",
              "- **WHEN** the publish fails",
              "- **THEN** the refund stays settled and the publish is tried again from the row",
            ],
          ],
        ],
      },
    ]),
    "design.md": design({
      context: `${TOPIC} exists: ${FIELD_TOPIC_PUBLISHER} publishes to it and ${FIELD_TOPIC_LISTENER} listens.`,
      decisions: [
        `${NEW_PUBLISHER} publishes after its write, with a kind of its own on the event.`,
        `${FIELD_TOPIC_LISTENER} changes nothing: it ignores a kind it doesn't know.`,
        `${UNREAD_REPO} handles the new kind; its use of the topic is its team's word until it is read.`,
      ],
      rollout: `${UNREAD_REPO} is released first, so the kind is handled before it is sent. Rolling back stops the publish; events already sent are ignored by a listener rolled back.`,
      risks: `Nobody has read ${UNREAD_REPO}, so another listener in it would not be seen.`,
    }),
    // The publisher's repo is written first and waits for the listener's: the order to run them
    // in is (after …)'s, not the file's.
    "tasks.md": [
      `## ${NEW_PUBLISHER}`,
      "",
      "- [ ] e2 Publish a settled refund after its row is written (after e1)",
      "",
      `## ${UNREAD_REPO}`,
      "",
      "- [ ] e1 Handle the refund kind on the topic",
      "",
    ].join("\n"),
  },
};

export const ARCHETYPES = [NEW_PRODUCT, MIGRATION, NEW_EVENT] as const;

// ---------------------------------------------------------------------------------------------
// The staged path (ADR 0087): what the stages read, and what a mock assistant answers them.
// ---------------------------------------------------------------------------------------------

/** The quick path's hint, as ADR 0201 part 8 words it (`quickPathHint()` in the planner). */
export const QUICK_PATH_HINT =
  "If this change alters no runtime step in a repo the map holds (a new product, a move to another platform, pipeline or configuration work), it belongs on the quick path: write its requirements file and run atticus change new --from <requirements.md>.";

/**
 * The publisher's one flow in specs/: a refund is settled. Its entry, table and the lines it
 * cites are the estate's own (big-estate.ts's third entry of the second service).
 */
export const SETTLE_FLOW = { repo: NEW_PUBLISHER, id: `${NEW_PUBLISHER}.settle-refund` };
export const SETTLE_FLOW_YAML = `schemaVersion: 1
kind: Flow
id: ${SETTLE_FLOW.id}
status: current
confidence: inferred
component: ${NEW_PUBLISHER}
errors: []
evidence: []
family: []
name: A refund is settled
steps:
  - kind: entry
    what: PaymentController receives the refund to settle
    refs: [${NEW_PUBLISHER}.put-refund-2]
    data: { reads: [batokbaKeltokren, rentokbaKeltokren] }
    evidence:
      - { source: code, repo: ${NEW_PUBLISHER}, path: src/main/java/forge/web/PaymentController0.java, line: 1 }
  - kind: read
    what: The payment the refund is for is read
    refs: [${NEW_PUBLISHER}-db.payment_2]
    store: { table: ${NEW_PUBLISHER}-db.payment_2, columns: [id, status] }
    evidence:
      - { source: code, repo: ${NEW_PUBLISHER}, path: src/main/java/forge/data/Repo0.java, line: 3 }
  - kind: respond
    what: 200 with the refund's status
    refs: []
    data: { returns: [tokrenbaKeltokren] }
    evidence:
      - { source: code, repo: ${NEW_PUBLISHER}, path: src/main/java/forge/web/PaymentController0.java, line: 4 }
template: default@1
trigger:
  kind: endpoint
  ref: ${NEW_PUBLISHER}.put-refund-2
  what: A client settles a refund
  evidence:
    - { source: code, repo: ${NEW_PUBLISHER}, path: src/main/java/forge/web/PaymentController0.java, line: 1 }
`;

/** The new event on the staged path: the brief, and the assistant's answer to each stage. */
export const STAGED_EVENT = {
  id: "publish-settled-refunds-staged",
  title: "Publish settled refunds",
  brief: `# Publish settled refunds\n\nRefunds settle in ${NEW_PUBLISHER} and nothing says so. Publish each settled refund to the topic ${TOPIC}, which ${FIELD_TOPIC_LISTENER} listens to and ${UNREAD_REPO} reads.\n`,
  /** Who the answers name as consumers: the listener the map has, and the repo nobody read. */
  consumers: [FIELD_TOPIC_LISTENER, UNREAD_REPO],
  feature: `summary: Each settled refund is published to the topic the estate has.
features: []
flows:
  - { id: ${SETTLE_FLOW.id}, how: changed, why: The publish goes after the refund is settled. }
`,
  architecture: `flows:
  - flow: ${SETTLE_FLOW.id}
    repo: ${NEW_PUBLISHER}
    change: modify
    why: A settled refund is published.
    consumers: [${FIELD_TOPIC_LISTENER}, ${UNREAD_REPO}]
    steps:
      - op: add
        after: 2
        kind: publish
        what: The settled refund is published to ${TOPIC}
        new: src/main/java/forge/web/RefundEvents.java
        to: { component: ${FIELD_TOPIC_LISTENER}, entry: ${TOPIC} }
        fields: { sends: [batokbaKeltokren] }
`,
  stories: `stories:
  - id: s1-settle-refund
    title: Publish each settled refund
    asA: ledger operator
    iWant: every settled refund published to ${TOPIC}
    soThat: who listens there hears of refunds
    interfaces:
      - entry: ${TOPIC}
        change: changed
        breaking: false
        why: One more publisher of the topic.
        consumers: [${FIELD_TOPIC_LISTENER}, ${UNREAD_REPO}]
        fields:
          - { name: batokbaKeltokren, side: request, type: string, required: true, change: added }
    tasks:
      - id: "1.1"
        criteria:
          - text: "Given a refund that settles, when PUT /v1/transfers/{id}/refund-2 is called, then batokbaKeltokren is published to ${TOPIC}"
            checks: [batokbaKeltokren]
`,
};

const given = (repo: string, then: string) =>
  `      - repo: ${repo}\n        criteria:\n          - "Given ${repo} as it is today, when the operation is done, then ${then}"\n`;

/**
 * The new product on the staged path (ADR 0203 B): no flow yet, a pipeline and a deployment in
 * two repos the change plans, and the desk system outside the map that will link to it.
 */
export const OUTSIDE_PARTY = "northwind-desk";
export const STAGED_PRODUCT = {
  id: "approvals-portal-staged",
  title: "Approvals portal",
  brief:
    "# Approvals portal\n\nBranch managers approve refunds over the desk limit on one page, in a service and pages of their own. No existing service changes. The branch desk system links to the page.\n",
  feature: `summary: A new approvals portal in two repos of its own; this change gives them their pipelines and first deployment.
features: []
flows: []
operations:
  - kind: pipeline
    repos: [${PORTAL_API}, ${PORTAL_WEB}]
    newRepo: true
    what: Give each new repo its build and release pipeline.
    why: Nothing builds the portal yet.
  - kind: deployment
    repos: [${PORTAL_API}, ${PORTAL_WEB}]
    newRepo: true
    what: Deploy the portal's service and pages on Anvil.
    why: The portal runs beside the services it will call.
outside:
  - { id: ${OUTSIDE_PARTY}, what: The branch desk system, why: Its menu links to the portal's host. }
`,
  architecture: `flows: []
operations:
  - id: pipelines
    kind: pipeline
    repos: [${PORTAL_API}, ${PORTAL_WEB}]
    what: Give the repo its build and release pipeline.
  - id: deploy-portal
    kind: deployment
    repos: [${PORTAL_API}, ${PORTAL_WEB}]
    what: Deploy the portal on Anvil.
    sets: { platform: anvil, env: prod }
    after: [pipelines]
`,
  stories: `stories: []
operations:
  - id: pipelines
    title: Build and release the portal
    asA: portal developer
    iWant: each portal repo built and released by a pipeline
    soThat: a merge reaches Anvil without hand work
    tasks:
${given(PORTAL_API, "its pipeline file builds, tests and publishes the service")}${given(PORTAL_WEB, "its pipeline file builds, tests and publishes the pages")}  - id: deploy-portal
    title: Run the portal on Anvil
    asA: branch manager
    iWant: the approvals portal running on Anvil
    soThat: the page that lists what waits for me is there
    tasks:
${given(PORTAL_API, "a prod deployment on anvil is in its deploy files")}${given(PORTAL_WEB, "a prod deployment on anvil is in its deploy files")}`,
};

/**
 * The migration on the staged path (ADR 0203 B): three services in two waves, no flow delta at
 * all, a deployment and a cut-over with its undo.
 */
export const STAGED_MIGRATION = {
  id: "move-to-anvil-staged",
  title: "Move three services to the Anvil platform",
  brief:
    "# Move three services to the Anvil platform\n\nThree services move to the Anvil platform as they are, two first and the one that calls them after. No entry, call or table changes.\n",
  feature: `summary: Three services move to the Anvil platform in two waves; no runtime step changes.
features: []
flows: []
operations:
  - kind: deployment
    repos: [${MOVED.join(", ")}]
    what: Deploy each service on Anvil beside its hosts.
    why: The hosts are retired at the end of the quarter.
  - kind: cut-over
    repos: [${MOVED.join(", ")}]
    what: Move each service's traffic to Anvil.
    why: The old hosts go once nothing calls them.
`,
  architecture: `flows: []
waves:
  - { repos: [${MOVED[0]}, ${MOVED[1]}], why: The third calls both. }
  - { repos: [${MOVED[2]}] }
operations:
  - id: deploy-anvil
    kind: deployment
    repos: [${MOVED.join(", ")}]
    what: Deploy the service on Anvil beside its hosts.
    today: [${MOVED.join(", ")}]
    sets: { platform: anvil, env: prod }
  - id: switch
    kind: cut-over
    repos: [${MOVED.join(", ")}]
    what: Move the service's traffic to Anvil.
    after: [deploy-anvil]
    undo: Point the traffic back at the hosts, which stay up for one release.
`,
  stories: `stories: []
operations:
  - id: deploy-anvil
    title: Run each service on Anvil
    asA: platform engineer
    iWant: each service deployed on Anvil beside its hosts
    soThat: traffic can move without a gap
    tasks:
${MOVED.map((r) => given(r, "a prod deployment on anvil is in its deploy files")).join("")}  - id: switch
    title: Move the traffic to Anvil
    asA: platform engineer
    iWant: each service's traffic moved to Anvil
    soThat: the old hosts can be retired
    tasks:
${MOVED.map((r) => given(r, "its traffic is answered from Anvil, and pointing it back was tried")).join("")}`,
};

/** A change with neither a flow nor an operation: the feature stage's assistant places nothing. */
export const STAGED_NOTHING = {
  id: "tidy-the-wiki-staged",
  title: "Tidy the wiki",
  brief:
    "# Tidy the wiki\n\nThe team's wiki pages are put in order. No service, pipeline or setting changes.\n",
  feature: "summary: The wiki's pages are put in order.\nfeatures: []\nflows: []\n",
};

/** The same on the fast path: it reads a flow, changes no step and has no operation. */
export const STAGED_NO_STEP = {
  id: "reword-the-runbook-staged",
  title: "Reword the runbook",
  brief:
    "# Reword the runbook\n\nThe refund runbook is reworded. No entry, call, table, pipeline or setting changes.\n",
  small: `summary: The refund runbook is reworded; no step changes.
features: []
flows:
  - { id: ${SETTLE_FLOW.id}, how: read, why: The runbook describes it. }
targetFlows: []
stories: []
`,
};
