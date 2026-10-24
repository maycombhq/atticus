import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether a folder is an Atticus metarepo (org-pack/, or .atticus/org-pack/ in an adopted repo),
 * and the one message when it isn't (ADR 0119, WP3.4): atticus next, assistant-files and the
 * assistant's own check all say it the same way.
 */
export const isMetarepo = (root: string): boolean =>
  existsSync(join(root, "org-pack")) || existsSync(join(root, ".atticus", "org-pack"));

export const notMetarepo = (root: string): string =>
  `${root} isn't an Atticus metarepo. Make one with atticus init <folder>, use Atticus in an existing repo with atticus adopt <path>, or open the folder of one you have.`;
