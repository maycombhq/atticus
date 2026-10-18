import type { Extractor } from "@maycombhq/sdk";
import { appsExtractor } from "./apps.js";
import { dataPipelinesExtractor } from "./data-pipelines.js";
import { graphqlExtractor } from "./graphql.js";
import { grpcExtractor } from "./grpc.js";
import { ingressExtractor } from "./ingress.js";
import { meshExtractor } from "./mesh.js";
import { mlExtractor } from "./ml.js";
import { realtimeExtractor } from "./realtime.js";
import { serverlessExtractor } from "./serverless.js";
import { webhooksExtractor } from "./webhooks.js";

export {
  appsExtractor,
  dataPipelinesExtractor,
  graphqlExtractor,
  grpcExtractor,
  ingressExtractor,
  meshExtractor,
  mlExtractor,
  realtimeExtractor,
  serverlessExtractor,
  webhooksExtractor,
};
export { parseGraphql, type GqlField } from "./graphql.js";
export { parseProto } from "./grpc.js";
export type { VocabLooseEnd } from "./common.js";

/**
 * The extractors that produce the ADR 0040 vocabulary (GraphQL, gRPC, WebSocket/SSE,
 * webhooks, serverless, service mesh, mobile and desktop apps, data pipelines, ML, ingress),
 * in a stable order.
 */
export const VOCAB_EXTRACTORS: readonly Extractor[] = [
  graphqlExtractor,
  grpcExtractor,
  realtimeExtractor,
  webhooksExtractor,
  serverlessExtractor,
  meshExtractor,
  appsExtractor,
  dataPipelinesExtractor,
  mlExtractor,
  ingressExtractor,
];
