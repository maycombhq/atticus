import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { Api, CORE_ROLES, loadOrgPack, orgPackDirOf, type OrgPack } from "@maycombhq/core";
import { readCodeowners } from "@maycombhq/changes";
import { badRequest, type Router, type ServerContext } from "@maycombhq/server";

/**
 * Who is signed in, the view they work in and what they may approve (ADR 0044). A view
 * (role) decides what you see; approvals come only from ownership: people and groups in the
 * org pack's approvals, roles reached through a group mapping, and CODEOWNERS. Choosing a
 * view never grants an approval.
 */

/** The person's own file, never committed: their groups and the view they chose. */
export const ME_FILE = ".atticus/me.yaml";

const MeFile = z.object({
  groups: z.array(z.string().min(1)).default([]),
  view: z.string().min(1).optional(),
});
type MeFile = z.infer<typeof MeFile>;

const LABEL: Record<string, string> = {
  "product-owner": "Product owner",
  "business-analyst": "Business analyst",
  architect: "Architect",
  "team-lead": "Team lead",
  developer: "Developer",
  qa: "QA / test",
  "delivery-lead": "Delivery lead",
  "platform-lead": "Platform lead",
  designer: "Designer / UX analyst",
  "process-owner": "Process owner",
  "data-architect": "DBA or data architect",
  sre: "SRE or operations",
  "security-reviewer": "Security reviewer",
};

async function readMe(root: string): Promise<MeFile> {
  try {
    const r = MeFile.safeParse(parse(await readFile(join(root, ME_FILE), "utf8")) ?? {});
    return r.success ? r.data : { groups: [] };
  } catch {
    return { groups: [] };
  }
}

/** The roles this organisation offers: core, enabled optional ones, then custom ones. */
function rolesOf(op: OrgPack) {
  return [
    ...CORE_ROLES.map((id) => ({ id, name: LABEL[id]!, core: true })),
    ...op.roles.enabledOptional.map((id) => ({ id, name: LABEL[id]!, core: false })),
    ...op.roles.custom.map((c) => ({ id: c.id, name: c.name, core: false, basedOn: c.basedOn })),
  ];
}

export async function meView(root: string, user: string) {
  const op = await loadOrgPack(orgPackDirOf(root));
  const me = await readMe(root);
  const roles = rolesOf(op);
  const known = new Set(roles.map((r) => r.id));
  const mapped = op.roles.mappings.filter((m) => me.groups.includes(m.group) && known.has(m.role));
  const groupRoles = new Set(mapped.map((m) => m.role));
  const chosen = me.view && known.has(me.view) ? me.view : undefined;
  const view = chosen ?? mapped[0]?.role ?? null;
  const source = chosen ? "chosen" : mapped[0] ? "group" : "pick";

  const approvals: { action: string; because: string }[] = [];
  for (const [action, a] of Object.entries(op.roles.approvals)) {
    if (!a) continue;
    const person = a.people.includes(user);
    const group = a.groups.find((g) => me.groups.includes(g));
    const role = a.roles.find((r) => groupRoles.has(r));
    if (person) approvals.push({ action, because: `you are named in roles.yaml` });
    else if (group) approvals.push({ action, because: `you are in ${group}` });
    else if (role) {
      const via = mapped.find((m) => m.role === role)!.group;
      approvals.push({ action, because: `${via} maps to ${LABEL[role] ?? role}` });
    }
  }

  // CODEOWNERS lines that name the person or one of their groups (org/team handles match a
  // group by its last part, case and spaces aside: "forge/architects" ~ "Forge Architects").
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mine = new Set([norm(user), ...me.groups.map(norm)]);
  const owns = (await readCodeowners(root))
    .filter((r) =>
      r.owners.some((o) => {
        const parts = o.split("/");
        return mine.has(norm(o)) || mine.has(norm(parts.at(-1)!)) || mine.has(norm(parts.join("")));
      }),
    )
    .map((r) => r.pattern);

  return {
    user,
    ai: op.runtime.ai,
    groups: me.groups,
    view,
    source,
    ...(source === "group" ? { sourceGroup: mapped[0]!.group } : {}),
    roles,
    approvals,
    owns,
  };
}

export function uiMeRoutes(r: Router, ctx: ServerContext): Router {
  return r
    .add("GET", "/api/me", async () => ({ status: 200, body: await meView(ctx.root, ctx.user) }))
    .add("PUT", "/api/me", async ({ body }) => {
      const b = Api.SaveViewRequest.safeParse(body ?? {});
      if (!b.success) throw badRequest("Say which view: { view: <role id> }.");
      const op = await loadOrgPack(orgPackDirOf(ctx.root));
      const roles = rolesOf(op);
      if (!roles.some((x) => x.id === b.data.view))
        throw badRequest(
          `${b.data.view} isn't a view here. Views: ${roles.map((x) => x.id).join(", ")}.`,
        );
      const me = await readMe(ctx.root);
      const file = join(ctx.root, ME_FILE);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, stringify({ groups: me.groups, view: b.data.view }), "utf8");
      return { status: 200, body: await meView(ctx.root, ctx.user) };
    });
}
