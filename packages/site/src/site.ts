import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogRecord } from "@maycombhq/core";
import { systemGuide, type GuideChange } from "./guide.js";

/**
 * The read-only catalog site: plain static files a team can host anywhere behind its own
 * sign-in. Only systems whose access group is "everyone" appear; a restricted system is never
 * named, not even from an open system's page or the search file. No script runs on the pages
 * except the small search box, and every page sets a strict content security policy.
 */

type Rec = CatalogRecord & Record<string, unknown>;

export interface SiteOptions {
  title: string;
  builtAt: string;
  changes?: GuideChange[];
}

export interface SiteResult {
  systems: string[];
  hidden: string[];
  files: number;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown (the guide's small subset) to HTML, escaping every piece of catalog text. */
export function guideHtml(md: string): string {
  const out: string[] = [];
  let table: string[][] = [];
  let list: string[] = [];
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/_\(([^)]*)\)_/g, '<span class="src">($1)</span>');
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    list = [];
    if (table.length) {
      const [h, ...rows] = table;
      out.push(
        `<table><thead><tr>${h!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    }
    table = [];
  };
  for (const line of md.split("\n")) {
    if (line.startsWith("|")) {
      if (/^\|\s*-/.test(line)) continue;
      table.push(
        line
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, "|")),
      );
      continue;
    }
    if (table.length) flush();
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    } else if (line.startsWith("- ")) list.push(line.slice(2));
    else if (line.trim()) {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    } else flush();
  }
  flush();
  return out.join("\n");
}

const CSS = `body{margin:0;background:#06090d;color:#dfeaf0;font:15px/1.6 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px}a{color:#2ee6f6}
h1{font-size:26px;letter-spacing:.02em}h2{font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:#7ff4ff;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px 6px 0;border-top:1px solid #1a2330;vertical-align:top}
th{font-weight:400;color:#8fa3b3;font-size:11px;text-transform:uppercase;letter-spacing:.1em}
.src{color:#6f8394;font-size:12px}.card{border:1px solid #1a2330;border-radius:10px;padding:12px 14px;margin:8px 0}
input{width:100%;height:40px;background:#0b1016;color:#dfeaf0;border:1px solid #2ee6f6;border-radius:10px;padding:0 12px;font:inherit}
footer{color:#6f8394;font-size:12px;margin-top:40px}`;

const SEARCH_JS = `const box=document.getElementById("q"),res=document.getElementById("res");
fetch("search.json").then(r=>r.json()).then(items=>{box.addEventListener("input",()=>{
const t=box.value.toLowerCase().trim();res.textContent="";if(t.length<2)return;
for(const i of items.filter(x=>(x.id+" "+(x.name||"")).toLowerCase().includes(t)).slice(0,30)){
const li=document.createElement("li"),a=document.createElement("a");a.href=i.href;a.textContent=i.id+" · "+i.kind;li.append(a);res.append(li)}})});`;

function page(title: string, body: string, depth: number, script = false): string {
  const up = depth ? "../" : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'">
<title>${esc(title)}</title><link rel="stylesheet" href="${up}site.css"></head>
<body><main>${body}<footer>Read-only. Generated from the catalog; it changes nothing. Facts show where they came from.</footer></main>${script ? `<script src="${up}search.js"></script>` : ""}</body></html>
`;
}

export async function buildSite(
  records: readonly CatalogRecord[],
  dir: string,
  o: SiteOptions,
): Promise<SiteResult> {
  const all = records as Rec[];
  const systems = all.filter((r) => r.kind === "System").sort((a, b) => a.id.localeCompare(b.id));
  const open = systems.filter((s) => (s.accessGroup ?? "everyone") === "everyone");
  const openIds = new Set(open.map((s) => s.id));
  const visible = (sid: string) => openIds.has(sid);
  const compSys = new Map(
    all.filter((r) => r.kind === "Component").map((c) => [c.id, String(c.system)]),
  );
  const tableSys = new Map(
    all.filter((r) => r.kind === "Table").map((t) => [t.id, compSys.get(String(t.ownerComponent))]),
  );
  /** The system a record belongs to, for the search file; undefined leaves it out. */
  const systemOf = (r: Rec): string | undefined => {
    switch (r.kind) {
      case "System":
        return r.id;
      case "Component":
        return String(r.system);
      case "Endpoint":
      case "Deployment":
      case "Setting":
      case "ObservabilityAsset":
        return compSys.get(String(r.component));
      case "Table":
      case "DataStore":
        return compSys.get(String(r.ownerComponent));
      case "Column":
        return tableSys.get(String(r.table));
      case "Interface": {
        const a = compSys.get(String(r.from)) ?? String(r.from);
        const b = compSys.get(String(r.to)) ?? String(r.to);
        return visible(a) && visible(b) ? a : undefined;
      }
      default:
        return undefined;
    }
  };

  await mkdir(join(dir, "systems"), { recursive: true });
  await writeFile(join(dir, "site.css"), CSS);
  await writeFile(join(dir, "search.js"), SEARCH_JS);
  let files = 2;
  for (const s of open) {
    const g = systemGuide(records, s.id, {
      visible,
      ...(o.changes ? { changes: o.changes } : {}),
    });
    await writeFile(
      join(dir, "systems", `${s.id}.html`),
      page(
        `${g.name} · ${o.title}`,
        `<p><a href="../index.html">← ${esc(o.title)}</a></p>\n${guideHtml(g.markdown)}`,
        1,
      ),
    );
    files += 1;
  }
  const byBoundary = ["product", "internal", "vendor"].map((b) => ({
    b,
    list: open.filter((s) => s.boundary === b),
  }));
  const index = `<h1>${esc(o.title)}</h1>
<p>Built ${esc(o.builtAt)} · ${open.length} systems</p>
<label for="q">Search the catalog</label><input id="q" type="search" autocomplete="off"><ul id="res" aria-live="polite"></ul>
${byBoundary
  .filter((x) => x.list.length)
  .map(
    (x) =>
      `<h2>${esc(x.b)} systems</h2>${x.list
        .map(
          (s) =>
            `<div class="card"><a href="systems/${esc(s.id)}.html">${esc(String(s.name))}</a> <span class="src">${esc(s.id)}${s.owner ? ` · ${esc(String(s.owner))}` : " · owner unknown"}</span></div>`,
        )
        .join("")}`,
  )
  .join("\n")}`;
  await writeFile(join(dir, "index.html"), page(o.title, index, 0, true));
  const search = all
    .map((r) => ({ r, sys: systemOf(r) }))
    .filter((x) => x.sys && visible(x.sys))
    .map(({ r, sys }) => ({
      id: r.id,
      kind: r.kind,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      system: sys,
      href: `systems/${sys}.html`,
    }));
  await writeFile(join(dir, "search.json"), JSON.stringify(search));
  files += 2;
  return {
    systems: open.map((s) => s.id),
    hidden: systems.filter((s) => !openIds.has(s.id)).map((s) => s.id),
    files,
  };
}
