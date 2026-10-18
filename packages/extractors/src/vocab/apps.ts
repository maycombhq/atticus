import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor, type RepoHandle, type ScanContext } from "@maycombhq/sdk";
import {
  component,
  ev,
  lineAt,
  loose,
  own,
  read,
  sources,
  stripComments,
  templatePath,
} from "./common.js";

/**
 * Mobile and desktop apps (ADR 0040): the repo's component as type `mobile-app` or
 * `desktop-app`, and the HTTP calls the app makes as http-call loose ends.
 *
 * Markers, first one deciding the runtime: Flutter (`pubspec.yaml` with the flutter SDK),
 * React Native (`package.json` depending on react-native), Android (`AndroidManifest.xml`),
 * iOS (`Info.plist` with a bundle id); desktop: Electron (`package.json` depending on electron),
 * Tauri (`tauri.conf.json`), WPF or WinForms (`<UseWPF>`/`<UseWindowsForms>` in a .csproj).
 *
 * Calls (JavaScript calls are the frontend extractor's): Retrofit interfaces (`@GET("path")`
 * and friends, joined to a literal `baseUrl(...)` when the repo has exactly one), Swift
 * `URL(string: "...")` (POST when `httpMethod = "POST"` follows within five lines) and Alamofire
 * `AF.request("...", method: .post)`, Dart `http.get(Uri.parse("..."))` and Dio calls (joined to
 * a literal `BaseOptions(baseUrl: ...)`). `$x` and `${a.x}` in Dart and `\(x)` in Swift become
 * `{x}`.
 */

const MARKERS = [
  "**/pubspec.yaml",
  "**/package.json",
  "**/AndroidManifest.xml",
  "**/Info.plist",
  "**/tauri.conf.json",
  "**/*.csproj",
];
const KOTLIN = ["**/*.kt", "**/*.java"];
const SWIFT = ["**/*.swift"];
const DART = ["**/*.dart"];

interface Marker {
  type: "mobile-app" | "desktop-app";
  runtime: string;
  path: string;
  line: number;
}

const firstLine = (text: string, re: RegExp) => {
  const m = re.exec(text);
  return m ? lineAt(text, m.index) : 1;
};

async function markers(repo: RepoHandle, ctx: ScanContext): Promise<Marker[]> {
  const found: Marker[] = [];
  const order = ["flutter", "react-native", "android", "ios", "electron", "tauri", "windows"];
  for (const path of await sources(repo, MARKERS)) {
    const text = await read(repo, ctx, path);
    if (text === undefined) continue;
    const name = path.split("/").pop()!;
    if (name === "pubspec.yaml" && /^\s+sdk\s*:\s*flutter\b/m.test(text))
      found.push({
        type: "mobile-app",
        runtime: "flutter",
        path,
        line: firstLine(text, /^\s*flutter\s*:/m),
      });
    else if (name === "package.json" && /"react-native"\s*:/.test(text))
      found.push({
        type: "mobile-app",
        runtime: "react-native",
        path,
        line: firstLine(text, /"react-native"\s*:/),
      });
    else if (name === "package.json" && /"electron"\s*:/.test(text))
      found.push({
        type: "desktop-app",
        runtime: "electron",
        path,
        line: firstLine(text, /"electron"\s*:/),
      });
    else if (name === "AndroidManifest.xml" && /<application\b/.test(text))
      found.push({
        type: "mobile-app",
        runtime: "android",
        path,
        line: firstLine(text, /<application\b/),
      });
    else if (name === "Info.plist" && /CFBundleIdentifier/.test(text))
      found.push({
        type: "mobile-app",
        runtime: "ios",
        path,
        line: firstLine(text, /CFBundleIdentifier/),
      });
    else if (name === "tauri.conf.json")
      found.push({ type: "desktop-app", runtime: "tauri", path, line: 1 });
    else if (name.endsWith(".csproj") && /<Use(WPF|WindowsForms)>\s*true/i.test(text))
      found.push({
        type: "desktop-app",
        runtime: "windows",
        path,
        line: firstLine(text, /<Use(WPF|WindowsForms)>/i),
      });
  }
  return found.sort(
    (a, b) => order.indexOf(a.runtime) - order.indexOf(b.runtime) || a.path.localeCompare(b.path),
  );
}

