import { acceptOrgPackDraft, draftOrgPack } from "@maycombhq/knowledge";
import type { Output } from "./commands.js";

/**
 * atticus orgpack draft [--platform p] [--json] and atticus orgpack accept <platform> [--only
 * id,id] [--verified-only] [--dry-run] [--json] (ADR 0101): the profile's systems drafted from
 * what the wikis say, and the person's pick of them into profile.yaml.
 */
export async function orgPackDraftCli(
  root: string,
  command: string,
  arg: string | undefined,
  values: Record<string, unknown>,
  io: Output,
): Promise<number> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const json = values.json === true;
  try {
    if (command === "draft") {
      const d = await draftOrgPack(root, {
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
      });
      if (json) {
        io.out(JSON.stringify(d, null, 2));
        return 0;
      }
      if (!d.proposals.length) {
        io.out(`The ${d.platform} profile already has every system the knowledge items name.`);
        return 0;
      }
      io.out(
        `${d.proposals.length} system${d.proposals.length === 1 ? "" : "s"} for the ${d.platform} profile, from the knowledge items:`,
      );
      for (const p of d.proposals)
        io.out(
          `  ${p.action === "add" ? "add   " : "update"} ${p.system.id}: ${p.system.name}${p.action === "add" ? ` (${p.system.boundary}${p.system.owner ? `, ${p.system.owner}` : ""})` : ` gains ${[p.adds?.aliases?.length ? `aliases ${p.adds.aliases.join(", ")}` : "", p.adds?.owner ? `owner ${p.adds.owner}` : ""].filter(Boolean).join(" and ")}`}${p.verified ? " ✓" : ""}`,
        );
      if (d.proposals.some((p) => p.verified))
        io.out("✓ a person verified the knowledge item it comes from");
      io.out(
        `Written to ${d.file} and ${d.file.replace(/\.yaml$/, ".md")}. Accept them with atticus orgpack accept ${d.platform} [--only id,id] [--verified-only].`,
      );
      return 0;
    }
    if (!arg) {
      io.err(
        "Usage: atticus orgpack accept <platform> [--only id,id] [--verified-only] [--dry-run]",
      );
      return 2;
    }
    const only = str(values.only)
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const r = await acceptOrgPackDraft(root, arg, {
      ...(only ? { only } : {}),
      ...(values["verified-only"] === true ? { verifiedOnly: true } : {}),
      ...(values["dry-run"] === true ? { dryRun: true } : {}),
    });
    if (json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    const would = values["dry-run"] === true;
    io.out(
      `${would ? "Would add" : "Added"} ${r.added.length ? r.added.join(", ") : "no system"} and ${would ? "would update" : "updated"} ${r.updated.length ? r.updated.join(", ") : "none"} in ${r.file}; ${r.left} left in the draft.`,
    );
    if (!would && (r.added.length || r.updated.length))
      io.out("Commit profile.yaml through a pull request: merging it is the approval.");
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
}
