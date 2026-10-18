import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { componentOf, evidence, looseEnd } from "../facts.js";
import { get, isTestOrBuildPath, pairs, parseYamlDoc, scalar, topicId } from "./common.js";

/**
 * AsyncAPI 2.x and 3.x documents (YAML or JSON) describing the repo's component:
 *   - each channel is an event-topic Endpoint, id topic.<topic> as the topics extractor names it
 *     (the topic is the channel name in 2.x, the channel's address in 3.x);
 *   - each operation is a loose end for the component: event-publish or event-subscribe.
 *
 * Direction. AsyncAPI 3 says it plainly: action "send" publishes, "receive" subscribes.
 * AsyncAPI 2 describes operations from the client's point of view: a channel's `subscribe`
 * operation means other applications can subscribe, so this application publishes there; its
 * `publish` operation means others publish to it, so this application subscribes.
 *
 * The topic's component is the component when it publishes there, else "unknown" (merge fills
 * it from a publisher). Message payloads are not turned into Schema records yet.
 */
export const asyncapiExtractor = defineExtractor({
  id: "asyncapi",
  version: "1.0.0",
  claims: [
    "**/*asyncapi*.yaml",
    "**/*asyncapi*.yml",
    "**/*asyncapi*.json",
    "**/asyncapi/**/*.yaml",
    "**/asyncapi/**/*.yml",
    "**/asyncapi/**/*.json",
  ],
  async *scan(repo, ctx) {
    const owner = componentOf(repo, ctx);
    const topics = new Map<
      string,
      { topic: string; path: string; line: number; publishes: boolean }
    >();
    const loose: CatalogRecord[] = [];
    const seenFiles = new Set<string>();
    for await (const path of repo.listFiles(this.claims)) {
      if (isTestOrBuildPath(path) || seenFiles.has(path)) continue;
      seenFiles.add(path);
      const doc = parseYamlDoc(await repo.readText(path));
      if (!doc) continue;
      const { root, lc } = doc;
      const version = scalar(get(root, "asyncapi", lc)?.value);
      if (!version || !/^[23]\./.test(version)) continue;
      const channels = pairs(get(root, "channels", lc)?.value, lc);
      const addTopic = (topic: string, line: number) => {
        if (!topics.has(topic)) topics.set(topic, { topic, path, line, publishes: false });
      };
      const op = (kind: "event-publish" | "event-subscribe", topic: string, line: number) => {
        if (kind === "event-publish") topics.get(topic)!.publishes = true;
        loose.push(
          looseEnd(repo, ctx, kind, topic, { source: "spec", path, line, side: "definition" }),
        );
      };
      if (version.startsWith("2.")) {
        for (const ch of channels) {
          addTopic(ch.key, ch.line);
          for (const o of pairs(ch.value, lc)) {
            if (o.key === "subscribe") op("event-publish", ch.key, o.line);
            else if (o.key === "publish") op("event-subscribe", ch.key, o.line);
          }
        }
      } else {
        const address = new Map<string, string>();
        for (const ch of channels) {
          const topic = scalar(get(ch.value, "address", lc)?.value) ?? ch.key;
          address.set(ch.key, topic);
          addTopic(topic, ch.line);
        }
        for (const o of pairs(get(root, "operations", lc)?.value, lc)) {
          const action = scalar(get(o.value, "action", lc)?.value);
          const ref = scalar(get(get(o.value, "channel", lc)?.value, "$ref", lc)?.value) ?? "";
          const id = /^#\/channels\/(.+)$/.exec(ref)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");
          const topic = id !== undefined ? address.get(id) : undefined;
          if (!topic) continue;
          if (action === "send") op("event-publish", topic, o.line);
          else if (action === "receive") op("event-subscribe", topic, o.line);
        }
      }
    }
    for (const t of topics.values())
      yield {
        schemaVersion: 1,
        kind: "Endpoint",
        id: topicId(t.topic),
        status: "current",
        confidence: "verified",
        component: t.publishes ? owner : "unknown",
        endpointType: "event-topic",
        pathOrTopic: t.topic,
        schemaRefs: [],
        evidence: [
          evidence(repo, { source: "spec", path: t.path, line: t.line, side: "definition" }),
        ],
      } as unknown as CatalogRecord;
    yield* loose;
  },
});
