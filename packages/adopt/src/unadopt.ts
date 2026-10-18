import { readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findSection, parseHeader } from "@maycombhq/assistant-files";
import { SNAPSHOT_FILE, type Snapshot } from "./adopt.js";
import { AdoptError } from "./errors.js";
import { exists, isDir, listDirs, listFiles, readText, sha256 } from "./files.js";
import { ATTICUS_DIR, readLayout } from "./layout.js";

/**
 * `atticus unadopt <path>`: remove Atticus from a repo adopted in place, leaving every other
 * file exactly as it was. Removed: `.atticus/`; local-state folders Atticus created at the
 * root (workspace/, .index/, .runs/, and a catalog/ written there when the layout keeps the
 * catalog in .atticus/); Atticus's own files in OpenSpec change folders created since
 * adoption (change.yaml, brief.md, repos.yaml, ux.md, review/); generated assistant
 * files created since adoption (they carry Atticus's header), and Atticus's marked section in
 * files that existed (only when taking it out gives back the file as it was). Anything else
 * new or changed since adoption is the team's work: it is listed, never removed.
 */

export interface UnadoptResult {
  removed: string[];
  /** Files whose Atticus section was taken out, giving back the file as it was. */
  restored: string[];
  /** New since adoption and not Atticus's: kept. */
  keptNew: string[];
  /** Existed at adoption and changed since: kept as they are now. */
  changed: string[];
  /** Existed at adoption and are gone now. */
  missing: string[];
  /** False when there was no snapshot, so only what is certainly Atticus's was removed. */
  hadSnapshot: boolean;
}

const ROOT_STATE = ["workspace", ".index", ".runs"];
const CHANGE_OWNED = new Set(["change.yaml", "brief.md", "repos.yaml", "ux.md"]);

/**
 * Is this path one of Atticus's own files inside an OpenSpec change folder? With a snapshot
 * (`sure`), the files Atticus writes when it starts a change count too, and so does the
 * folder's `.openspec.yaml` when the change itself (its change.yaml) is new since adoption.
 */
function changeOwned(
  path: string,
  openspec: string,
  sure: boolean,
  newChange: (changeYaml: string) => boolean,
): boolean {
  const prefix = `${openspec}/changes/`;
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split("/");
  const lead = parts[0] === "archive" ? 2 : 1;
  if (parts.length <= lead) return false;
  const inChange = parts.slice(lead);
  if (inChange[0] === "review") return true;
  if (inChange.length !== 1) return false;
  if (inChange[0] === "change.yaml") return true;
  if (!sure) return false;
  if (CHANGE_OWNED.has(inChange[0]!)) return true;
  const changeYaml = `${prefix}${parts.slice(0, lead).join("/")}/change.yaml`;
  return inChange[0] === ".openspec.yaml" && newChange(changeYaml);
}

/** Candidate texts of a file before Atticus appended or inserted its section. */
function withoutSection(text: string): string[] {
  const s = findSection(text);
  if (!s) return [];
  const lines = text.split("\n");
  const before = lines.slice(0, s.start).join("\n");
  const after = lines.slice(s.end + 1).join("\n");
  const out = new Set<string>();
  if (after === "" || after === "\n") {
    // The section was appended (writeAssistantFiles adds "", "\n" or "\n\n" before it).
    for (const b of [before, `${before}\n`, before.replace(/\n$/, ""), before.replace(/\n\n$/, "")])
      out.add(b);
    if (before === "") out.add("");
  } else out.add([...lines.slice(0, s.start), ...lines.slice(s.end + 1)].join("\n"));
  return [...out];
}

export async function unadopt(path: string): Promise<UnadoptResult> {
  const root = resolve(path);
  const a = join(root, ATTICUS_DIR);
  if (!(await isDir(a)))
    throw new AdoptError(
      "not-adopted",
      `${path} isn't adopted: there is no ${ATTICUS_DIR}/ folder.`,
    );

  const layout = await readLayout(join(a, "org-pack"));
  let snap: Snapshot | undefined;
  try {
    snap = JSON.parse(await readFile(join(root, SNAPSHOT_FILE), "utf8")) as Snapshot;
  } catch {
    snap = undefined;
  }
  const res: UnadoptResult = {
    removed: [],
    restored: [],
    keptNew: [],
    changed: [],
    missing: [],
    hadSnapshot: !!snap,
  };
  const before = snap?.files ?? {};
  const existed = (p: string) => p in before;

  await rm(a, { recursive: true, force: true });
  res.removed.push(`${ATTICUS_DIR}/`);
  for (const f of ROOT_STATE) {
    const had = snap
      ? Object.keys(before).some((p) => p === f || p.startsWith(`${f}/`)) || snap.dirs.includes(f)
      : true;
    if (!had && (await isDir(join(root, f)))) {
      await rm(join(root, f), { recursive: true, force: true });
      res.removed.push(`${f}/`);
    }
  }

  // Where Atticus's change files can be: the layout's OpenSpec folder when it is the repo's, and
  // a root openspec/ that didn't exist at adoption (written by a command that ignores layout).
  const openspecs = [
    ...(layout.openspec.startsWith(`${ATTICUS_DIR}/`) ? [] : [layout.openspec]),
    ...(snap && layout.openspec !== "openspec" && !snap.dirs.includes("openspec")
      ? ["openspec"]
      : []),
  ];
  // Likewise a root catalog/ Atticus wrote when the layout keeps the catalog in .atticus/.
  const strayCatalog =
    !!snap &&
    layout.catalog !== "catalog" &&
    !snap.dirs.includes("catalog") &&
    (await isDir(join(root, "catalog")));
  if (strayCatalog) {
    await rm(join(root, "catalog"), { recursive: true, force: true });
    res.removed.push("catalog/");
  }
  const files = await listFiles(root);
  const present = new Set(files);
  const newChange = (changeYaml: string) => present.has(changeYaml) && !existed(changeYaml);
  for (const f of files) {
    const full = join(root, f);
    if (existed(f)) {
      const now = sha256(await readFile(full));
      if (now === before[f]) continue;
      const text = (await readText(full)) ?? "";
      const back = withoutSection(text).find((t) => sha256(t) === before[f]);
      if (back !== undefined) {
        await writeFile(full, back, "utf8");
        res.restored.push(f);
      } else res.changed.push(f);
      continue;
    }
    // New since adoption (or no snapshot): remove only what is certainly Atticus's.
    let atticus = openspecs.some((o) => changeOwned(f, o, !!snap, newChange));
    if (!atticus) {
      const text = await readText(full);
      if (text !== undefined && parseHeader(text)) atticus = true;
      else if (text !== undefined && findSection(text)) {
        // A file holding only Atticus's section was created by Atticus; otherwise take the
        // section out and keep the person's lines.
        const back = withoutSection(text)[0];
        if (back === undefined || back.trim() === "") atticus = true;
        else {
          await writeFile(full, back, "utf8");
          res.restored.push(f);
          continue;
        }
      }
    }
    if (atticus) {
      await rm(full, { force: true });
      res.removed.push(f);
    } else if (snap) res.keptNew.push(f);
  }
  if (snap)
    for (const f of Object.keys(before)) if (!(await exists(join(root, f)))) res.missing.push(f);

  // Folders Atticus created that are empty now, deepest first.
  if (snap) {
    const had = new Set(snap.dirs);
    for (const d of (await listDirs(root)).reverse()) {
      if (had.has(d)) continue;
      try {
        await rmdir(join(root, d));
      } catch {
        // not empty: something of the team's is in it
      }
    }
  }
  res.removed.sort();
  return res;
}
