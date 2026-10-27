// The site's pages are the repo's own Markdown: this checks what the copy keeps and what it
// rewrites, on a small invented repo in a temporary folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { escapeForVue, guideOrder, publishedPages, rewriteLinks, sourceOf, sync } from "./sync.mjs";

const repo = mkdtempSync(join(tmpdir(), "atticus-site-repo-"));
const site = mkdtempSync(join(tmpdir(), "atticus-site-out-"));
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
});

const write = (p, text) => {
  mkdirSync(join(repo, p, ".."), { recursive: true });
  writeFileSync(join(repo, p), text);
};
write("README.md", "# Forge\n\n[Install](docs/guide/install.md) and [the licence](LICENSE).\n");
write(
  "docs/guide/README.md",
  "# Guides\n\n- [Installing](install.md): from minute 0, with `atticus doctor`.\n- [Commands](commands.md): every command.\n",
);
write(
  "docs/guide/install.md",
  "# Installing Forge\n\nSee [commands](commands.md#the-twelve), [ADR 0006](../adr/0006-x.md), [the ADRs](../adr) and [above](#minute-0).\n\n```md\n[not a link](../adr/0006-x.md)\n```\n",
);
write("docs/guide/commands.md", "# Command reference\n");
write("docs/guide/zeta.md", "# A guide the index doesn't list\n");
write("docs/adr/0006-x.md", "# An ADR\n");
write("LICENSE", "Apache-2.0\n");

test("publishes the README, the guide index and every guide", () => {
  assert.deepEqual(publishedPages(repo), {
    "README.md": "overview.md",
    "docs/guide/README.md": "guide/index.md",
    "docs/guide/commands.md": "guide/commands.md",
    "docs/guide/install.md": "guide/install.md",
    "docs/guide/zeta.md": "guide/zeta.md",
  });
});

test("links to published pages stay relative; the rest go to GitHub", () => {
  sync(repo, site);
  const install = readFileSync(join(site, "guide/install.md"), "utf8");
  assert.match(install, /\[commands\]\(\.\/commands\.md#the-twelve\)/);
  assert.match(
    install,
    /\[ADR 0006\]\(https:\/\/github\.com\/maycombhq\/atticus\/blob\/main\/docs\/adr\/0006-x\.md\)/,
  );
  assert.match(
    install,
    /\[the ADRs\]\(https:\/\/github\.com\/maycombhq\/atticus\/tree\/main\/docs\/adr\)/,
  );
  assert.match(install, /\[above\]\(#minute-0\)/);
  assert.match(install, /\[not a link\]\(\.\.\/adr\/0006-x\.md\)/, "fenced code is left alone");
  assert.match(install, /Copied from docs\/guide\/install\.md/);

  const overview = readFileSync(join(site, "overview.md"), "utf8");
  assert.match(overview, /\[Install\]\(\.\/guide\/install\.md\)/);
  assert.match(
    overview,
    /\[the licence\]\(https:\/\/github\.com\/maycombhq\/atticus\/blob\/main\/LICENSE\)/,
  );
  assert.ok(existsSync(join(site, "guide/index.md")));
});

test("a guide removed from the repo leaves the site on the next sync", () => {
  rmSync(join(repo, "docs/guide/zeta.md"));
  sync(repo, site);
  assert.ok(!existsSync(join(site, "guide/zeta.md")));
  write("docs/guide/zeta.md", "# A guide the index doesn't list\n");
});

test("guides follow the index's order and words, then the ones it doesn't list", () => {
  assert.deepEqual(guideOrder(repo), [
    { text: "Installing", link: "/guide/install", desc: "from minute 0, with `atticus doctor`." },
    { text: "Commands", link: "/guide/commands", desc: "every command." },
    { text: "A guide the index doesn't list", link: "/guide/zeta", desc: "" },
  ]);
});

test("each page names the repo file it came from", () => {
  assert.equal(sourceOf("guide/install.md", repo), "docs/guide/install.md");
  assert.equal(sourceOf("overview.md", repo), "README.md");
  assert.equal(sourceOf("concepts.md", repo), "website/concepts.md");
});

test("placeholders and braces in prose are escaped for Vue; code and real HTML are not", () => {
  const text = [
    'The Next view says "in VS Code: <model> for <kind> steps", with ${{ secrets.X }}.',
    "Keep `atticus map <repo>`, <kbd>Ctrl</kbd> and <https://example.com>.",
    "   ```yaml",
    "   key: <value>",
    "   ```",
  ].join("\n");
  assert.equal(
    escapeForVue(text),
    [
      'The Next view says "in VS Code: &lt;model&gt; for &lt;kind&gt; steps", with $&#123;&#123; secrets.X }}.',
      "Keep `atticus map <repo>`, <kbd>Ctrl</kbd> and <https://example.com>.",
      "   ```yaml",
      "   key: <value>",
      "   ```",
    ].join("\n"),
  );
});

test("rewriteLinks leaves absolute links alone", () => {
  const pages = publishedPages(repo);
  const text = "[OpenSpec](https://github.com/Fission-AI/openspec)";
  assert.equal(rewriteLinks(text, "README.md", pages), text);
});
