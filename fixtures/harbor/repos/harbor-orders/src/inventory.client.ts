import { join } from "node:path";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

// The catalog's Inventory service over gRPC, through the mesh.
const definition = loadPackageDefinition(
  loadSync(join(__dirname, "../proto/harbor/inventory/v1/inventory.proto")),
) as any;
const inventory = new definition.harbor.inventory.v1.Inventory(
  process.env.CATALOG_GRPC_ADDR,
  credentials.createInsecure(),
);

export function checkStock(sku: string, quantity: number): Promise<{ available: boolean }> {
  return new Promise((resolve, reject) =>
    inventory.CheckStock({ sku, quantity }, (err: Error | null, res: { available: boolean }) =>
      err ? reject(err) : resolve(res),
    ),
  );
}