/** Retrofit: a path starting with "/" replaces the base URL's path; otherwise it is appended. */
function joinBase(base: string | undefined, path: string): string {
  if (!base || /^https?:\/\//.test(path)) return path;
  if (path.startsWith("/")) {
    const origin = /^https?:\/\/[^/]+/.exec(base)?.[0];
    return origin ? `${origin}${path}` : path;
  }
  return `${base.replace(/\/?$/, "/")}${path}`;
}

/** Dio and plain joins: base and path with exactly one slash between them. */
const joinUrl = (base: string | undefined, path: string) =>
  !base || /^https?:\/\//.test(path)
    ? path
    : `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export const appsExtractor = defineExtractor({
  id: "apps",
  version: "0.1.0",
  claims: [...MARKERS, ...KOTLIN, ...SWIFT, ...DART],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const found = await markers(repo, ctx);
    if (found.length > 0) {
      const first = found[0]!;
      const c = component({
        repo,
        ctx,
        id: comp,
        type: first.type,
        runtime: first.runtime,
        source: "config",
        path: first.path,
        line: first.line,
      });
      c.evidence = found.map((m) => ev(repo, "config", m.path, m.line));
      yield c;
    }
    const android = found.some((m) => m.runtime === "android");
    const calls: CatalogRecord[] = [];
    const call = (method: string, url: string, path: string, line: number) =>
      calls.push(
        loose(repo, comp, "http-call", `${method.toUpperCase()} ${templatePath(url)}`, path, line),
      );

    // Retrofit
    const kotlin: { path: string; text: string }[] = [];
    const bases = new Set<string>();
    for (const path of await sources(repo, KOTLIN)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !(android || /retrofit2/.test(text))) continue;
      const clean = stripComments(text, "c");
      kotlin.push({ path, text: clean });
      for (const m of clean.matchAll(/\.baseUrl\s*\(\s*"([^"]+)"/g)) bases.add(m[1]!);
    }
    const base = bases.size === 1 ? [...bases][0] : undefined;
    for (const { path, text } of kotlin)
      for (const m of text.matchAll(/@(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(\s*"([^"]*)"\s*\)/g))
        call(m[1]!, joinBase(base, m[2]!), path, lineAt(text, m.index));

    // Swift
    for (const path of await sources(repo, SWIFT)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/URL\s*\(\s*string|AF\.request|\.request\s*\(/.test(text))
        continue;
      const clean = stripComments(text, "c");
      const lines = clean.split("\n");
      for (const m of clean.matchAll(/URL\s*\(\s*string\s*:\s*"(https?:\/\/[^"]+)"/g)) {
        const line = lineAt(clean, m.index);
        const after = lines.slice(line - 1, line + 5).join("\n");
        const method = /httpMethod\s*=\s*"(\w+)"/.exec(after)?.[1] ?? "GET";
        call(method, m[1]!, path, line);
      }
      for (const m of clean.matchAll(
        /\b(?:AF|Session\.default)\.request\s*\(\s*"(https?:\/\/[^"]+)"([^)]*)\)/g,
      )) {
        const method = /method\s*:\s*\.(\w+)/.exec(m[2]!)?.[1] ?? "get";
        call(method, m[1]!, path, lineAt(clean, m.index));
      }
    }

    // Dart
    for (const path of await sources(repo, DART)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\bhttp\.|[dD]io\b/.test(text)) continue;
      const clean = stripComments(text, "c");
      const dioBase = /BaseOptions\s*\([^)]*\bbaseUrl\s*:\s*["']([^"']+)["']/.exec(clean)?.[1];
      for (const m of clean.matchAll(
        /\bhttp\.(get|post|put|delete|patch)\s*\(\s*Uri\.parse\s*\(\s*["']([^"']+)["']/g,
      ))
        call(m[1]!, m[2]!, path, lineAt(clean, m.index));
      for (const m of clean.matchAll(
        /\b_?\w*[dD]io\.(get|post|put|delete|patch)\s*(?:<[^>(]*>)?\s*\(\s*["']([^"']+)["']/g,
      ))
        call(m[1]!, joinUrl(dioBase, m[2]!), path, lineAt(clean, m.index));
    }
    yield* calls;
  },
});
