import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isSeq, parse, parseDocument, stringify, type YAMLMap } from "yaml";
import { z } from "zod";
import {
  loadOrgPack,
  orgPackDirOf,
  Profile,
  proposalsDirOf,
  proposalsRelOf,
  writeFileAtomic,
} from "@maycombhq/core";
import { readKnowledge } from "./knowledge-store.js";

/**
 * The org pack drafted from the knowledge (ADR 0101). Nobody knows every system, alias, vendor
 * and owner of a big organisation on day one; the wikis do. The knowledge scan reads them (the
 * AI reads, every quote checked); the draft turns the products and vendors it read into the
 * platform profile's systems, deterministically: a new system, or, for one the profile already
 * has under its name or an alias, the aliases and owner it lacks. An alias another system
 * already has is left out, and said. Nothing is written to the org pack: the draft is a
 * proposal (`proposals/orgpack/<platform>.yaml` and `.md`), each entry citing its item and
 * whether a person verified it; `acceptOrgPackDraft` puts what a person picks into
 * profile.yaml, and the pull request is the approval.
 */

const System = z.object({
  id: z.string(),
  name: z.string(),
  boundary: z.enum(["product", "internal", "vendor"]),
  owner: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const OrgPackProposal = z.object({
  /** The knowledge item it comes from. */
  from: z.string(),
  kind: z.string(),
  action: z.enum(["add", "update"]),
  /** For add: the system to add. For update: the system as it is now. */
  system: System,
  /** For update: what it gains. */
  adds: z
    .object({ aliases: z.array(z.string()).optional(), owner: z.string().optional() })
    .optional(),
  verified: z.boolean(),
  verifiedBy: z.string().optional(),
  quote: z.string().optional(),
  page: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type OrgPackProposal = z.infer<typeof OrgPackProposal>;

const DraftFile = z.object({
  schemaVersion: z.literal(1),
  platform: z.string(),
  at: z.string().optional(),
  proposals: z.array(OrgPackProposal).default([]),
});

const norm = (s: string) => s.trim().toLowerCase();
const profileFile = (root: string, platform: string) =>
  join(orgPackDirOf(root), "profiles", platform, "profile.yaml");

/** Draft the profile's systems from the knowledge items, as a proposal. */
export async function draftOrgPack(
  root: string,
  o: { platform?: string; now?: Date },
): Promise<{ platform: string; proposals: OrgPackProposal[]; file: string }> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const platforms = op.profiles.map((p) => p.platform);
  const platform = o.platform ?? (platforms.length === 1 ? platforms[0] : undefined);
  if (!platform || !platforms.includes(platform))
    throw new Error(
      o.platform
        ? `There is no platform ${o.platform} in the org pack (there is ${platforms.join(", ") || "none"}).`
        : `Say which platform: --platform ${platforms.join(" or ")}.`,
    );
  // Every system of every profile, by each of its names: one system, one name.
  const named = new Map<string, string>();
  /** The systems the profiles have now, by every name (for an item's name) and by name only (for its aliases). */
  const inProfiles = new Map<string, string>();
  const profileNames = new Map<string, string>();
  const systems = new Map<string, z.infer<typeof System>>();
  for (const p of op.profiles)
    for (const s of p.profile?.systems ?? []) {
      systems.set(s.id, { ...s, aliases: [...s.aliases], tags: [...s.tags] });
      for (const n of [s.name, ...s.aliases]) {
        named.set(norm(n), s.id);
        inProfiles.set(norm(n), s.id);
      }
      profileNames.set(norm(s.name), s.id);
    }
  const own = new Set(
    (op.profiles.find((p) => p.platform === platform)?.profile?.systems ?? []).map((s) => s.id),
  );
  const k = await readKnowledge(root, { cacheRoot: root });
  const candidates = k.items
    .filter(
      (i) =>
        (i.kind === "Product" && i.productKind === "product") ||
        (i.kind === "Party" && i.partyKind === "vendor" && !!i.quote),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const proposals: OrgPackProposal[] = [];
  for (const item of candidates) {
    const name = item.kind === "Product" || item.kind === "Party" ? item.name : item.id;
    const owner =
      item.kind === "Product" ? item.ownedBy : item.kind === "Party" ? item.owner : undefined;
    const aliases = item.kind === "Product" || item.kind === "Party" ? item.aliases : [];
    const review = k.reviews[item.id];
    const verified = review?.state === "verified" || review?.state === "corrected";
    const base = {
      from: item.id,
      kind: item.kind === "Party" ? "vendor" : "product",
      verified,
      ...(verified ? { verifiedBy: review!.by } : {}),
      ...(item.quote
        ? {
            quote: item.quote.text,
            page: `${item.quote.source}/${item.quote.page}#${item.quote.section}`,
          }
        : {}),
    };
    const notes: string[] = [];
    // An item is a system the profile has when its name is one of that system's names, or one
    // of its aliases is that system's name; two aliases alike are a clash, not the same system.
    const existing =
      inProfiles.get(norm(name)) ?? aliases.map((n) => profileNames.get(norm(n))).find(Boolean);
    const id = existing ?? item.id;
    const fresh = aliases.filter((a) => {
      const other = named.get(norm(a));
      if (other && other !== id) {
        notes.push(`"${a}" already names ${other}, so it was left out`);
        return false;
      }
      return (
        norm(a) !== norm(name) &&
        !(existing && systems.get(existing)!.aliases.some((x) => norm(x) === norm(a)))
      );
    });
    if (existing) {
      const s = systems.get(existing)!;
      if (!own.has(existing)) {
        notes.push(`${existing} is already in another platform's profile`);
        continue;
      }
      const adds = {
        ...(fresh.length ? { aliases: fresh } : {}),
        ...(owner && !s.owner ? { owner } : {}),
      };
      if (!Object.keys(adds).length) continue;
      proposals.push(OrgPackProposal.parse({ ...base, action: "update", system: s, adds, notes }));
      for (const a of fresh) named.set(norm(a), existing);
      continue;
    }
    if (systems.has(id)) {
      notes.push(`the id ${id} is taken by another system`);
      continue;
    }
    const system = {
      id,
      name,
      boundary: item.kind === "Party" ? ("vendor" as const) : ("internal" as const),
      ...(owner ? { owner } : {}),
      aliases: fresh,
      tags: [],
    };
    proposals.push(OrgPackProposal.parse({ ...base, action: "add", system, notes }));
    for (const n of [name, ...fresh]) named.set(norm(n), id);
  }
  const rel = `${proposalsRelOf(root)}/orgpack/${platform}.yaml`;
  const at = (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeFileAtomic(
    join(proposalsDirOf(root), "orgpack", `${platform}.yaml`),
    `# The ${platform} profile's systems, drafted from the knowledge items (ADR 0101). atticus orgpack accept ${platform} puts what you pick into profile.yaml.\n${stringify({ schemaVersion: 1, platform, at, proposals }, { lineWidth: 0 })}`,
  );
  await writeFileAtomic(
    join(proposalsDirOf(root), "orgpack", `${platform}.md`),
    summary(platform, proposals),
  );
  return { platform, proposals, file: rel };
}

function summary(platform: string, ps: OrgPackProposal[]): string {
  const lines = [
    `# The ${platform} profile, drafted from the wikis`,
    "",
    ps.length
      ? `${ps.length} system${ps.length === 1 ? "" : "s"} the knowledge items name that the profile lacks, or that gain an alias or an owner. Accept them with atticus orgpack accept ${platform} [--only id,id] [--verified-only]; commit profile.yaml through a pull request.`
      : "The profile already has every system the knowledge items name.",
    "",
  ];
  for (const p of ps) {
    const tick = p.verified ? ` ✓ verified by ${p.verifiedBy}` : " (not yet verified: check it)";
    if (p.action === "add")
      lines.push(
        `- **${p.system.name}** (${p.system.id}, ${p.system.boundary}${p.system.owner ? `, owned by ${p.system.owner}` : ""})${p.system.aliases.length ? `, also called ${p.system.aliases.join(", ")}` : ""}${tick}`,
      );
    else
      lines.push(
        `- **${p.system.name}** (${p.system.id}) gains ${[p.adds?.aliases?.length ? `the aliases ${p.adds.aliases.join(", ")}` : "", p.adds?.owner ? `the owner ${p.adds.owner}` : ""].filter(Boolean).join(" and ")}${tick}`,
      );
    if (p.quote) lines.push(`  "${p.quote}" (${p.page}, item ${p.from})`);
    for (const n of p.notes) lines.push(`  Note: ${n}.`);
  }
  return `${lines.join("\n")}\n`;
}

/** Put the proposals a person picks into profile.yaml; what is taken leaves the draft. */
export async function acceptOrgPackDraft(
  root: string,
  platform: string,
  o: { only?: string[]; verifiedOnly?: boolean; dryRun?: boolean } = {},
): Promise<{ added: string[]; updated: string[]; left: number; file: string }> {
  const draftPath = join(proposalsDirOf(root), "orgpack", `${platform}.yaml`);
  const text = await readFile(draftPath, "utf8").catch(() => undefined);
  if (text === undefined)
    throw new Error(
      `There is no draft for ${platform}. Make it first: atticus orgpack draft --platform ${platform}`,
    );
  const draft = DraftFile.parse(parse(text));
  const take = draft.proposals.filter(
    (p) =>
      (!o.only || o.only.includes(p.from) || o.only.includes(p.system.id)) &&
      (!o.verifiedOnly || p.verified),
  );
  const file = profileFile(root, platform);
  const doc = parseDocument(await readFile(file, "utf8"));
  let seq = doc.get("systems");
  if (!isSeq(seq)) {
    doc.set("systems", doc.createNode([]));
    seq = doc.get("systems");
  }
  const list = seq as { items: unknown[]; add(v: unknown): void };
  const added: string[] = [];
  const updated: string[] = [];
  for (const p of take) {
    if (p.action === "add") {
      list.add(
        doc.createNode({
          id: p.system.id,
          name: p.system.name,
          boundary: p.system.boundary,
          ...(p.system.owner ? { owner: p.system.owner } : {}),
          ...(p.system.aliases.length ? { aliases: p.system.aliases } : {}),
        }),
      );
      added.push(p.system.id);
      continue;
    }
    const node = list.items.find((n) => isMap(n) && (n as YAMLMap).get("id") === p.system.id) as
      YAMLMap | undefined;
    if (!node) continue;
    if (p.adds?.aliases?.length) {
      const now = node.get("aliases");
      const have = isSeq(now) ? (now.toJSON() as string[]) : [];
      node.set(
        "aliases",
        doc.createNode([...have, ...p.adds.aliases.filter((a) => !have.includes(a))]),
      );
    }
    if (p.adds?.owner && !node.get("owner")) node.set("owner", p.adds.owner);
    updated.push(p.system.id);
  }
  const checked = Profile.safeParse(doc.toJS());
  if (!checked.success)
    throw new Error(
      `profile.yaml would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const left = draft.proposals.filter((p) => !take.includes(p));
  if (!o.dryRun) {
    await writeFileAtomic(file, doc.toString());
    await writeFileAtomic(
      draftPath,
      `# The ${platform} profile's systems, drafted from the knowledge items (ADR 0101). atticus orgpack accept ${platform} puts what you pick into profile.yaml.\n${stringify({ ...draft, proposals: left }, { lineWidth: 0 })}`,
    );
    await writeFileAtomic(
      join(proposalsDirOf(root), "orgpack", `${platform}.md`),
      summary(platform, left),
    );
  }
  return { added, updated, left: left.length, file: `org-pack/profiles/${platform}/profile.yaml` };
}
