import type { Extractor } from "@maycombhq/sdk";
import { accessExtractor } from "./access.js";
import { batchExtractor } from "./batch.js";
import { gcpExtractor } from "./gcp.js";
import { openshiftExtractor } from "./openshift.js";
import { pipelinesExtractor } from "./pipelines.js";

export { accessExtractor, batchExtractor, gcpExtractor, openshiftExtractor, pipelinesExtractor };
export { parseHcl, type HclBlock, type HclFile, type HclValue } from "./hcl.js";
export { loadManifests, readYamlDocs, type K8sObject, type YamlDoc } from "./manifests.js";
export { loadTerraform, type TfModule, type TfResource } from "./terraform.js";
export { componentFor, envOf } from "./util.js";

/** The platform extractors (OpenShift, GCP, pipelines, access, batch), in a stable order. */
export const PLATFORM_EXTRACTORS: readonly Extractor[] = [
  openshiftExtractor,
  gcpExtractor,
  pipelinesExtractor,
  accessExtractor,
  batchExtractor,
];
