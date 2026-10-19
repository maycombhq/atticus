// Screenshot every screen of a running app: node e2e/shots.mjs <base-url> <out-dir> [width] [height]
// The base URL is what `atticus ui` printed (the token is in the page). Reports console errors
// and failed API calls per screen as JSON lines, so a fix pass can start from the list.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [, , base, out, w, h] = process.argv;
const SCREENS = [
  "home",
  "explore",
  "map",
  "impact?q=ledger-api",
  "features",
  "orgpack",
  "intake",
  "scans",
  "brief",
  "ux",
  "arch-review",
  "diagrams",
  "reconcile",
  "contracts",
  "mappings",
  "breakdown",
  "initiatives",
  "changes",
  "changes?across=findings",
  "changes?across=tasks",
  "changes?across=releases",
  "tasks",
  "trace",
  "todo",
  "release",
  "service-desk",
  "governance",
  "evals",
  "learning",
  "settings",
];
await mkdir(out, { recursive: true });
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: Number(w || 1440), height: Number(h || 900) } });
let errors = [];
p.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
p.on("pageerror", (e) => errors.push(String(e)));
p.on("response", (r) => {
  if (r.url().includes("/api/") && r.status() >= 400)
    errors.push(`${r.status()} ${r.url().replace(base, "")}`);
});
await p.goto(base, { waitUntil: "networkidle" });
for (const s of SCREENS) {
  errors = [];
  await p.evaluate((h) => (globalThis.location.hash = h), `#/${s}`);
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(700);
  const name = s.replace(/[?=]/g, "_");
  await p.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  console.log(JSON.stringify({ screen: s, errors }));
}
await b.close();
