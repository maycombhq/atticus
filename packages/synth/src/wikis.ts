import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A synthetic estate of many wikis (ADR 0130), for the scale budgets and the matching bench: the
 * invented Forge shop's 12 knowledge sources (fixtures/many-wikis: two standards, two platforms,
 * two frameworks, five teams and one reference), each with its hand-written planted pages and
 * thousands of generated filler pages. Deterministic: the same options always write the same
 * files, so a timing or a precision is comparable run to run. A generator, not a checked-in blob.
 *
 * The filler is ordinary wiki noise: how-tos, notes, FAQs and decisions about everything an
 * organisation writes down, a share of it about refunds, orders, timeouts, events and logging (the
 * words the bench's tasks use), so the matching has realistic distractors. A small share of pages
 * is mirrored from the Enterprise Architecture space into a team's wiki, as people copy pages.
 * The Enterprise Architecture source is a Confluence space export (HTML with breadcrumbs, the
 * metadata line and labels) and the payments team's a SharePoint export (pages and metadata.csv).
 */

/** One source of the estate: its id, how its pages are written, and how many filler pages. */
export interface WikiSpec {
  id: string;
  format: "markdown" | "confluence-export" | "sharepoint-export";
  pages: number;
  owner: string;
  /** Folders its pages sit in. */
  folders: string[];
  /** The kind of page it mostly holds. */
  voice: "standard" | "platform" | "framework" | "team" | "reference";
}

/** The 12 sources and their filler at scale 1: 4,800 pages beside the planted ones. */
export const MANY_WIKIS: WikiSpec[] = [
  {
    id: "ea-standards",
    format: "confluence-export",
    pages: 700,
    owner: "Enterprise Architecture",
    folders: ["Standards", "Principles", "Drafts", "Meeting notes", "Reference architectures"],
    voice: "standard",
  },
  {
    id: "security-standards",
    format: "markdown",
    pages: 300,
    owner: "Security Architecture",
    folders: ["access", "crypto", "data", "tls", "incident"],
    voice: "standard",
  },
  {
    id: "gcp-platform",
    format: "markdown",
    pages: 450,
    owner: "Cloud Platform team",
    folders: ["run", "gke", "pubsub", "iam", "networking", "billing"],
    voice: "platform",
  },
  {
    id: "openshift-platform",
    format: "markdown",
    pages: 450,
    owner: "OpenShift Platform team",
    folders: ["routes", "deploy", "quotas", "secrets", "monitoring"],
    voice: "platform",
  },
  {
    id: "anvil-framework",
    format: "markdown",
    pages: 300,
    owner: "Anvil maintainers",
    folders: ["rest", "events", "data", "config", "testing"],
    voice: "framework",
  },
  {
    id: "web-framework",
    format: "markdown",
    pages: 300,
    owner: "Web Platform guild",
    folders: ["forms", "components", "routing", "state", "testing"],
    voice: "framework",
  },
  {
    id: "orders-team",
    format: "markdown",
    pages: 400,
    owner: "Orders team",
    folders: ["events", "runbooks", "api", "notes", "retros"],
    voice: "team",
  },
  {
    id: "payments-team",
    format: "sharepoint-export",
    pages: 300,
    owner: "Payments team",
    folders: ["SitePages", "SitePages/Runbooks", "SitePages/Notes"],
    voice: "team",
  },
  {
    id: "stock-team",
    format: "markdown",
    pages: 350,
    owner: "Stock team",
    folders: ["warehouse", "runbooks", "notes", "retros"],
    voice: "team",
  },
  {
    id: "web-team",
    format: "markdown",
    pages: 350,
    owner: "Web team",
    folders: ["pages", "notes", "retros", "copied"],
    voice: "team",
  },
  {
    id: "identity-team",
    format: "markdown",
    pages: 300,
    owner: "Identity team",
    folders: ["how-to", "notes", "tokens", "retros"],
    voice: "team",
  },
  {
    id: "glossary-reference",
    format: "markdown",
    pages: 600,
    owner: "Data Governance",
    folders: ["terms", "acronyms", "domains"],
    voice: "reference",
  },
];

/** A seeded generator (mulberry32): the same seed, the same numbers. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
  };
}

const SUBJECTS = [
  "badge printer",
  "cost report",
  "on-call rota",
  "incident review",
  "data retention",
  "backup",
  "DNS record",
  "VPN profile",
  "laptop image",
  "release train",
  "sprint review",
  "code review",
  "branch policy",
  "dependency update",
  "vulnerability scan",
  "container image",
  "service mesh",
  "quota",
  "budget alert",
  "resource tag",
  "SLO",
  "rollback",
  "canary release",
  "schema registry",
  "message queue",
  "cron job",
  "monthly report",
  "data export",
  "bulk import",
  "search index",
  "translation file",
  "accessibility audit",
  "font licence",
  "colour palette",
  "email template",
  "notification",
  "consent record",
  "customer profile",
  "postal address",
  "currency table",
  "tax rate",
  "receipt",
  "discount code",
  "voucher",
  "basket",
  "checkout page",
  "stock level",
  "warehouse slot",
  "delivery window",
  "courier label",
  "return label",
  "order history",
  "payment method",
  "card token",
  "chargeback",
  "fraud score",
  "secret rotation",
  "certificate",
  "feature flag",
  "load test",
  "load balancer",
  "cache",
  "dashboard",
  "log retention",
  "trace sampling",
  "alert rule",
  "runbook index",
  "test environment",
  "build agent",
  "artifact store",
  "API key",
  "service account",
  "firewall rule",
  "network policy",
  "storage bucket",
  "database replica",
  "read replica",
  "connection pool",
  "thread pool",
  "batch window",
  "report scheduler",
  "PDF export",
  "spreadsheet upload",
  "audit log",
  "access review",
  "joiner process",
  "leaver process",
  "team charter",
  "architecture diagram",
  "design review",
  "pairing guide",
  "onboarding checklist",
  // A share about what the bench's tasks touch: the realistic near misses.
  "refund report",
  "refund reconciliation",
  "order export",
  "order archive",
  "event catalogue",
  "event replay",
  "log shipping",
  "request timeout dashboard",
  "status page",
  "error budget",
  "form builder",
  "payment reconciliation",
  "idempotency dashboard",
  "migration window",
];

const TEAMS = [
  "Platform team",
  "Data team",
  "Service desk",
  "Finance",
  "Security team",
  "Web team",
  "Orders team",
  "Stock team",
];
const VERBS = [
  "request",
  "rotate",
  "review",
  "update",
  "retire",
  "set up",
  "move",
  "check",
  "approve",
  "archive",
];
const ADJ = [
  "shared",
  "owned",
  "reviewed",
  "monitored",
  "tagged",
  "versioned",
  "documented",
  "audited",
];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** One filler page's words: a title, and two to four sections of sentences or list items. */
function fillerPage(r: ReturnType<typeof rng>, spec: WikiSpec, n: number) {
  const subject = r.pick(SUBJECTS);
  const other = r.pick(SUBJECTS);
  const team = r.pick(TEAMS);
  const titles = {
    standard: [`${cap(subject)} standard`, `Using ${subject}s`, `${cap(subject)} principles`],
    platform: [
      `${cap(subject)} on the platform`,
      `How to ${r.pick(VERBS)} a ${subject}`,
      `${cap(subject)} limits`,
    ],
    framework: [
      `${cap(subject)} with the framework`,
      `Testing a ${subject}`,
      `${cap(subject)} recipes`,
    ],
    team: [
      `Notes on the ${subject}`,
      `How we ${r.pick(VERBS)} the ${subject}`,
      `${cap(subject)} FAQ`,
      `Retro: the ${subject}`,
    ],
    reference: [cap(subject), `${cap(subject)} (term)`, `What a ${subject} is`],
  }[spec.voice];
  const title = `${r.pick(titles)} ${n % 7 === 0 ? `(${2023 + (n % 4)})` : ""}`.trim();
  const sentences = () => {
    const out: string[] = [];
    for (let k = 0; k < 2 + r.int(4); k++)
      out.push(
        r.pick([
          `The ${subject} is ${r.pick(ADJ)} by the ${team}.`,
          `Ask the ${team} before you ${r.pick(VERBS)} a ${subject}.`,
          `Every ${subject} has an owner and a review date.`,
          `A ${subject} that links to a ${other} is checked once a quarter.`,
          `Keep the ${subject} in the shared space, never in a personal folder.`,
          `The ${other} replaced the old ${subject} process in ${2022 + r.int(4)}.`,
          `When the ${subject} changes, tell the ${team} in the channel.`,
          `The ${subject} for ${r.pick(["test", "staging", "production"])} is set up by a request.`,
        ]),
      );
    return out;
  };
  const headings = [
    "Overview",
    "How it works",
    "Steps",
    "Who to ask",
    "Known issues",
    "History",
    "Details",
  ];
  const sections: { heading: string; list: boolean; lines: string[] }[] = [];
  for (let k = 0; k < 2 + r.int(3); k++)
    sections.push({
      heading: headings[(n + k) % headings.length]!,
      list: r.next() < 0.5,
      lines: sentences(),
    });
  const y = 2023 + r.int(4);
  const m = 1 + r.int(12);
  const d = 1 + r.int(28);
  const updated = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { title, sections, updated, owner: spec.owner };
}

type Page = ReturnType<typeof fillerPage>;

const segment = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";

const markdown = (p: Page) =>
  `---\ntitle: ${JSON.stringify(p.title)}\nowner: ${p.owner}\nupdated: ${p.updated}\n---\n# ${p.title}\n\n${p.sections
    .map(
      (s) =>
        `## ${s.heading}\n\n${s.list ? s.lines.map((l) => `- ${l}`).join("\n") : s.lines.join(" ")}`,
    )
    .join("\n\n")}\n`;

const htmlBody = (p: Page) =>
  p.sections
    .map(
      (s) =>
        `<h2>${s.heading}</h2>\n${s.list ? `<ul>\n${s.lines.map((l) => `<li>${l}</li>`).join("\n")}\n</ul>` : `<p>${s.lines.join(" ")}</p>`}`,
    )
    .join("\n");

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const confluenceDate = (iso: string) =>
  `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(8, 10)}, ${iso.slice(0, 4)}`;

function confluenceHtml(space: string, p: Page, parents: string[]): string {
  return `<!DOCTYPE html>
