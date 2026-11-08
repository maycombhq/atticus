import { readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { orgPackDirOf, writeFileIfUnchanged } from "@maycombhq/core";
import type { Output } from "./commands.js";
import { isMetarepo, notMetarepo } from "./metarepo-guard.js";

/**
 * atticus orgpack owner [<handle>] (WP4.4): who looks after the org pack (pack.yaml's owner),
 * shown, or set without a person editing YAML. Only that one value changes; the file's other
 * lines and comments stay as they are.
 */
export class OwnerEditError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** One handle, such as priya.nair or team-platform. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Set pack.yaml's owner, as atticus orgpack owner does (the app's Set up checklist, seventh UX
 * walk): only that one value changes. `was` is the owner the form showed ("" for none); pack.yaml
 * saying another now is refused, never written over.
 */
export async function setOrgPackOwner(
  root: string,
  handle: string,
  was?: string,
): Promise<{ file: string; owner: string }> {
  const file = join(orgPackDirOf(root), "pack.yaml");
  const rel = relative(root, file).split(sep).join("/");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined)
    throw new OwnerEditError("not-found", `${rel} isn't there: atticus upgrade writes it.`);
  const h = handle.trim();
  if (!HANDLE.test(h))
    throw new OwnerEditError(
      "invalid",
      "The owner is one handle, such as priya.nair or team-platform: letters, digits, dots, hyphens.",
    );
  const doc = parseDocument(text);
  const now = doc.get("owner");
  const current = typeof now === "string" && now !== "unassigned" ? now : "";
  if (was !== undefined && was !== current)
    throw new OwnerEditError(
      "conflict",
      `pack.yaml's owner changed since you opened the form (now ${current || "unassigned"}): look again, then save.`,
    );
  doc.set("owner", h);
  await writeFileIfUnchanged(file, text, doc.toString({ lineWidth: 0 }));
  return { file: rel, owner: h };
}

export async function orgPackOwnerCli(
  root: string,
  handle: string | undefined,
  io: Output,
): Promise<number> {
  if (!isMetarepo(root)) {
    io.err(notMetarepo(root));
    return 2;
  }
  const file = join(orgPackDirOf(root), "pack.yaml");
  const rel = relative(root, file).split(sep).join("/");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`${rel} isn't there: atticus upgrade writes it.`);
    return 1;
  }
  const doc = parseDocument(text);
  if (!handle) {
    const owner = doc.get("owner");
    io.out(
      typeof owner === "string" && owner
        ? `${owner} looks after the org pack (${rel}).`
        : `No one looks after the org pack yet: atticus orgpack owner <handle> sets it (${rel}).`,
    );
    return 0;
  }
  const h = handle.trim();
  if (!HANDLE.test(h)) {
    io.err(
      "The owner is one handle, such as priya.nair or team-platform: letters, digits, dots, hyphens.",
    );
    return 2;
  }
  doc.set("owner", h);
  await writeFile(file, doc.toString({ lineWidth: 0 }), "utf8");
  io.out(
    `${h} now looks after the org pack. Commit ${rel} through a pull request; its owner approves changes to it.`,
  );
  return 0;
}
