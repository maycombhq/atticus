/**
 * Records in fixtures/harbor/expected/scan.yaml that need a producer this main doesn't have
 * yet, grouped by the producer. The scan test compares every other record field for field
 * and skips each group (`it.skip`) with the producer's name; when the producer lands, its group
 * is deleted from here and the comparison runs with the rest.
 *
 * Keys are "<kind>/<id>". A record needing two producers sits in the group that lands last.
 * `extraOnMain` lists records today's main makes in their place (to be gone once it lands).
 *
 * The ten ADR 0040 extractors and the Terraform storage one (vocab/ in packages/extractors) have
 * landed, so their groups are gone. What is left has no producer in this tree.
 */
export interface PendingGroup {
  producer: string;
  records: string[];
  extraOnMain?: string[];
}

export const PENDING: Record<string, PendingGroup> = {
  webhooks: {
    producer:
      "webhook interfaces (ADR 0040): a partner spec's webhooks section to the function serving it, via webhook (needs the partner-spec intake to emit the callback as a loose end the merge can join to the function's webhook endpoint)",
    records: ["Interface/if-471a26719fe84220"],
  },
  saas: {
    producer:
      "SaaS vendor systems tagged saas (ADR 0040 System tags convention): the System tags come from the C6 profile, which the merge copies as it is",
    records: ["System/tidewater-payments", "System/lantern-mail"],
  },
  "vendor-hosts": {
    producer:
      "merge resolving a vendor host (api.tidewater.example, api.lanternmail.example) through the profile alias or the partner spec's servers; no lane owns this yet",
    records: [
      "Interface/if-a4ccfcea11eeebf0",
      "Interface/if-018d1416ec04a61a",
      "Interface/if-10465a7b9c85231e",
    ],
  },
  "golang-migrate": {
    producer:
      "migrations extractor reading golang-migrate names (<version>_<name>.up.sql); it knows Flyway's V<n>__ only; no lane owns this yet",
    records: ["Migration/catalog-db.v0001", "Migration/catalog-db.v0002"],
    extraOnMain: [
      "Migration/catalog-db.v0001-create-products.up",
      "Migration/catalog-db.v0002-create-stock-levels.up",
    ],
  },
};

export const pendingKeys = (groups = Object.keys(PENDING)): Set<string> =>
  new Set(groups.flatMap((g) => PENDING[g]!.records));