<html>
    <head>
        <title>${space} : ${p.title}</title>
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    </head>
    <body class="theme-default aui-theme-default">
        <div id="page">
            <div id="main" class="aui-page-panel">
                <div id="main-header">
                    <div id="breadcrumb-section">
                        <ol id="breadcrumbs">
                            <li class="first"><span><a href="index.html">${space}</a></span></li>
${parents.map((t) => `                            <li><span><a href="${segment(t)}.html">${t}</a></span></li>`).join("\n")}
                        </ol>
                    </div>
                    <h1 id="title-heading" class="pagetitle"><span id="title-text">${space} : ${p.title}</span></h1>
                </div>
                <div id="content" class="view">
                    <div class="page-metadata">
                        Created by <span class='author'> ${p.owner}</span>, last modified on ${confluenceDate(p.updated)}
                    </div>
                    <div id="main-content" class="wiki-content group">
${htmlBody(p)}
                    </div>
                </div>
            </div>
        </div>
    </body>
</html>
`;
}

const sharepointHtml = (p: Page) =>
  `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${p.title}</title>\n</head>\n<body>\n<div class="ms-rtestate-field">\n<h1>${p.title}</h1>\n${htmlBody(p)}\n</div>\n</body>\n</html>\n`;

export interface WikiEstateOptions {
  /** The fixtures folder (the repo's fixtures/): many-wikis is read from it. */
  fixtures: string;
  /** Filler pages per source at this multiple of MANY_WIKIS' counts; 0 writes the planted only. */
  scale?: number;
  /** One in this many Enterprise Architecture filler pages is mirrored into the web team's wiki. */
  mirrorEvery?: number;
  seed?: number;
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b);
    else await copyFile(a, b);
  }
}

/**
 * Write the estate into `root`: org-pack (sources.yaml and the repos manifest), the catalog's
 * records file (catalog.yaml, for the caller to write as records), the facts, and every source
 * under wikis/<id>/, planted pages and filler. Returns how many pages each source got.
 */
export async function writeWikiEstate(
  root: string,
  o: WikiEstateOptions,
): Promise<{ pages: Record<string, number>; mirrored: number }> {
  const fx = join(o.fixtures, "many-wikis");
  await copyTree(join(fx, "org-pack"), join(root, "org-pack"));
  await copyTree(join(fx, "facts"), join(root, "facts"));
  await copyTree(join(fx, "sources"), join(root, "wikis"));
  const r = rng(o.seed ?? 130);
  const scale = o.scale ?? 1;
  const mirrorEvery = o.mirrorEvery ?? 50;
  const pages: Record<string, number> = {};
  let mirrored = 0;
  const csv: string[] = [];
  const put = async (p: string, text: string) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  };
  for (const spec of MANY_WIKIS) {
    const n = Math.round(spec.pages * scale);
    pages[spec.id] = n;
    const dir = join(root, "wikis", spec.id);
    for (let k = 0; k < n; k++) {
      const p = fillerPage(r, spec, k);
      const folder = spec.folders[k % spec.folders.length]!;
      const name = `${segment(p.title)}-${k}`;
      if (spec.format === "confluence-export") {
        p.title = `${p.title} ${k}`;
        await put(
          join(dir, "EA", `${segment(p.title)}_${700000 + k}.html`),
          confluenceHtml("Enterprise Architecture", p, [folder]),
        );
        if (k % mirrorEvery === 3) {
          // A team copies the page into its own wiki, words and all.
          await put(
            join(root, "wikis", "web-team", "copied", `${segment(p.title)}.md`),
            markdown({ ...p, owner: "Web team" }),
          );
          mirrored++;
        }
      } else if (spec.format === "sharepoint-export") {
        const file = `${folder}/${name}.html`;
        await put(join(dir, ...file.split("/")), sharepointHtml(p));
        csv.push(
          `${name}.html,${JSON.stringify(p.title)},${p.updated}T09:00:00Z,${p.owner},${file},,Published,FALSE`,
        );
      } else await put(join(dir, folder, `${name}.md`), markdown(p));
    }
  }
  if (csv.length) {
    const { readFile } = await import("node:fs/promises");
    const meta = join(root, "wikis", "payments-team", "metadata.csv");
    await writeFile(meta, `${(await readFile(meta, "utf8")).trimEnd()}\n${csv.join("\n")}\n`);
  }
  return { pages, mirrored };
}
