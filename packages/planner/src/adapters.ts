import { join } from "node:path";
import {
  createAdapters,
  fileStepStore,
  type AdapterFactories,
  type Adapters,
  type FallbackEvent,
  type ServiceRequest,
  type WorkItem,
} from "@maycombhq/adapters";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { readServiceRequestExports, readWorkItemExports } from "@maycombhq/intake";

/**
 * The metarepo's adapters as runtime.yaml configures them, with manual adapters wired in
 * (ADR 0032): `type: manual` systems write steps into the change folder, and live ones fall
 * back to manual when they can't be reached or lack credentials. Manual reads come from the
 * exports in inputs/, through intake's readers.
 */
export async function metarepoAdapters(
  root: string,
  o: {
    change?: string;
    factories?: AdapterFactories;
    now?: () => string;
    inputsDir?: string;
    onFallback?: (e: FallbackEvent) => void;
  } = {},
): Promise<Adapters> {
  const pack = await loadOrgPack(join(orgPackDirOf(root)));
  const inputs = { root, ...(o.inputsDir ? { inputsDir: o.inputsDir } : {}) };
  const workItems = async (): Promise<WorkItem[]> =>
    (await readWorkItemExports(inputs)).items.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      description: i.description ?? "",
      acceptanceCriteria: "",
      state: i.state ?? "",
      ...(i.parent ? { parent: i.parent } : {}),
      tags: i.tags,
      url: i.url ?? "",
    }));
  const requests = async (): Promise<ServiceRequest[]> =>
    (await readServiceRequestExports(inputs)).requests.map((r) => ({
      id: r.id,
      type: r.type,
      state: r.closed ? "done" : "submitted",
      fields: r.fields,
      ...(r.approvalGroup ? { approvalGroup: r.approvalGroup } : {}),
      ...(r.opened ? { openedAt: r.opened } : {}),
      ...(r.closed ? { closedAt: r.closed } : {}),
      url: "",
    }));
  return createAdapters(pack.runtime, o.factories ?? {}, {
    store: fileStepStore(root),
    root,
    ...(o.change ? { change: o.change } : {}),
    procedures: pack.procedures,
    readers: { workItems, requests },
    ...(o.now ? { now: o.now } : {}),
    ...(o.onFallback ? { onFallback: o.onFallback } : {}),
  });
}
