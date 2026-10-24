import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { changesRelOf, inputsDirOf } from "@maycombhq/core";
import { changeFolder, changeStore } from "@maycombhq/changes";
import { attachToChange, type AttachResult, type ChangeInput } from "@maycombhq/intake";
import { renderTaskContext, taskContext } from "@maycombhq/planner";
import type { Output } from "./commands.js";

/**
 * ADR 0113: `atticus change attach <change> <files...>` (files into one change, read and cited
 * by its steps) and `atticus task context <change> <task>` (the task's context for an assistant
 * where the code is written). The local API's upload runs `attachFiles` too.
 */

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => []))
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile()) out.push(join(d, e.name));
  };
  await walk(dir);
  return out;
}

/** The metarepo's own inputs/ by their bytes, to say when a file attached is already there. */
async function metarepoInputs(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await filesUnder(inputsDirOf(root)))
    out.set(sha256(new Uint8Array(await readFile(f))), relative(root, f).split(sep).join("/"));
  return out;
}

export class AttachError extends Error {
  constructor(
    readonly code: "not-found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "AttachError";
  }
}

/** Attach files to a change, as `atticus change attach` and the API's upload do. */
export async function attachFiles(
  root: string,
  change: string,
  files: { name: string; bytes: Uint8Array }[],
  by: string,
  now = new Date(),
  /** The attached file (inputs/<name>) these replace: a person's word, never a name's guess. */
  replaces?: string,
): Promise<AttachResult> {
  const c = await changeStore(root)
    .read(change)
    .catch(() => {
      throw new AttachError(
        "not-found",
        `There is no change ${change}: atticus change list shows them.`,
      );
    });
  const known = await metarepoInputs(root);
  return attachToChange(changeFolder(root, c.id), files, {
    by,
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    elsewhere: (h) => known.get(h),
    ...(replaces ? { replaces } : {}),
  });
}

/**
 * Copy a file attached to a change into general knowledge (ADR 0122): into the metarepo's
 * inputs/inbox/, where the knowledge source reads it at the next sync. The change keeps its copy
 * and goes on citing it. `file` is the attached file's name, with or without inputs/.
 */
export async function promoteChangeInput(
  root: string,
  change: string,
  file: string,
): Promise<{ path: string; note: string }> {
  const c = await changeStore(root)
    .read(change)
    .catch(() => {
      throw new AttachError(
        "not-found",
        `There is no change ${change}: atticus change list shows them.`,
      );
    });
  const name = file.replace(/^inputs\//, "");
  if (!name || /[\\/]/.test(name) || name === "." || name === "..")
    throw new AttachError(
      "invalid",
      `Name one attached file, such as inputs/${basename(file) || "rules.pdf"}.`,
    );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(changeFolder(root, c.id), "inputs", name)));
  } catch {
    throw new AttachError(
      "not-found",
      `inputs/${name} isn't attached to ${c.id}: atticus change attach ${c.id} adds it.`,
    );
  }
  const { addToInbox } = await import("./intake-commands.js");
  const r = await addToInbox(root, [{ name, bytes }]);
  const added = r.added[0];
  if (!added) throw new AttachError("invalid", `inputs/${name}: ${r.refused[0]?.why ?? "refused"}`);
  return {
    path: added.path,
    note: `Copied to ${added.path}: general knowledge, read at the next atticus sources sync. ${c.id} keeps its copy. Commit both through a pull request.`,
  };
}

/** One line about a file attached, for a person. */
export function attachedLine(rel: string, a: ChangeInput): string {
  const what =
    a.read === "text"
      ? `${a.kind}, ${a.format}; read, cited by ${a.citeBy}`
      : a.kind === "image"
        ? "a picture: your assistant looks at it in the chat; Atticus doesn't read pictures"
        : `${a.format}: no reader takes it, so the steps name it without its text`;
  return `Attached ${rel}/${a.path} (${what})${a.supersedes ? `, a newer version of ${a.supersedes}` : ""}${a.defences ? `; the defences found ${a.defences.risk} risk` : ""}.`;
}

/**
 * atticus change attach <change> <files...> [--replaces inputs/<file>] [--json]. Exit 0: all
 * attached; 1: some refused. With --replaces, the one file given is the newer version of that
 * attached file (a person says so; Atticus never guesses it from the names).
 */
export async function changeAttachCli(
  root: string,
  change: string | undefined,
  paths: string[],
  o: { by: string; json?: boolean; now?: Date; replaces?: string; promote?: string },
  io: Output,
): Promise<number> {
  // ADR 0122: --promote copies an attached file into general knowledge.
  if (change && o.promote) {
    if (paths.length) {
      io.err(
        "--promote names one file already attached; attach new files without it, for example: atticus change attach add-refund-window --promote inputs/refund-rules.pdf",
      );
      return 2;
    }
    try {
      const r = await promoteChangeInput(root, change, o.promote);
      if (o.json) io.out(JSON.stringify(r, null, 2));
      else io.out(r.note);
      return 0;
    } catch (e) {
      if (e instanceof AttachError) {
        io.err(e.message);
        return 1;
      }
      throw e;
    }
  }
  if (!change || paths.length === 0) {
    io.err(
      "Usage: atticus change attach <change> <files...>, for example: atticus change attach add-refund-window refund-rules.pdf",
    );
    return 2;
  }
  if (o.replaces && paths.length !== 1) {
    io.err(
      "--replaces names the one attached file that the file given replaces: attach one file with it, for example: atticus change attach add-refund-window refund-rules-v2.pdf --replaces inputs/refund-rules-v1.pdf",
    );
    return 2;
  }
  const files: { name: string; bytes: Uint8Array }[] = [];
  let problems = false;
  for (const p of paths) {
    try {
      files.push({ name: basename(p), bytes: new Uint8Array(await readFile(resolve(p))) });
    } catch {
      io.err(`Can't read ${p}.`);
      problems = true;
    }
  }
  let r: AttachResult;
  try {
    r = await attachFiles(root, change, files, o.by, o.now, o.replaces);
  } catch (e) {
    if (e instanceof AttachError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return r.refused.length || problems ? 1 : 0;
  }
  const rel = `${changesRelOf(root)}/${change}`;
  for (const a of r.added) io.out(attachedLine(rel, a));
  for (const x of r.refused) io.err(`${x.name}: not attached. ${x.why}`);
  for (const n of r.notes) io.out(n);
  if (r.added.length)
    io.out(
      `The change's steps read them as data, citing each by file and line or page: atticus next says which step is next. Commit ${rel}/inputs/ with the change.`,
    );
  return r.refused.length || problems ? 1 : 0;
}

/** atticus task context <change> <task> [--json|--markdown]: Markdown unless --json. */
export async function taskContextCli(
  root: string,
  change: string | undefined,
  task: string | undefined,
  o: { json?: boolean; markdown?: boolean },
  io: Output,
): Promise<number> {
  if (!change || !task) {
    io.err(
      "Usage: atticus task context <change> <task> [--json|--markdown], for example: atticus task context add-refund-window 1.2",
    );
    return 2;
  }
  try {
    const c = await taskContext(root, change, task);
    io.out(o.json && !o.markdown ? JSON.stringify(c, null, 2) : renderTaskContext(c).trimEnd());
    return 0;
  } catch (e) {
    if (e instanceof Error && ["PlannerError", "ChangeError", "ChangeFileError"].includes(e.name)) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}
