import { chromium } from "@playwright/test";
const [, , url, out, w, h] = process.argv;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: Number(w || 1440), height: Number(h || 1000) } });
const errors = [];
p.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(800);
await p.screenshot({ path: out, fullPage: true });
console.log(JSON.stringify({ errors }));
await b.close();
