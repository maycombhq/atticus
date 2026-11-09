import { ChangeLifecycle } from "@maycombhq/core";
import { changeStore } from "./store.js";

/**
 * Ninth UX walk: the change.yaml `owners` a person names from the change page, one per role a
 * question can be for: the product owner (the brief), the architect (the estate and the design),
 * the business analyst (the stories) and the tech lead (the tasks and the build; the built-in role
 * id is team-lead). Other owner keys a change has (qa, a custom role) are kept as they are.
 */
export const OWNER_ROLE_KEYS = [
  "product-owner",
  "architect",
  "business-analyst",
  "team-lead",
] as const;
export type OwnerRoleKey = (typeof OWNER_ROLE_KEYS)[number];

export class ChangeOwnersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeOwnersError";
  }
}

const strip = (h: string) => h.trim().replace(/^@/, "");

/**
 * Name the owners of the roles given (an empty list clears a role), through the change store.
 * A person's click on the change page: a local edit to change.yaml, which rides the change's next
 * hand-off like any other change file.
 */
export async function setChangeOwners(
  root: string,
  id: string,
  owners: Readonly<Record<string, readonly string[]>>,
): Promise<ChangeLifecycle> {
  const store = changeStore(root);
  const c = await store.read(id);
  const next: Record<string, string[]> = { ...c.owners };
  for (const [key, people] of Object.entries(owners)) {
    if (!(OWNER_ROLE_KEYS as readonly string[]).includes(key))
      throw new ChangeOwnersError(
        `The change page names owners for ${OWNER_ROLE_KEYS.join(", ")}, not ${key}: edit change.yaml for other roles.`,
      );
    const list = [...new Set(people.map(strip).filter(Boolean))];
    if (list.length) next[key] = list;
    else delete next[key];
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  const r = ChangeLifecycle.safeParse({ ...c, owners: sorted });
  if (!r.success)
    throw new ChangeOwnersError(
      `Those owners can't be written: ${r.error.issues.map((i) => i.message).join("; ")}.`,
    );
  await store.write(r.data);
  return r.data;
}
