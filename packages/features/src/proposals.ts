import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { IsoDateTime, RecordId, toCanonicalYaml, type CatalogRecord } from "@maycombhq/core";
import {
  detectFeaturesWithReport,
  type Capability,
  type DetectProblem,
  type FeatureNameProposal,
} from "./detect.js";

/**
 * AI name proposals, one file per feature at `catalog/proposals/capability/<feature>.yaml`.
 * They are made outside the scan (`nameFeatures`) and read by every scan, so a feature keeps
 * its proposed name (`namedBy: ai`, still `inferred`) until a person names it. They live
 * beside, not in, `catalog/curated`: a proposal is not a decision.
 */
export const NameProposalFile = z.strictObject({
  schemaVersion: z.literal(1),
  feature: RecordId,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  evidence: z.array(RecordId).min(1),
  agent: RecordId,
  runId: z.string().optional(),
  at: IsoDateTime,
});

const LEADING = ["schemaVersion", "feature", "name", "description", "tags", "evidence"];

export async function writeNameProposals(
  dir: string,
  proposals: readonly FeatureNameProposal[],
): Promise<string[]> {
  const written: string[] = [];
  if (!proposals.length) return written;
  await mkdir(join(dir, "capability"), { recursive: true });
  for (const p of proposals) {
    const file = `capability/${p.feature}.yaml`;
    const body = NameProposalFile.parse({ schemaVersion: 1, ...p });
    await writeFile(join(dir, file), toCanonicalYaml(body, LEADING), "utf8");
    written.push(file);
  }
  return written;
}

export async function readNameProposals(
  dir: string,
): Promise<{ proposals: FeatureNameProposal[]; problems: { file: string; message: string }[] }> {
  const proposals: FeatureNameProposal[] = [];
  const problems: { file: string; message: string }[] = [];
  let files: string[];
  try {
    files = (await readdir(join(dir, "capability"))).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return { proposals, problems };
  }
  for (const f of files) {
    const file = `capability/${f}`;
    let data: unknown;
    try {
      data = parse(await readFile(join(dir, file), "utf8"));
    } catch (e) {
      problems.push({ file, message: `invalid YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    const p = NameProposalFile.safeParse(data);
    if (!p.success) {
      problems.push({
        file,
        message: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    const { schemaVersion: _v, ...rest } = p.data;
    void _v;
    proposals.push(rest);
  }
  return { proposals, problems };
}

export interface ScanFeaturesInput {
  /** The merged catalog, before curated decisions apply. */
  records: readonly CatalogRecord[];
  /** catalog/curated: membership asserts and merges shape detection. */
  decisions: readonly CatalogRecord[];
  /** Where AI name proposals are (catalog/proposals); none when left out. */
  proposalsDir?: string;
  maxDepth?: number;
}

/**
 * What a scan adds: the detected Capability records, named from proposals and shaped by
 * people's merges and splits. The scan then applies curated decisions over them as over any
 * record, so a person's name always wins.
 */
export async function featuresForScan(
  input: ScanFeaturesInput,
): Promise<{ features: Capability[]; problems: DetectProblem[] }> {
  const read = input.proposalsDir
    ? await readNameProposals(input.proposalsDir)
    : { proposals: [], problems: [] };
  const r = detectFeaturesWithReport(input.records, {
    decisions: input.decisions,
    proposals: read.proposals,
    ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
  });
  return {
    features: r.features,
    problems: [
      ...read.problems.map((p) => ({ decision: `proposals/${p.file}`, message: p.message })),
      ...r.problems,
    ],
  };
}
