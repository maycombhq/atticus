import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { attrOf } from "../platform/hcl.js";
import { loadTerraform, tfString } from "../platform/terraform.js";
import { ev, slug } from "./common.js";

/**
 * Cloud stores that are not databases (ADR 0040 `DataStore.storeType` values), from Terraform:
 *
 * - object storage: `aws_s3_bucket` (bucket), `google_storage_bucket` (name),
 *   `azurerm_storage_container` (name)
 * - queue: `aws_sqs_queue` (name)
 * - warehouse: `aws_redshift_cluster` (cluster_identifier), `google_bigquery_dataset`
 *   (dataset_id)
 * - cache: `aws_elasticache_replication_group` (replication_group_id) and
 *   `aws_elasticache_cluster` (cluster_id); a cache that a feature store or another extractor
 *   says is more than a cache keeps that more specific type when merged
 *
 * Each is a DataStore with the resource's name as id (as the infra extractor does for
 * databases), no owner and no tables; other extractors that know the same store by that id
 * (dbt for the warehouse, Feast for its online store) add what they see to it.
 */

const KINDS: Record<string, { storeType: string; nameAttr: string }> = {
  aws_s3_bucket: { storeType: "object-storage", nameAttr: "bucket" },
  google_storage_bucket: { storeType: "object-storage", nameAttr: "name" },
  azurerm_storage_container: { storeType: "object-storage", nameAttr: "name" },
  aws_sqs_queue: { storeType: "queue", nameAttr: "name" },
  aws_redshift_cluster: { storeType: "warehouse", nameAttr: "cluster_identifier" },
  google_bigquery_dataset: { storeType: "warehouse", nameAttr: "dataset_id" },
  aws_elasticache_replication_group: { storeType: "cache", nameAttr: "replication_group_id" },
  aws_elasticache_cluster: { storeType: "cache", nameAttr: "cluster_id" },
};

export const cloudStoresExtractor = defineExtractor({
  id: "cloud-stores",
  version: "0.1.0",
  claims: ["**/*.tf"],
  async *scan(repo, ctx) {
    const relevant = new RegExp(`\\b(${Object.keys(KINDS).join("|")})\\b`);
    for (const mod of await loadTerraform(repo, ctx, relevant)) {
      for (const r of mod.resources) {
        const kind = KINDS[r.type];
        if (!kind) continue;
        const name = tfString(mod, attrOf(r.block, kind.nameAttr)) ?? r.name;
        const id = slug(name);
        if (!id) continue;
        yield {
          schemaVersion: 2,
          kind: "DataStore",
          id,
          status: "current",
          confidence: "verified",
          storeType: kind.storeType,
          entitiesHeld: [],
          evidence: [ev(repo, "infrastructure", r.file, r.block.line)],
        } as unknown as CatalogRecord;
      }
    }
  },
});
