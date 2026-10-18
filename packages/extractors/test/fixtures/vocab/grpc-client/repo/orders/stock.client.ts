import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

// The address is not a literal; the gRPC credentials show this is a client.
const definition = loadPackageDefinition(loadSync("proto/stock.proto")) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const stock = new definition.harbor.stock.v1.Stock(process.env.STOCK_ADDR, credentials.createInsecure());

export function check(sku: string) {
  return stock.checkItem({ sku });
}

export function reserve(sku: string) {
  return stock.ReserveItem({ sku });
}

export function done() {
  stock.close();
}
