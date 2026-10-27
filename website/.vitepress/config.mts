import { watch } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitepress";
import { GITHUB, REPO, guideOrder, sync } from "./sync.mjs";

// The guides are the repo's own Markdown (docs/guide, the README), copied in on every start and
// build; while the dev server runs, a change to one is copied again.
sync();
if (process.argv.includes("dev")) {
  for (const dir of [join(REPO, "docs/guide"), REPO])
    watch(dir, (_event, file) => {
      if (file && String(file).endsWith(".md")) sync();
    });
}

const guides = guideOrder();

export default defineConfig({
  base: "/atticus/",
  lang: "en",
  title: "Atticus",
  description:
    "Atticus reads your repos into facts that cite their file and line, checks every one, and runs each change from idea to tasks with a critic and a person's approval: spec-driven development across many repos, built on OpenSpec.",
  cleanUrls: false,
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/atticus/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#0e1820" }],
  ],
  markdown: {
    // The high-contrast pair keeps every token at 4.5:1 on the code background.
    theme: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
  },
  // The body face's two weights load first, so text doesn't reflow when they arrive.
  transformHead({ assets }) {
    return assets
      .filter((a) => /ibm-plex-sans-latin-(400|600)-normal.*\.woff2$/.test(a))
      .map((href) => [
        "link",
        { rel: "preload", href, as: "font", type: "font/woff2", crossorigin: "" },
      ]);
  },
  themeConfig: {
    logo: { light: "/glasses-light.svg", dark: "/glasses-dark.svg", alt: "" },
    siteTitle: "Atticus",
    nav: [
      { text: "What it is", link: "/concepts" },
      { text: "Install", link: "/guide/install" },
      { text: "Guides", link: "/guide/" },
      { text: "Commands", link: "/guide/commands" },
      { text: "MaycombHQ", link: "https://maycombhq.com/", target: "_self" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "What Atticus is", link: "/concepts" },
          { text: "Overview and measurements", link: "/overview" },
          { text: "All guides", link: "/guide/" },
        ],
      },
      {
        text: "Guides",
        items: guides
          .filter((g) => g.link !== "/guide/commands")
          .map(({ text, link }) => ({ text, link })),
      },
      {
        text: "Reference",
        items: [
          { text: "Command reference", link: "/guide/commands" },
          { text: "Decisions (ADRs) on GitHub", link: `${GITHUB}/tree/main/docs/adr` },
          { text: "Where Atticus stands", link: `${GITHUB}/blob/main/docs/build-status.md` },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: GITHUB, ariaLabel: "Atticus on GitHub" }],
    search: { provider: "local" },
    // The guide index (docs/guide/README.md), with each guide's one line, for the landing page.
    guideIndex: guides,
    outline: { level: [2, 3], label: "On this page" },
    editLink: {
      // VitePress sends this function to the browser on its own, so it can't use anything
      // imported: the mapping is sync.mjs's publishedPages, written out.
      pattern: ({ filePath }) => {
        const edit = "https://github.com/maycombhq/atticus/edit/main/";
        if (filePath === "overview.md") return `${edit}README.md`;
        if (filePath === "guide/index.md") return `${edit}docs/guide/README.md`;
        if (filePath.startsWith("guide/")) return `${edit}docs/${filePath}`;
        return `${edit}website/${filePath}`;
      },
      text: "Edit this page on GitHub",
    },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: `Atticus is open source under the <a href="${GITHUB}/blob/main/LICENSE">Apache 2.0 licence</a>.`,
      copyright: `A <a href="https://maycombhq.com/">MaycombHQ</a> project, made by <a href="https://www.linkedin.com/in/devtomgeorge" rel="author">Tom George</a>.`,
    },
  },
});
