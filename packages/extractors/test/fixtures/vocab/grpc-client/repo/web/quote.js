import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const proto = grpc.loadPackageDefinition(protoLoader.loadSync("ledger.proto"));
export const client = new proto.harbor.ledger.v1.LedgerService("ledger:50051", grpc.credentials.createInsecure());
