// The site's guide pages are the repo's own Markdown, copied in at build time so that a change to
// a guide changes the site with no second edit. The words are kept as they are. Links are
// rewritten: a link to another published page stays a relative link, and a link to anything else
// in the repo (an ADR, the spec, the bench) goes to that file on GitHub, so the site never links
// to a page it doesn't have. And prose that Vue would read as a tag or an interpolation is escaped.
//
//   README.md               -> overview.md
//   docs/guide/README.md    -> guide/index.md
//   docs/guide/<name>.md    -> guide/<name>.md   (every guide, unless LEFT_OFF names it)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const SITE = fileURLToPath(new URL("..", import.meta.url));
export const GITHUB = "https://github.com/maycombhq/atticus";

/** Guides kept off the site, each with why. Empty: every guide is about the product. */
export const LEFT_OFF = {};

/** Repo path -> site path, for every page the site publishes from the repo. */
export function publishedPages(repo = REPO) {
  const pages = { "README.md": "overview.md", "docs/guide/README.md": "guide/index.md" };
  for (const f of readdirSync(join(repo, "docs/guide")).sort()) {
    if (!f.endsWith(".md") || f === "README.md" || f in LEFT_OFF) continue;
    pages[`docs/guide/${f}`] = `guide/${f}`;
  }
  return pages;
}

/** The link from one site page to another, relative, as VitePress wants it (with .md). */
function relativeLink(fromSite, toSite) {
  const rel = posix.relative(posix.dirname(fromSite), toSite);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrites the Markdown links of one repo file for the site. `isDir` says whether a repo path is
 * a folder (GitHub's tree view) or a file (its blob view).
 */
export function rewriteLinks(text, fromRepo, pages, isDir = () => false) {
  const fromSite = pages[fromRepo];
  // Fenced code is left alone: a "](" inside it is code, not a link.
  return text
    .split(FENCE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\]\(([^)\s#]*)(#[^)\s]*)?\)/g, (whole, target, hash = "") => {
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole; // https:, mailto:
            if (target === "") return whole; // an anchor on the same page
            const repoPath = posix
              .normalize(posix.join(posix.dirname(fromRepo), target))
              .replace(/\/$/, "");
            const page = pages[repoPath];
            if (page) return `](${relativeLink(fromSite, page)}${hash})`;
            const view = isDir(repoPath) ? "tree" : "blob";
            return `](${GITHUB}/${view}/main/${repoPath}${hash})`;
          }),
    )
    .join("");
}

// A fenced code block, indented or not (a fence inside a list item is indented).
const FENCE = /(^[ \t]*```[\s\S]*?^[ \t]*```)/m;

// HTML a guide may really mean; any other <word> in prose is a placeholder such as <repo>.
const HTML = new Set([
  "a",
  "b",
  "br",
  "code",
  "details",
  "em",
  "i",
  "img",
  "kbd",
  "strong",
  "sub",
  "summary",
  "sup",
]);

/**
 * VitePress compiles each page as a Vue template, so prose that reads as a tag (`<model>`) or an
 * interpolation (`{{ x }}`) breaks the build or vanishes. Outside fenced and inline code, both are
 * escaped; they render exactly as written.
 */
export function escapeForVue(text) {
  return text
    .split(FENCE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(/(`+[^`]*`+)/)
            .map((bit, j) =>
              j % 2 === 1
                ? bit
                : bit
                    .replace(/<(\/?)([A-Za-z][^>\s]*)([^>]*)>/g, (whole, slash, name, rest) =>
                      HTML.has(name.toLowerCase()) || /[:@]/.test(name)
                        ? whole
                        : `&lt;${slash}${name}${rest}&gt;`,
                    )
                    .replace(/\{\{/g, "&#123;&#123;"),
            )
            .join(""),
    )
    .join("");
}

/** Copies every published page into the site, links rewritten. Returns the pages written. */
export function sync(repo = REPO, site = SITE) {
  const pages = publishedPages(repo);
  rmSync(join(site, "guide"), { recursive: true, force: true });
  const isDir = (p) => existsSync(join(repo, p)) && statSync(join(repo, p)).isDirectory();
  for (const [from, to] of Object.entries(pages)) {
    const out = join(site, to);
    mkdirSync(dirname(out), { recursive: true });
    const note = `<!-- Copied from ${from} by website/.vitepress/sync.mjs: edit that file, not this one. -->\n\n`;
    const text = readFileSync(join(repo, from), "utf8");
    writeFileSync(out, note + escapeForVue(rewriteLinks(text, from, pages, isDir)));
  }
  return pages;
}

/** The guides in the order the guide index lists them, then any it doesn't list. */
export function guideOrder(repo = REPO) {
  const pages = publishedPages(repo);
  const index = readFileSync(join(repo, "docs/guide/README.md"), "utf8");
  const said = {};
  for (const m of index.matchAll(/^- \[([^\]]+)\]\(([a-z0-9-]+\.md)\)(?::\s*(.+))?$/gm))
    said[`docs/guide/${m[2]}`] = { title: m[1], desc: m[3]?.trim() ?? "" };
  const all = Object.keys(pages).filter(
    (p) => p.startsWith("docs/guide/") && !p.endsWith("README.md"),
  );
  const ordered = [...new Set([...Object.keys(said).filter((p) => pages[p]), ...all])];
  return ordered.map((p) => {
    const h1 = /^# (.+)$/m.exec(readFileSync(join(repo, p), "utf8"));
    return {
      text: said[p]?.title ?? (h1 ? h1[1].trim() : p),
      link: `/${pages[p].replace(/\.md$/, "")}`,
      desc: said[p]?.desc ?? "",
    };
  });
}

/** The repo file a site page came from, for "Edit this page". */
export function sourceOf(sitePath, repo = REPO) {
  const pages = publishedPages(repo);
  return Object.keys(pages).find((k) => pages[k] === sitePath) ?? `website/${sitePath}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = sync();
  console.log(`Synced ${Object.keys(pages).length} pages into website/.`);
}
